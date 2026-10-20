// ---------------------------------------------------------------------------
// capture.js —— 攔截 SourceBuffer 收集 fMP4 分片（MSE 攔截式下載）
//
// YouTube 播放器用 MediaSource + SourceBuffer 播放影片，把解密後的 fMP4
// 分片餵給 SourceBuffer.appendBuffer()。本模組攔截 appendBuffer 做「旁觀收集」，
// 最後依 mime 分流拼成 video / audio 兩個 Blob，供後續合併模組使用。
//
// 設計重點：
//   - 直接 hook `SourceBuffer.prototype.appendBuffer`（全域），而不是只透過
//     addSourceBuffer 拿實例再包裝。原因：播放器可能在任何時刻建立 SourceBuffer，
//     若只 hook addSourceBuffer，已存在的 SourceBuffer 就不會被攔到（下載器在
//     使用者點按鈕時才 start，此時影片通常已在播放、SourceBuffer 早已建立）。
//     全域 hook appendBuffer 則無論 SourceBuffer 何時建立都會攔到。
//   - 用 WeakMap 記錄「SourceBuffer 實例 → mime」，在 addSourceBuffer 時寫入，
//     appendBuffer 時查詢以分流 video/audio。
//   - recording 開關：只有 recording 為 true 時才真正收集，避免常駐 hook 一路
//     累積記憶體。
//   - 不影響原本播放行為：包裝後的 appendBuffer 原樣透傳。
// ---------------------------------------------------------------------------

/**
 * 判斷一筆資料是否為 init segment。
 * 兩種容器的 init 特徵不同（MSE 中 video 走 mp4/fMP4，audio 常走 webm）：
 *   - mp4/fMP4：box 格式 [4B size][4B 'ftyp'][...]，'ftyp' 位於 offset 4–7
 *   - webm/EBML：EBML header 以 magic number 0x1A 0x45 0xDF 0xA3 開頭（offset 0–3）
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} data
 * @returns {boolean}
 */
export function isInitSegment(data) {
  if (!data) return false;
  let u;
  if (data instanceof Uint8Array) {
    u = data;
  } else if (data instanceof ArrayBuffer) {
    u = new Uint8Array(data, 0, Math.min(8, data.byteLength));
  } else if (ArrayBuffer.isView(data)) {
    u = new Uint8Array(data.buffer, data.byteOffset, Math.min(8, data.byteLength));
  } else {
    return false;
  }
  if (u.length < 4) return false;
  // mp4/fMP4：offset 4–7 = 'ftyp'
  const isMp4 = u.length >= 8 &&
    u[4] === 0x66 && u[5] === 0x74 && u[6] === 0x79 && u[7] === 0x70;
  // webm/EBML：offset 0–3 = 0x1A 0x45 0xDF 0xA3
  const isWebm = u[0] === 0x1A && u[1] === 0x45 && u[2] === 0xDF && u[3] === 0xA3;
  return isMp4 || isWebm;
}

/**
 * 把 appendBuffer 的 data 正規化成「擁有自身記憶體」的 Uint8Array。
 * 複製一份，避免播放器回收/複用原 buffer 導致收集到的資料被改變。
 */
export function toUint8Array(data) {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  if (ArrayBuffer.isView(data)) {
    const copied = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return new Uint8Array(copied);
  }
  throw new TypeError('appendBuffer 的 data 必須是 ArrayBuffer 或 ArrayBufferView');
}

/**
 * 從 fMP4 init segment 判斷 track 類型（video/audio）。
 * 解析 ftyp 後的 box 結構，找 moov→trak→mdia→hdlr 的 handler_type：
 *   'vide' → video；'soun' → audio。
 * 這是「已存在的 SourceBuffer 拿不到 mime」時的兜底判斷（見 capture 說明）。
 * @param {Uint8Array} bytes
 * @returns {'video'|'audio'|null}
 */
export function detectTrackKind(bytes) {
  if (!bytes || bytes.length < 8) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  // 跳過 ftyp box（第一個 box）
  let size = dv.getUint32(offset);
  if (size === 1) size = Number(dv.getBigUint64(offset + 8)); // 64-bit size
  if (size < 8 || offset + size > bytes.length) return null;
  offset += size;

  // 遍歷後續 box，找 moov
  while (offset + 8 <= bytes.length) {
    size = dv.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (size === 1) size = Number(dv.getBigUint64(offset + 8));
    if (size < 8 || offset + size > bytes.length) break;

    if (type === 'moov') {
      // 在 moov 內找 trak→mdia→hdlr
      return findHandlerInMoov(bytes, offset, size);
    }
    offset += size;
  }
  return null;
}

