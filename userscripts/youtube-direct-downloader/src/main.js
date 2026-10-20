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

// ---------- 攔截下載流程 ----------
let capture = null;
let driver = null;

// 進度回報：以「已攔截 MB」為主（攔截下載的本質是抓資料量，不是播放秒數）。
function reportCaptureProgress() {
  if (!capture) return;
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

  // 1. 建立 capture 並開始攔截（攔 SourceBuffer）
  capture = createCapture();
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
  if (!capture) return;
  const { video, audio } = capture.stop();
  resetCapture();

  if (!video) {
    ui.setError('未攔截到視訊分片。請確認影片已實際播放。');
    ui.setStatus('攔截失敗');
    ui.setTaskButtons(false);
    return;
  }

  ui.setStatus('拼檔中…');

  // 3. 輸出統一 mp4（video 是 mp4，audio 是 webm，mediabunny 跨容器合併）
  const container = 'mp4';
  const filename = `${videoTitle()}.${container}`;

  let target;
  try {
    target = await openOutput(filename, container);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      ui.setStatus('已取消儲存');
      ui.setTaskButtons(false);
      return;
    }
    throw err;
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
  capture = null;
  if (driver) {
    driver.cancel();
    driver = null;
  }
  state.capturing = false;
}

function cancelCaptureDownload() {
  if (!state.capturing) return;
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
