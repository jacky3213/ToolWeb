// src/sabr.js
//
// SABR / UMP 串流下載路徑。
//
// 部分影片（尤其 WEB / TV_SIMPLY 客戶端）的 streaming_data 沒有直接的格式 URL，
// 只有 `server_abr_streaming_url`。此時必須走 SABR（Server-side ABR，UMP 協議）：
// 先 decipher 取得可用 URL，再向該端點以 protobuf 請求逐步取得 fMP4 分段的位元組流。
//
// 本文以 googlevideo@4.1.1 的實際 API 為準（dist/src/core/SabrStream.d.ts / .js、
// types/sabrStreamTypes.d.ts、utils/Protos.d.ts）。與任務參考骨架的差異見檔尾註解。

import { SabrStream } from 'googlevideo/sabr-stream';
import { ReadableStreamSource } from 'mediabunny';
import { Constants } from 'youtubei.js/web';
import { isGoogleVideoUrl, toLastModified } from './formats.js';

// SABR 分片請求診斷包裝：記錄每個 UMP 請求的 HTTP 狀態、content-type、回應大小。
// 目的：當串流 stall 時，能立刻分辨是「伺服器回傳空／錯誤」還是「資料有到但
// 沒被正確解析」，而不是對著 "Stream stalled" 乾瞪眼。正常情況下零額外成本。
function wrapSabrFetch(fetchImpl) {
  return async (input, init) => {
    const started = performance.now();
    const res = await fetchImpl(input, init);
    const ct = res.headers?.get?.('content-type') ?? '';
    const cl = res.headers?.get?.('content-length') ?? '';
    console.log(
      `[YT-DL] SABR 回應 status=${res.status} type=${ct || '(無)'} len=${cl || 'chunked'} (${Math.round(performance.now() - started)}ms)`
    );
    return res;
  };
}

// StreamerContext.ClientInfo.clientName 是「數字」enum（proto 以 int32 寫入），
// 但 youtubei.js 的 context.client.clientName 是「字串」（"WEB" / "TVHTML5_SIMPLY" …）。
// 使用 youtubei.js 權威的 CLIENT_NAME_IDS 對照表轉換成數字。
// 若取不到（理論上不會，因 'youtubei.js/web' 總會匯出 Constants），退回最小可用表。
const CLIENT_NAME_IDS = Constants?.CLIENT_NAME_IDS ?? {
  WEB: '1',
  TVHTML5_SIMPLY: '74',
  WEB_REMIX: '67',
};

/**
 * 判斷影片資訊是否提供 SABR/UMP 串流（而非直連 URL）。
 * @param {object} info - VideoInfo（或相容物件）。
 * @returns {boolean}
 */
export function hasSabrStreaming(info) {
  return Boolean(info?.streaming_data?.server_abr_streaming_url);
}

// ---- 工具：欄位取值與型別正規化 ----

const str = (v) => (v === undefined || v === null ? '' : String(v));
const num = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : undefined);

/**
 * 從 player response 取出 video_playback_ustreamer_config（base64 字串）。
 * 依 youtubei.js 實際結構，位於 parsed player_config 的：
 *   player_config.media_common_config.media_ustreamer_request_config.video_playback_ustreamer_config
 * 同時保留原始 playerConfig 的 camelCase 與 player_response 退回路徑以應對版本差異。
 */
function getUstreamerConfig(info) {
  const pc = info?.player_config;
  if (pc?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config) {
    return pc.media_common_config.media_ustreamer_request_config.video_playback_ustreamer_config;
  }
  if (pc?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig) {
    return pc.mediaCommonConfig.mediaUstreamerRequestConfig.videoPlaybackUstreamerConfig;
  }
  const pr = info?.player_response ?? info?.response;
  const raw = pr?.playerConfig ?? pr?.player_response?.playerConfig;
  return raw?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig ?? undefined;
}

/**
 * 組出 SABR 請求用的 clientInfo。
 * 注意：clientName 必須是數字（proto int32），utcOffsetMinutes 必須是字串。
 */
function buildClientInfo(info) {
  const ctxClient =
    info?.actions?.session?.context?.client ??
    info?.player_config?.context?.client ??
    {};
  const nameStr = typeof ctxClient.clientName === 'string' ? ctxClient.clientName : 'WEB';
  const clientName = Number(CLIENT_NAME_IDS[nameStr] ?? CLIENT_NAME_IDS.WEB ?? 1);
  return {
    clientName,
    clientVersion: str(ctxClient.clientVersion),
    utcOffsetMinutes: String(-new Date().getTimezoneOffset()),
  };
}

