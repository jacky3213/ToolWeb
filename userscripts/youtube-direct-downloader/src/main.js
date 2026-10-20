// src/main.js
//
// 總裝配：安裝評估環境 → 攔截頁面請求 → 取得影片資訊與畫質清單 → 下載佇列 →
// 直連 / SABR 雙路徑合併寫盤。
//
// 注意：本檔案運行於 Tampermonkey 沙箱，依賴 unsafeWindow / GM_* 等全域，
// 這些僅在瀏覽器運行期存在；node 靜態檢查時不會執行到取用處。

import { installEvalEnvironment, setClientProvider, decipherFormat, decipherServerUrl } from './decipher.js';
import { getYouTubeClient, loadVideoInfo } from './yt-client.js';
import { createDownloadTask } from './downloader.js';
import { muxBlobs, muxSources, streamTargetFor, blobTarget } from './muxer.js';
import { openOutput, saveBlobAs } from './fs-writer.js';
import { hasSabrStreaming, startSabrDownload } from './sabr.js';
import { isGoogleVideoUrl, stripRangeParams, buildQualityList, pickAudioTrack } from './formats.js';
import { gmFetch, pageFetch, mediaFetch } from './gm-bridge.js';
import { getSetting, setSetting } from './settings.js';
import { createUI } from './ui.js';

// 1. 必須最先執行：替換 youtubei.js 的 eval 環境（在 Innertube.create 之前）
installEvalEnvironment();

// 2. 客戶端提供者：當 info 自身取不到 player 時，回退到 Innertube session 的 player
setClientProvider(() => ensureClient().then((c) => c?.session?.player ?? null));

// ---------- 全域狀態 ----------
const state = {
  videoId: null,
  info: null,
  qualities: [],
  languages: [],
  audioFormats: [],
  poToken: null,
  settingsLanguage: 'auto',
};

let clientPromise = null;
function ensureClient() {
  if (!clientPromise) {
    clientPromise = getYouTubeClient(gmFetch, { cookie: getSetting('cookie', '') })
      .then((session) => {
        // poToken 取自 Innertube session（供 SABR 使用）
        state.poToken = session?.session?.po_token ?? null;
        return session;
      })
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

// ---------- 頁面攔截 ----------
const pageCapture = { playerResponse: null };
const capturedVideoplayback = new Map(); // 經 stripRangeParams 後的 googlevideo URL -> 擷取時間

function installFetchOverride() {
  if (typeof unsafeWindow === 'undefined' || typeof unsafeWindow.fetch !== 'function') return;
  const orig = unsafeWindow.fetch.bind(unsafeWindow);
  unsafeWindow.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    return orig(input, init).then(async (res) => {
      try {
        if (isGoogleVideoUrl(url)) {
          capturedVideoplayback.set(stripRangeParams(url), Date.now());
        }
        if (url.includes('/youtubei/v1/player')) {
          // 複製回應以讀取 JSON，不影響頁面/其他讀取方對原回應的消費
          const cloned = res.clone();
          cloned.json().then((data) => {
            if (data) pageCapture.playerResponse = data;
          }).catch(() => {});
        }
      } catch { /* 攔截不得干擾原請求 */ }
      return res;
    });
  };
}

// ---------- 影片 id / 檔名 ----------
function parseVideoId() {
  const path = location.pathname;
  const seg = path.split('/').filter(Boolean);
  // /watch/v=... 或 /shorts/ID 或 /live/ID
  if (seg.length >= 2) {
    const kind = seg[0];
    if (['watch', 'shorts', 'live', 'embed'].includes(kind)) {
      const id = seg[1];
      if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    }
  }
  const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(location.search);
  if (m) return m[1];
  return null;
}

function sanitizeFilename(name) {
  const cleaned = String(name).replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 120);
  return cleaned || 'video';
}

function videoTitle() {
  // 查證：youtubei.js VideoInfo 的標題位於 basic_info.title（MediaInfo.d.ts:45）。
  // info.video_details 並非 VideoInfo 實例屬性（僅在原始 player response 上），
  // 故回退直接取 videoId。
  const info = state.info;
  const t = info?.basic_info?.title ?? info?.video_details?.title ?? null;
  return sanitizeFilename(t ?? state.videoId ?? 'video');
}