function findHandlerInMoov(bytes, moovStart, moovSize) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = moovStart + moovSize;
  let offset = moovStart + 8; // 跳過 moov box header
  const stack = [];

  // 遞迴掃描 moov 內的所有 box，找 hdlr 的 handler_type
  function scan(start, limit) {
    let off = start;
    while (off + 8 <= limit) {
      const size = dv.getUint32(off);
      const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
      if (size < 8 || off + size > limit) break;

      if (type === 'hdlr') {
        // hdlr: [fullbox header 4B][pre_defined 4B] handler_type 在 offset+16
        if (off + 20 <= limit) {
          const handler = String.fromCharCode(bytes[off + 16], bytes[off + 17], bytes[off + 18], bytes[off + 19]);
          if (handler === 'vide') return 'video';
          if (handler === 'soun') return 'audio';
        }
      } else if (type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl') {
        // 容器 box：遞迴進入
        const found = scan(off + 8, off + size);
        if (found) return found;
      }
      off += size;
    }
    return null;
  }

  return scan(offset, end);
}

const DEFAULT_GET_MEDIA_SOURCE = () =>
  (typeof unsafeWindow !== 'undefined' ? unsafeWindow.MediaSource : undefined);
const DEFAULT_GET_SOURCE_BUFFER = () =>
  (typeof unsafeWindow !== 'undefined' ? unsafeWindow.SourceBuffer : undefined);

/**
 * 建立一個 capture 實例。
 * @param {{ getMediaSource?: () => any, getSourceBuffer?: () => any }} [opts]
 * @returns {{ start, stop, getResult }}
 */