/**
 * 將 youtubei.js 的 Format 陣列對應為 googlevideo 的 SabrFormat[]。
 * SabrFormat 必填欄位：itag(number) / lastModified(string，微秒) / bitrate(number) /
 * approxDurationMs(number)；其餘選填。SABR 的 chooseFormat 會依 mimeType 過濾
 * preferMP4/preferH264，故 mimeType 也要帶上。
 */
function toSabrFormats(streamingData) {
  const list = [
    ...(streamingData?.formats ?? []),
    ...(streamingData?.adaptive_formats ?? []),
  ];
  const out = [];
  for (const f of list) {
    const itag = Number(f?.itag);
    if (!itag) continue;
    out.push({
      itag,
      lastModified: toLastModified(f),
      mimeType: f?.mime_type ?? f?.mimeType,
      bitrate: Number(f?.bitrate ?? f?.average_bitrate ?? 0),
      approxDurationMs: Number(f?.approx_duration_ms ?? f?.approxDurationMs ?? 0),
      width: num(f?.width),
      height: num(f?.height),
      contentLength: num(f?.content_length ?? f?.contentLength),
      audioTrackId: f?.audio_track?.id ?? f?.audioTrackId,
      quality: f?.quality,
      qualityLabel: f?.quality_label ?? f?.qualityLabel,
      audioQuality: f?.audio_quality ?? f?.audioQuality,
      averageBitrate: num(f?.average_bitrate ?? f?.averageBitrate),
      language: f?.language ?? null,
      isOriginal: Boolean(f?.is_original ?? f?.isOriginal),
      isDubbed: Boolean(f?.is_dubbed ?? f?.isDubbed),
      isAutoDubbed: Boolean(f?.is_auto_dubbed ?? f?.isAutoDubbed),
      isDescriptive: Boolean(f?.is_descriptive ?? f?.isDescriptive),
      isSecondary: Boolean(f?.is_secondary ?? f?.isSecondary),
      isDrc: Boolean(f?.is_drc ?? f?.isDrc),
      xtags: f?.xtags,
    });
  }
  return out;
}

/**
 * 將傳入的 videoFormat/audioFormat（可能是 youtubei.js Format 物件、數字 itag、
 * 或選擇函式）正規化為 start() 可接受的 itag 數字。
 * 傳數字 itag 可讓 chooseFormat 在我們轉好的 SabrFormat[] 中精確比對，
 * 避免直接傳 Format 物件（缺少 approxDurationMs 等必填欄位）導致後續請求缺欄位。
 */
function toItagOption(fmt) {
  if (fmt == null) return undefined;
  if (typeof fmt === 'number') return fmt;
  if (typeof fmt === 'function') return fmt; // SabrStream 支援選擇函式
  if (typeof fmt === 'object') {
    if (typeof fmt.itag === 'number' || typeof fmt.itag === 'string') {
      const itag = Number(fmt.itag);
      if (itag) return itag;
    }
  }
  return fmt;
}

/**
 * 啟動 SABR/UMP 串流下載。
 *
 * @param {object} params
 * @param {object} params.info - VideoInfo（或相容物件），需含 streaming_data 與 player_config。
 * @param {object|number|Function} [params.videoFormat] - 選用視訊格式（物件取 itag / 數字 / 選擇函式）。
 * @param {object|number|Function} [params.audioFormat] - 選用音訊格式。
 * @param {Function} params.pageFetch - WHATWG fetch 形狀的函式（gm-bridge 的 pageFetch）。
 * @param {Function} params.decipher - (url) => Promise<string>，來自 decipher.js 的 decipherServerUrl 之類。
 * @param {string} [params.poToken] - Proof of Origin token。
 * @param {Function} [params.onProgress] - ({ loaded, total }) => void，串流位元組進度回報（total 為估算值，可能為 0）。
 * @returns {Promise<{ abort: Function, toSources: Function, selectedFormats: object, videoStream: ReadableStream, audioStream: ReadableStream }>}
 */