// ---------- 刷新畫質清單 ----------
async function refreshFormats() {
  if (!state.videoId) {
    ui.setError('尚未偵測到影片，請在影片頁面操作。');
    return;
  }
  ui.setStatus('正在取得格式…');
  ui.setError(null);
  try {
    await ensureClient();
    const { source, info } = await loadVideoInfo(state.videoId, gmFetch, pageCapture.playerResponse);
    state.info = info;

    const sd = info?.streaming_data ?? {};
    const formats = [...(sd.formats ?? []), ...(sd.adaptive_formats ?? [])];
    const audioFormats = formats.filter((f) => f.has_audio && !f.has_video);
    state.audioFormats = audioFormats;

    const qualities = buildQualityList(formats, { audioLanguage: navigator.language });
    state.qualities = qualities;

    const languages = [];
    for (const f of audioFormats) {
      if (f.language && !languages.includes(f.language)) languages.push(f.language);
    }
    state.languages = languages;

    ui.renderQualities(qualities, languages);
    ui.setStatus(`格式已取得（來源：${source}）`);
  } catch (err) {
    console.error('[YT-DL] 取得格式失敗', err);
    ui.setError(err);
    ui.setStatus('取得格式失敗');
  }
}

// ---------- 下載執行 ----------
let currentTask = null; // { controls }

// 合併進度回報：多分片 / 多串流累加
function makeProgressAggregator(onProgress) {
  const counters = [];
  return {
    add() {
      const c = { loaded: 0, total: 0 };
      counters.push(c);
      return (loaded, total) => {
        c.loaded = loaded;
        if (total) c.total = total;
        let l = 0, t = 0;
        for (const x of counters) { l += x.loaded; t += x.total; }
        onProgress({ loaded: l, total: t });
      };
    },
  };
}

// 路徑 A：直連 URL（format 有 url / cipher / signature_cipher）
async function runDirectDownload({ quality, container, target, concurrency, controls, onProgress }) {
  const videoFormat = quality.videoFormat;
  const audioFormat = quality.audioFormat;

  // 依選定語言重新挑選音軌（auto 時沿用 quality 已選定的 audioFormat）
  let audio = audioFormat;
  const lang = state.settingsLanguage;
  if (lang && lang !== 'auto' && !quality.isProgressive) {
    const picked = pickAudioTrack(state.audioFormats, lang);
    if (picked) audio = picked;
  }

  const streams = [];
  streams.push({ format: videoFormat, isAudio: false });
  if (audio) streams.push({ format: audio, isAudio: true });

  const agg = makeProgressAggregator(onProgress);
  const tasks = [];
  const started = [];

  for (const s of streams) {
    const url = await decipherFormat(state.info, s.format);
    const total = Number(s.format.content_length) || 0;
    const report = agg.add();

    if (total > 0) {
      const task = createDownloadTask({
        url,
        totalSize: total,
        fetchImpl: mediaFetch,
        concurrency,
        onProgress: ({ loaded, total: t }) => report(loaded, t),
      });
      tasks.push(task);
      started.push(task.start());
    } else {
      // 無 content_length：整段以單次請求下載（不切分片，無法續傳）
      const res = await mediaFetch(url);
      const buf = new Uint8Array(await res.arrayBuffer());
      report(buf.length, buf.length);
      const fake = {
        start: async () => ({ buffer: buf, blob: () => new Blob([buf]) }),
        pause() {}, resume() {}, cancel() {},
      };
      tasks.push(fake);
      started.push(fake.start());
    }
  }
  controls.tasks = tasks;

  const results = await Promise.all(started);
  const videoBlob = results[0].blob();
  const audioBlob = audio ? results[1].blob() : null;

  if (target.kind === 'fs') {
    await muxBlobs({ videoBlob, audioBlob, container, target: streamTargetFor(target.writable) });
  } else {
    const bt = blobTarget();
    await muxBlobs({ videoBlob, audioBlob, container, target: bt });
    saveBlobAs(new Blob([bt.buffer]), target.suggestedName);
  }
}

// 路徑 B：SABR / UMP 串流（無直連 URL，但有 server_abr_streaming_url）
async function runSabrDownload({ quality, container, target, controls, onProgress }) {
  const sabr = await startSabrDownload({
    info: state.info,
    videoFormat: quality.videoFormat,
    audioFormat: quality.audioFormat,
    pageFetch,
    decipher: (url) => decipherServerUrl(state.info, url),
    poToken: state.poToken ?? null,
  });
  controls.sabr = sabr;
  controls.cancel = () => { try { sabr.abort(); } catch {} };
  // SABR 為連續串流，暫停難以精確中斷，這裡僅支援取消；pause/resume 為空操作。
  controls.pause = () => {};
  controls.resume = () => {};

  const { videoSource, audioSource } = sabr.toSources();
  onProgress({ loaded: 0, total: 0, phase: 'muxing' });

  if (target.kind === 'fs') {
    await muxSources({ videoSource, audioSource, container, target: streamTargetFor(target.writable) });
  } else {
    const bt = blobTarget();
    await muxSources({ videoSource, audioSource, container, target: bt });
    saveBlobAs(new Blob([bt.buffer]), target.suggestedName);
  }
}

