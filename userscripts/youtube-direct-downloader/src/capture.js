// ---------------------------------------------------------------------------
// capture.js —— 攔截 SourceBuffer 收集 fMP4 分片（MSE 攔截式下載）
//
// YouTube 播放器用 MediaSource + SourceBuffer 播放影片，把解密後的 fMP4
// 分片餵給 SourceBuffer.appendBuffer()。本模組攔截 addSourceBuffer 回傳的
// SourceBuffer，包裝其 appendBuffer 做「旁觀收集」，最後依 mime 分流拼成
// video / audio 兩個 Blob，供後續合併模組使用。
//
// 設計重點：
//   - 不影響原本播放行為：包裝後的 appendBuffer 原樣透傳、只做收集
//   - 掛鉤冪等（重複 start 不重複掛）
//   - 卸鉤可還原（stop 後 appendBuffer 不再被收集）
//   - 可測試：透過 getMediaSource 注入 FakeMediaSource，預設讀 unsafeWindow
// ---------------------------------------------------------------------------

/**
 * 判斷一筆資料是否為 init segment。
 * init segment 的前 4 bytes 為 'ftyp' (0x66 0x74 0x79 0x70)。
 * 接受 Uint8Array / ArrayBuffer / 其他 ArrayBufferView。
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} data
 * @returns {boolean}
 */
export function isInitSegment(data) {
  if (!data) return false;
  let u;
  if (data instanceof Uint8Array) {
    u = data;
  } else if (data instanceof ArrayBuffer) {
    u = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  } else if (ArrayBuffer.isView(data)) {
    u = new Uint8Array(data.buffer, data.byteOffset, Math.min(4, data.byteLength));
  } else {
    return false;
  }
  if (u.length < 4) return false;
  return u[0] === 0x66 && u[1] === 0x74 && u[2] === 0x79 && u[3] === 0x70;
}

/**
 * 把 appendBuffer 的 data 正規化成「擁有自身記憶體」的 Uint8Array。
 * 同時處理 ArrayBuffer 與 ArrayBufferView（含 Uint8Array / DataView 等）。
 * 複製一份，避免播放器回收/複用原 buffer 導致收集到的資料被改變。
 * @param {ArrayBuffer|ArrayBufferView} data
 * @returns {Uint8Array}
 */
export function toUint8Array(data) {
  if (data instanceof ArrayBuffer) {
    // slice(0) 複製出獨立 buffer，避免共享記憶體被播放器改寫
    return new Uint8Array(data.slice(0));
  }
  if (ArrayBuffer.isView(data)) {
    const copied = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    );
    return new Uint8Array(copied);
  }
  throw new TypeError('appendBuffer 的 data 必須是 ArrayBuffer 或 ArrayBufferView');
}

const DEFAULT_GET_MEDIA_SOURCE = () =>
  (typeof unsafeWindow !== 'undefined' ? unsafeWindow.MediaSource : undefined);

/**
 * 建立一個 capture 實例。
 * @param {{ getMediaSource?: () => any }} [opts]
 *   getMediaSource：回傳 MediaSource 建構函式（類別）的來源。
 *     預設讀 unsafeWindow.MediaSource；測試時可傳入 FakeMediaSource。
 *     若當下尚未出現 MediaSource，start() 會輪詢直到出現再掛鉤。
 * @returns {{ start: () => void, stop: () => object, getResult: () => object }}
 */
export function createCapture(opts = {}) {
  const getMediaSource = opts.getMediaSource || DEFAULT_GET_MEDIA_SOURCE;

  // 每個 track 結構：{ mime, chunks: Uint8Array[] }
  // chunks 中 init segment 必須在最前面（見 addChunk）。
  const tracks = {
    video: null,
    audio: null,
  };

  let hooked = false;
  let origAddSourceBuffer = null;
  let pollTimer = null;

  function ensureTrack(key, mime) {
    if (!tracks[key]) tracks[key] = { mime, chunks: [] };
    return tracks[key];
  }

  // 把一筆 append 資料加入 track，並保證 init segment 在最前面。
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

  function wrapSourceBuffer(sb, mime) {
    let key = null;
    if (mime.includes('video')) key = 'video';
    else if (mime.includes('audio')) key = 'audio';
    else return; // 其他 mime（如 text/vtt）不攔截、不收集

    const track = ensureTrack(key, mime);
    const origAppend = sb.appendBuffer;

    // 包裝 appendBuffer：原樣透傳（不影響播放），只做旁觀收集。
    sb.appendBuffer = function (data) {
      const result = origAppend.call(this, data); // 原樣透傳
      addChunk(track, data);                      // 旁觀收集
      return result;
    };
  }

  function installHook(MS) {
    if (hooked) return;
    origAddSourceBuffer = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function (mime) {
      const sb = origAddSourceBuffer.call(this, mime);
      wrapSourceBuffer(sb, mime);
      return sb;
    };
    hooked = true;
  }

  function start() {
    if (hooked) return; // 冪等：已掛鉤則 no-op
    const MS = getMediaSource();
    if (MS) {
      installHook(MS);
      return;
    }
    // MediaSource 尚未出現：輪詢直到出現再掛鉤。
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      const m = getMediaSource();
      if (m) {
        installHook(m);
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 50);
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
      videoBytes: tracks.video
        ? tracks.video.chunks.reduce((s, c) => s + c.length, 0)
        : 0,
      audioBytes: tracks.audio
        ? tracks.audio.chunks.reduce((s, c) => s + c.length, 0)
        : 0,
    };
    return { video, audio, meta };
  }

  function stop() {
    // 卸鉤：還原 addSourceBuffer
    if (hooked && origAddSourceBuffer) {
      const MS = getMediaSource();
      if (MS) MS.prototype.addSourceBuffer = origAddSourceBuffer;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    hooked = false;
    origAddSourceBuffer = null;
    return buildResult();
  }

  function getResult() {
    // 不卸鉤，立即回傳當前收集（供進度顯示）。
    return buildResult();
  }

  return { start, stop, getResult };
}