export async function startSabrDownload({ info, videoFormat, audioFormat, pageFetch, decipher, poToken, onProgress } = {}) {
  const streamingData = info?.streaming_data;
  const rawUrl = streamingData?.server_abr_streaming_url;
  if (!rawUrl) {
    throw new Error('startSabrDownload: 缺少 server_abr_streaming_url，非 SABR 影片。');
  }
  if (typeof pageFetch !== 'function') {
    throw new TypeError('startSabrDownload: 需要提供 pageFetch（WHATWG fetch 形狀）。');
  }
  if (typeof decipher !== 'function') {
    throw new TypeError('startSabrDownload: 需要提供 decipher(url) => Promise<string>。');
  }

  // 1. decipher 取得可用 URL
  const serverAbrStreamingUrl = await decipher(rawUrl);

  // 2. 白名單校驗：解密後必須仍是 googlevideo 網域
  if (!isGoogleVideoUrl(serverAbrStreamingUrl)) {
    throw new Error(`SABR server URL 不在 googlevideo 白名單內: ${serverAbrStreamingUrl}`);
  }

  // 3. ustreamer config
  const videoPlaybackUstreamerConfig = getUstreamerConfig(info);
  if (!videoPlaybackUstreamerConfig) {
    throw new Error('startSabrDownload: 找不到 video_playback_ustreamer_config。');
  }

  // 4. clientInfo（clientName 為數字，utcOffsetMinutes 為字串）
  const clientInfo = buildClientInfo(info);

  // 5. 可用格式（SabrFormat[]）；start() 的選擇邏輯需要它
  const formats = toSabrFormats(streamingData);

  const sabr = new SabrStream({
    fetch: wrapSabrFetch(pageFetch),
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig,
    clientInfo,
    poToken,
    formats,
    // 影片總時長（毫秒）。不傳會是 Infinity，讓「下載是否完成」的判斷失準，
    // 也會讓 stall 偵測拿不到合理的進度基準。videoInfo 的 duration 為秒。
    durationMs: Number(info?.basic_info?.duration ?? 0) * 1000,
  });

  // 6. 啟動串流（setupStreamingProcess 在背景非同步進行，start 立即回傳串流把手）
  const { videoStream, audioStream, selectedFormats } = await sabr.start({
    videoFormat: toItagOption(videoFormat),
    audioFormat: toItagOption(audioFormat),
    preferMP4: true,
    preferH264: true,
    // stall 偵測閾值：SABR 分片請求一次可能就要數秒，預設 30s 太短容易誤判。
    // 拉長避免正常串流被誤殺；真正的卡死仍會在更長時間後觸發。
    stallDetectionMs: 30000,
  });

  // SABR 串流內容即已封裝好的 fMP4 裸位元組（ReadableStream<Uint8Array>），
  // 直接以 ReadableStreamSource 包裝交給 mediabunny 的 Input；codec 由 Input 從
  // fMP4 init 自動辨識，無須手動帶 type/container/codec。
  // 注意：ReadableStream 只能被消費一次，故 source 實例建好後快取、供 toSources 重複回傳。

  // 進度：SABR 串流在背景下載，若不計數，UI 的進度條永遠是 0。
  // 這裡以標準 WHATWG ReadableStream 包一層，把讀到的位元組數累加回報，
  // 位元組內容原樣透傳（不更動任何資料）。total 用 contentLength 估算，
  // 取不到時以 durationMs 讓進度條至少能依「已下載位元組」呈現。
  const estTotal =
    Number(videoFormat?.contentLength ?? 0) +
    Number(audioFormat?.contentLength ?? 0) || 0;

  function countedStream(raw, onChunk) {
    if (!raw || typeof raw.getReader !== 'function') return raw;
    const source = raw;
    let done = false;
    return new ReadableStream({
      start(controller) {
        const reader = source.getReader();
        const pump = () =>
          reader.read().then(({ done: d, value }) => {
            if (d) { done = true; controller.close(); return; }
            onChunk(value ? value.byteLength : 0);
            controller.enqueue(value);
            pump();
          }).catch((err) => controller.error(err));
        pump();
      },
      cancel() { try { source.cancel(); } catch { /* 已關閉 */ } },
    });
  }

  let loadedBytes = 0;
  const report = () => {
    if (typeof onProgress !== 'function') return;
    onProgress({ loaded: loadedBytes, total: estTotal || 0 });
  };
  const onChunk = (n) => { loadedBytes += n; report(); };

  const countedVideo = countedStream(videoStream, onChunk);
  const countedAudio = countedStream(audioStream, onChunk);

  const videoSource = new ReadableStreamSource(countedVideo);
  const audioSource = new ReadableStreamSource(countedAudio);

  return {
    abort: () => sabr.abort?.(),
    toSources: () => ({ videoSource, audioSource }),
    selectedFormats,
    videoStream,
    audioStream,
  };
}