async function runDownloadTask(job) {
  const { qualityIndex, language, concurrency } = job;
  const quality = state.qualities[qualityIndex];
  if (!quality) throw new Error('所選畫質不存在，請重新整理格式。');

  state.settingsLanguage = language;
  const container = quality.container;
  const filename = `${videoTitle()} [${quality.label}].${container}`;

  // 開啟寫盤目標（使用者取消存檔對話框會拋 AbortError）
  let target;
  try {
    target = await openOutput(filename, container);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      ui.setStatus('已取消儲存');
      return;
    }
    throw err;
  }

  const controls = {
    tasks: [],
    pause() { controls.tasks.forEach((t) => t.pause && t.pause()); },
    resume() { controls.tasks.forEach((t) => t.resume && t.resume()); },
    cancel() { controls.tasks.forEach((t) => t.cancel && t.cancel()); },
  };
  currentTask = { controls };

  ui.setTaskButtons(true);
  ui.setError(null);
  ui.setStatus('開始下載…');

  try {
    const onProgress = (p) => ui.setProgress(p);

    const videoFormat = quality.videoFormat;
    const hasDirect = Boolean(videoFormat?.url || videoFormat?.cipher || videoFormat?.signature_cipher);

    if (hasDirect) {
      await runDirectDownload({ quality, container, target, concurrency, controls, onProgress });
    } else if (hasSabrStreaming(state.info)) {
      await runSabrDownload({ quality, container, target, controls, onProgress });
    } else {
      throw new Error('此畫質沒有可用直連 URL，也非 SABR 影片。建議更換畫質或重新整理格式（右上角「刷新格式」）。');
    }

    ui.setProgress({ loaded: 1, total: 1 });
    ui.setStatus('下載完成 ✅');
  } finally {
    ui.setTaskButtons(false);
    currentTask = null;
  }
}

// ---------- 佇列：一次跑一個 ----------
const queue = [];
let running = false;

function enqueue(job) {
  queue.push(job);
  runNext();
}

async function runNext() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  try {
    await runDownloadTask(job);
  } catch (err) {
    console.error('[YT-DL] 下載失敗', err);
    ui.setError(err);
    ui.setStatus('下載失敗');
  } finally {
    running = false;
    runNext();
  }
}

function startDownload({ qualityIndex, language, concurrency }) {
  enqueue({ qualityIndex, language, concurrency });
}

// ---------- UI 回呼 ----------
function handlePause() { currentTask?.controls?.pause && currentTask.controls.pause(); }
function handleResume() { currentTask?.controls?.resume && currentTask.controls.resume(); }
function handleCancel() { currentTask?.controls?.cancel && currentTask.controls.cancel(); }

const ui = createUI({
  onStart: (qualityIndex, language, concurrency) => {
    startDownload({ qualityIndex, language, concurrency });
  },
  onPause: handlePause,
  onResume: handleResume,
  onCancel: handleCancel,
  onRefresh: () => { refreshFormats(); },
  onSettingsChange: (s) => { /* 已由 ui 透過 settings.js 持久化，這裡可留作擴充 */ },
});

// ---------- 導航 / 開機 ----------
function onNavigate() {
  // yt-navigate-finish 後再延遲抓一次內嵌 player response（SPA 可能尚未填好）
  setTimeout(() => {
    try {
      if (unsafeWindow.ytInitialPlayerResponse) {
        pageCapture.playerResponse = unsafeWindow.ytInitialPlayerResponse;
      }
    } catch {}
  }, 500);

  state.videoId = parseVideoId();
  ui.ensureButton();
  if (state.videoId) {
    refreshFormats();
  } else {
    ui.setStatus('此頁面非影片頁，無法下載。');
  }
}

installFetchOverride();
window.addEventListener('yt-navigate-finish', onNavigate);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onNavigate);
} else {
  onNavigate();
}

console.log('[YT-DL] youtube-direct-downloader ready');