export function createCapture(opts = {}) {
  const getMediaSource = opts.getMediaSource || DEFAULT_GET_MEDIA_SOURCE;
  const getSourceBuffer = opts.getSourceBuffer || DEFAULT_GET_SOURCE_BUFFER;

  // 每個 track 結構：{ mime, chunks: Uint8Array[] }
  const tracks = { video: null, audio: null };
  // SourceBuffer 實例 → mime 的映射（addSourceBuffer 時寫入）
  const mimeByBuffer = new WeakMap();

  let recording = false;
  let hookedAdd = false;
  let hookedAppend = false;
  let origAddSourceBuffer = null;
  let origAppendBuffer = null;
  let pollTimer = null;

  // 診斷計數（暫時，用於定位「攔不到分片」）
  let appendSeen = 0;      // appendBuffer 被呼叫的總次數（含未收集的）
  let appendCollected = 0; // 實際被收集的次數
  let addBufferSeen = 0;   // addSourceBuffer 被呼叫的次數

  function ensureTrack(key, mime) {
    if (!tracks[key]) tracks[key] = { mime, chunks: [] };
    else if (tracks[key].mime !== mime) tracks[key].mime = mime;
    return tracks[key];
  }

  function addChunk(track, data) {
    const bytes = toUint8Array(data);
    if (isInitSegment(bytes)) {
      // init segment 必須置前；若已有 init 則取代（避免重複）。
      if (track.chunks.length > 0 && isInitSegment(track.chunks[0])) {
        track.chunks[0] = bytes;
      } else {
        track.chunks.unshift(bytes);
      }
    } else {
      track.chunks.push(bytes);
    }
  }

  function mimeToKey(mime) {
    if (mime.includes('video')) return 'video';
    if (mime.includes('audio')) return 'audio';
    return null;
  }

  function installHooks() {
    // 1. hook addSourceBuffer：記錄 mime
    const MS = getMediaSource();
    if (MS && MS.prototype && !hookedAdd) {
      origAddSourceBuffer = MS.prototype.addSourceBuffer;
      MS.prototype.addSourceBuffer = function (mime) {
        addBufferSeen++;
        const sb = origAddSourceBuffer.call(this, mime);
        try { mimeByBuffer.set(sb, mime); } catch { /* 非物件則略過 */ }
        console.log(`[YT-DL] capture: addSourceBuffer "${mime}" (共 ${addBufferSeen} 次)`);
        return sb;
      };
      hookedAdd = true;
      console.log('[YT-DL] capture: 已 hook MediaSource.addSourceBuffer');
    } else if (!MS) {
      // MediaSource 尚未出現
      console.log('[YT-DL] capture: MediaSource 尚未出現，等待中…');
    }

    // 2. hook appendBuffer（全域）：攔所有 SourceBuffer 的 append
    const SB = getSourceBuffer();
    if (SB && SB.prototype && !hookedAppend) {
      origAppendBuffer = SB.prototype.appendBuffer;
      SB.prototype.appendBuffer = function (data) {
        appendSeen++;
        const result = origAppendBuffer.call(this, data); // 原樣透傳，不影響播放
        if (recording) {
          collect(this, data);
        }
        if (appendSeen <= 3 || appendSeen % 50 === 0) {
          console.log(`[YT-DL] capture: appendBuffer #${appendSeen} len=${data?.byteLength ?? data?.length} recording=${recording} 收集=${appendCollected}`);
        }
        return result;
      };
      hookedAppend = true;
      console.log('[YT-DL] capture: 已 hook SourceBuffer.appendBuffer');
    } else if (!SB) {
      console.log('[YT-DL] capture: SourceBuffer 尚未出現，等待中…');
    }
  }

  // 收集一筆 append 資料。mime 來源優先序：
  //   1. WeakMap（addSourceBuffer 時記錄，最準）
  //   2. detectTrackKind（解析 init segment 的 hdlr，兜底「已存在的 SourceBuffer」）
  // 判斷出 mime 後，若來源是 detectTrackKind，回寫 WeakMap 供後續 media segment 使用。
  function collect(sb, data) {
    let mime = mimeByBuffer.get(sb);
    if (!mime) {
      // 已存在的 SourceBuffer（hook 前建立）拿不到 mime，改用內容判斷。
      const bytes = toUint8Array(data);
      if (!isInitSegment(bytes)) {
        console.log(`[YT-DL] capture: 非 init 且無 mime，略過 (len=${bytes.length})`);
        return; // 非 init 且無 mime，無法判斷，略過
      }
      const kind = detectTrackKind(bytes);
      if (!kind) {
        console.log('[YT-DL] capture: init 但 detectTrackKind 無法判斷，略過');
        return;
      }
      // 用推斷出的 mime 佔位（格式僅供 Blob type 使用，實際是 video 或 audio）
      mime = kind === 'video' ? 'video/mp4' : 'audio/webm';
      mimeByBuffer.set(sb, mime);
      console.log(`[YT-DL] capture: detectTrackKind 判斷為 ${kind}（已存在的 SourceBuffer 兜底）`);
    }
    const key = mimeToKey(mime);
    if (!key) {
      console.log(`[YT-DL] capture: mime "${mime}" 無法分類，略過`);
      return;
    }
    appendCollected++;
    addChunk(ensureTrack(key, mime), data);
  }

  function start() {
    // 重新開始收集。**保留 init segment**（moov）：YouTube 播放器在 seek 回 0 時
    // 不會重新 append init（SourceBuffer 已含 init），只 append media segments。
    // 若清空 init，拼出的 Blob 只有 moof 沒有 moov，mediabunny 會拋
    // 「moof box encountered with no moov box」而無法解析。
    for (const key of ['video', 'audio']) {
      const track = tracks[key];
      if (track && track.chunks.length > 0 && isInitSegment(track.chunks[0])) {
        // 保留 init（chunks[0]），丟棄其餘 media segments。
        track.chunks = [track.chunks[0]];
      } else {
        tracks[key] = null;
      }
    }
    recording = true;
    installHooks();
    // 若 MediaSource / SourceBuffer 尚未出現，輪詢直到出現再掛鉤。
    if ((!hookedAdd || !hookedAppend) && !pollTimer) {
      pollTimer = setInterval(() => {
        installHooks();
        if (hookedAdd && hookedAppend) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }, 50);
    }
  }

  function finalizeTrack(track) {
    if (!track || track.chunks.length === 0) return null;
    return new Blob(track.chunks, { type: track.mime });
  }

  function buildResult() {
    const video = finalizeTrack(tracks.video);
    const audio = finalizeTrack(tracks.audio);
    const meta = {
      videoMime: tracks.video ? tracks.video.mime : null,
      audioMime: tracks.audio ? tracks.audio.mime : null,
      videoBytes: tracks.video ? tracks.video.chunks.reduce((s, c) => s + c.length, 0) : 0,
      audioBytes: tracks.audio ? tracks.audio.chunks.reduce((s, c) => s + c.length, 0) : 0,
    };
    return { video, audio, meta };
  }

  function stop() {
    recording = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    // 不卸鉤：hook 常駐，讓後續下載（換片重下）仍能攔到。
    // 資料保留，供 stop 後 getResult 讀取；下次 start 時才清空。
    return buildResult();
  }

  function getResult() {
    return buildResult();
  }

  return { start, stop, getResult };
}
