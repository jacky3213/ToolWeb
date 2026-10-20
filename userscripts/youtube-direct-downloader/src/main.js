// src/main.js
//
// MSE 攔截式下載器總裝配。
//
// 流程：注入下載按鈕 → 使用者點「開始攔截下載」→ 建立 capture（攔 SourceBuffer）
// → 建立 playbackDriver（16x 靜音跟播）→ 播放中即時回報進度 → 播完（ended）
// → capture.stop() 拿 video/audio Blob → muxBlobs 合併 → 存檔。
//
// 注意：本檔案運行於 Tampermonkey 沙箱，依賴 unsafeWindow / document / window 等
// 全域，這些僅在瀏覽器運行期存在；node 靜態檢查時不會執行到取用處。

import { muxBlobs, streamTargetFor, blobTarget } from './muxer.js';
import { openOutput, saveBlobAs } from './fs-writer.js';
import { createCapture } from './capture.js';
import { createPlaybackDriver } from './playback-driver.js';
import { createUI } from './ui.js';

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
  // 標題優先取頁面 <title>（去掉「 - YouTube」後綴），取不到退回 videoId。
  const t = document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim();
  return sanitizeFilename(t || state.videoId || 'video');
}

// ---------- 全域狀態 ----------
const state = {
  videoId: null,
  capturing: false,
};

// 攔截下載流程
// capture 常駐：在模組載入時就建立並掛鉤（document-start 時機）。
// 這樣 addSourceBuffer 從一開始就被 hook，mime 會記錄到 WeakMap，
// 之後無論何時 appendBuffer 都能拿到 mime（解決「點下載時 SourceBuffer 早已建立、
// 拿不到 mime 導致 collect 失敗」的根因）。
const capture = createCapture();
capture.start(); // 常駐 hook + recording，點按鈕時再清空重收

let driver = null;
let pendingTarget = null; // 提前開啟的寫盤目標（避免 ended 後才開對話框被跳頁打斷）

// 進度回報：以「已攔截 MB」為主（攔截下載的本質是抓資料量，不是播放秒數）。
function reportCaptureProgress() {
  const { meta } = capture.getResult();
  const loaded = (meta.videoBytes || 0) + (meta.audioBytes || 0);
  ui.setProgress({ loaded, total: 0 });
  ui.setStatus(
    `攔截中… 視訊 ${((meta.videoBytes || 0) / 1024 / 1024).toFixed(1)} MB · 音訊 ${((meta.audioBytes || 0) / 1024 / 1024).toFixed(1)} MB`
  );
}

async function startCaptureDownload() {
  if (state.capturing) return;
  state.capturing = true;

  ui.setError(null);
  ui.setStatus('準備攔截…');
  ui.setTaskButtons(true);

  // 0. 提前開啟存檔對話框（在跟播前）。Mix 播放清單會在影片 ended 的瞬間
  //    自動跳下一首（SPA 換頁），若等到 ended 才開對話框，可能被換頁打斷。
  //    提前拿到 writable 後，ended 時直接寫盤，不依賴 ended 後的 UI 交互。
  const container = 'mp4';
  const filename = `${videoTitle()}.${container}`;
  try {
    pendingTarget = await openOutput(filename, container);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      ui.setStatus('已取消儲存');
      ui.setTaskButtons(false);
      state.capturing = false;
      return;
    }
    throw err;
  }

  // 1. capture 常駐（模組載入時已建立），此處清空舊資料重新收集。
  capture.start();

  // 2. 建立播放驅動：16x 靜音跟播
  driver = createPlaybackDriver({
    onProgress: () => {
      reportCaptureProgress();
    },
    onComplete: async () => {
      await finishCaptureDownload();
    },
    onError: (err) => {
      console.error('[YT-DL] 播放錯誤', err);
      ui.setError(err);
      ui.setStatus('播放錯誤');
      resetCapture();
    },
  });

  ui.setStatus('開始 16x 靜音加速播放…');
  await driver.start();
}

async function finishCaptureDownload() {
  // 同步取得 Blob（在第一時間），即使之後跳頁，資料已到手。
  const { video, audio } = capture.stop();
  // 先取出 pendingTarget 再 reset（reset 會清空 pendingTarget，順序不可顛倒）。
  const target = pendingTarget;
  resetCapture();

  if (!video) {
    ui.setError('未攔截到視訊分片。請確認影片已實際播放。');
    ui.setStatus('攔截失敗');
    ui.setTaskButtons(false);
    return;
  }

  ui.setStatus('拼檔中…');

  const container = 'mp4';

  if (!target) {
    // 兜底：提前開對話框失敗時，才在此時開（可能已跳頁，但至少嘗試）。
    ui.setError('寫盤目標遺失，請重新下載。');
    ui.setStatus('存檔失敗');
    ui.setTaskButtons(false);
    return;
  }

  try {
    if (target.kind === 'fs') {
      await muxBlobs({ videoBlob: video, audioBlob: audio, container, target: streamTargetFor(target.writable) });
    } else {
      const bt = blobTarget();
      await muxBlobs({ videoBlob: video, audioBlob: audio, container, target: bt });
      saveBlobAs(new Blob([bt.buffer]), target.suggestedName);
    }
    ui.setProgress({ loaded: 1, total: 1 });
    ui.setStatus('下載完成 ✅');
  } catch (err) {
    console.error('[YT-DL] 合併失敗', err);
    ui.setError(err);
    ui.setStatus('合併失敗');
  } finally {
    if (target?.kind === 'fs' && target.writable) {
      try { await target.writable.close(); } catch { /* 已關閉 */ }
    }
    ui.setTaskButtons(false);
  }
}

function resetCapture() {
  if (driver) {
    driver.cancel();
    driver = null;
  }
  // 注意：不在此處關閉 pendingTarget 的 writable。
  // writable 的生命週期由「完成流程」（finishCaptureDownload 的 finally）或
  // 「取消流程」（cancelCaptureDownload）各自負責，這裡只清空狀態，
  // 否則會誤關閉正要寫入的 writable（Cannot write to a CLOSED writable stream）。
  pendingTarget = null;
  state.capturing = false;
}

function cancelCaptureDownload() {
  if (!state.capturing) return;
  // 取消時，若已提前開啟 writable，需關閉它避免留下空檔與 handle 洩漏。
  if (pendingTarget?.kind === 'fs' && pendingTarget.writable) {
    try { pendingTarget.writable.close(); } catch { /* 已關閉 */ }
  }
  resetCapture();
  ui.setStatus('已取消攔截下載');
  ui.setError(null);
  ui.setTaskButtons(false);
}

// ---------- UI ----------
const ui = createUI({
  onStart: () => { startCaptureDownload(); },
  onCancel: () => { cancelCaptureDownload(); },
});

// ---------- 導航 / 開機 ----------
function onNavigate() {
  state.videoId = parseVideoId();
  ui.ensureButton();
  if (!state.videoId) {
    ui.setStatus('此頁面非影片頁，無法下載。');
  } else {
    ui.setStatus('');
  }
}

window.addEventListener('yt-navigate-finish', onNavigate);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onNavigate);
} else {
  onNavigate();
}

console.log('[YT-DL] youtube-direct-downloader ready (MSE capture mode)');
