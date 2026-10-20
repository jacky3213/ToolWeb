// src/ui.js
//
// 完整 Tampermonkey 注入式 UI：下載按鈕 + 右下角浮動面板。
// 攔截式下載 UI：進度條、狀態/錯誤區、開始/取消控制項。
// 所有樣式以 YouTube 的 `--yt-spec-*` CSS 變數為基礎，自動跟隨深淺色主題。

import { formatBytes } from './range-split.js';

const STYLE_ID = 'ytdl-style';

const PANEL_CSS = `
.ytdl-style-base {
  --ytdl-bg: var(--yt-spec-base-background, #fff);
  --ytdl-surface: var(--yt-spec-surface-background, #f9f9f9);
  --ytdl-text: var(--yt-spec-text-primary, #0d0d0d);
  --ytdl-text-secondary: var(--yt-spec-text-secondary, #606060);
  --ytdl-border: var(--yt-spec-10-percent-layer, #e5e5e5);
  --ytdl-accent: var(--yt-spec-call-to-action, #065fd4);
  --ytdl-accent-text: var(--yt-spec-call-to-action-text, #fff);
  --ytdl-danger: #cc0000;
  font-family: "Roboto", "YouTube Noto", Arial, sans-serif;
}
.ytdl-panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 320px;
  max-width: calc(100vw - 32px);
  background: var(--ytdl-surface);
  color: var(--ytdl-text);
  border: 1px solid var(--ytdl-border);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.28);
  z-index: 2147483647;
  font-size: 13px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.ytdl-panel[hidden] { display: none; }
.ytdl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--ytdl-border);
  font-weight: 600;
}
.ytdl-head .ytdl-close {
  cursor: pointer;
  border: none;
  background: transparent;
  color: var(--ytdl-text-secondary);
  font-size: 18px;
  line-height: 1;
}
.ytdl-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.ytdl-row { display: flex; flex-direction: column; gap: 4px; }
.ytdl-row > label { color: var(--ytdl-text-secondary); font-size: 12px; }
.ytdl-row select {
  width: 100%;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--ytdl-border);
  background: var(--ytdl-bg);
  color: var(--ytdl-text);
  font-size: 13px;
}
.ytdl-progress-wrap { display: flex; flex-direction: column; gap: 4px; }
.ytdl-progress {
  height: 8px;
  width: 100%;
  background: var(--ytdl-border);
  border-radius: 999px;
  overflow: hidden;
}
.ytdl-progress > .ytdl-bar {
  height: 100%;
  width: 0%;
  background: var(--ytdl-accent);
  transition: width 0.2s ease;
}
.ytdl-progress-text { color: var(--ytdl-text-secondary); font-size: 12px; }
.ytdl-status { color: var(--ytdl-text-secondary); min-height: 16px; font-size: 12px; }
.ytdl-error {
  color: var(--ytdl-danger);
  background: rgba(204,0,0,0.08);
  border: 1px solid rgba(204,0,0,0.3);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.ytdl-error[hidden] { display: none; }
.ytdl-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.ytdl-actions button {
  flex: 1 1 auto;
  min-width: 64px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--ytdl-border);
  background: var(--ytdl-bg);
  color: var(--ytdl-text);
  cursor: pointer;
  font-size: 13px;
}
.ytdl-actions button:disabled { opacity: 0.45; cursor: default; }
.ytdl-actions .ytdl-start {
  background: var(--ytdl-accent);
  color: var(--ytdl-accent-text);
  border-color: var(--ytdl-accent);
  font-weight: 600;
}
.ytdl-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0 4px;
  padding: 0 12px;
  height: 36px;
  border: none;
  border-radius: 18px;
  background: var(--yt-spec-icon-button-background-hover, rgba(0,0,0,0.05));
  color: var(--yt-spec-text-primary, #0d0d0d);
  font: 500 14px/1 "Roboto", Arial, sans-serif;
  cursor: pointer;
}
.ytdl-btn:hover { background: var(--yt-spec-icon-button-background-active, rgba(0,0,0,0.1)); }
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = PANEL_CSS;
  const mount = () => {
    const root = document.head || document.documentElement;
    if (root) root.appendChild(style);
  };
  if (document.head || document.documentElement) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    // 注意：不支援 `html` 屬性。YouTube 啟用 Trusted Types
    // （require-trusted-types-for 'script'），任何 innerHTML 指派都會丟
    // TypeError 而中斷整個流程；內容一律走 textContent / appendChild。
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/**
 * 建立 UI。回傳控制介面供 main 使用。
 *
 * @param {object} callbacks
 * @param {Function} callbacks.onStart   (qualityIndex, language, concurrency) => void
 * @param {Function} callbacks.onPause   () => void
 * @param {Function} callbacks.onResume  () => void
 * @param {Function} callbacks.onCancel  () => void
 * @param {Function} callbacks.onRefresh () => void
 * @param {Function} callbacks.onSettingsChange (settings) => void
 */
export function createUI({ onStart, onCancel }) {
  injectStyle();

  let buttonEl = null;
  let panelEl = null;
  let taskActive = false;

  // ---- 面板骨架 ----
  const bar = el('div', { class: 'ytdl-bar' });
  const progressText = el('div', { class: 'ytdl-progress-text', text: '尚未開始' });
  const statusEl = el('div', { class: 'ytdl-status', text: '' });
  const errorEl = el('div', { class: 'ytdl-error', hidden: true });

  const btnCancel = el('button', { class: 'ytdl-cancel', text: '取消', disabled: true });
  const btnStart = el('button', { class: 'ytdl-start', text: '開始攔截下載' });

  btnCancel.addEventListener('click', () => { onCancel && onCancel(); });
  btnStart.addEventListener('click', () => {
    if (!taskActive) {
      onStart && onStart();
    }
  });

  const panel = el('div', { class: 'ytdl-panel ytdl-style-base', hidden: true, id: 'ytdl-panel' }, [
    el('div', { class: 'ytdl-head' }, [
      el('span', { text: 'YouTube 攔截下載' }),
      el('button', { class: 'ytdl-close', text: '×', title: '關閉' , onclick: () => { panel.hidden = true; } }),
    ]),
    el('div', { class: 'ytdl-body' }, [
      el('div', { class: 'ytdl-row' }, [
        el('label', { text: '提示：會以 16x 靜音加速播放，從頭播到尾以攔截完整高畫質分片。請保持分頁在前景。' }),
      ]),
      el('div', { class: 'ytdl-progress-wrap' }, [
        el('div', { class: 'ytdl-progress' }, [bar]),
        progressText,
      ]),
      statusEl,
      errorEl,
      el('div', { class: 'ytdl-actions' }, [
        btnCancel, btnStart,
      ]),
    ]),
  ]);

  panelEl = panel;
  // 延遲掛載：@run-at document-start 時 document.body 可能尚不存在
  const mountPanel = () => {
    if (panelEl && !panelEl.parentNode && document.body) document.body.appendChild(panelEl);
  };
  if (document.body) mountPanel();
  else document.addEventListener('DOMContentLoaded', mountPanel, { once: true });

  // ---- 按鈕：插入到影片頁 / Shorts 頁合適容器 ----
  //
  // ⚠️ 兩個已踩過的坑，改動前先讀：
  // 1. 不可把 `ytd-watch-metadata` / `ytd-reel-video-renderer` **本體**當容器。
  //    它們是 Polymer host，首次 stamp 會清掉不是自己產生的子節點 —— 按鈕被吃掉
  //    且不報錯，看起來就是「完全沒有按鈕」。
  // 2. 不可只用 `document.contains()` 判斷按鈕「在不在」。YouTube 會留下大量
  //    display:none / 尺寸為 0 的骨架節點；把按鈕搬進去之後它仍在文件裡、
  //    contains 依然是 true，但人眼完全看不到 —— 症狀是「一打開有看到，
  //    之後就不見了」。所以一律用 getBoundingClientRect() 量實際尺寸。

  /** 元素是否真的看得見（在文件內，且量得到尺寸）。 */
  function isVisibleInPage(node) {
    if (!node || !document.contains(node)) return false;
    const rect = node.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  }

  /** 找出「看得見」的 actions 列；同一選擇器可能同時命中隱藏與可見的多個節點。 */
  function findButtonContainer() {
    const selectors = [
      'ytd-watch-metadata #top-level-buttons-computed',
      'ytd-watch-metadata #actions',
      'ytd-reel-video-renderer[is-active] #actions',
      'ytd-reel-video-renderer[is-active] #top-level-buttons-computed',
      '#top-level-buttons-computed',
    ];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (let i = 0; i < nodes.length; i++) {
        if (isVisibleInPage(nodes[i])) return nodes[i];
      }
    }
    return null;
  }

  // 浮動備援：容器還沒渲染時先固定在左上角，保證一定看得到
  function floatButton() {
    if (!buttonEl) return;
    buttonEl.classList.add('ytdl-btn-floating');
    buttonEl.style.position = 'fixed';
    buttonEl.style.top = '8px';
    buttonEl.style.left = '8px';
    buttonEl.style.zIndex = '2147483647';
    if (document.body && buttonEl.parentNode !== document.body) {
      document.body.appendChild(buttonEl);
    }
  }

  // 位置只在變化時輸出，方便日後從 console 直接看出按鈕去了哪裡
  let lastPlacement = '';
  function notePlacement(label) {
    if (label === lastPlacement) return;
    lastPlacement = label;
    console.log(`[YT-DL] 按鈕位置：${label}`);
  }

  function ensureButton() {
    if (!buttonEl) {
      buttonEl = el('button', {
        class: 'ytdl-btn ytdl-style-base',
        id: 'ytdl-download-btn',
        title: '下載此影片',
      }, ['⬇ 下載']);
      buttonEl.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
      });
    }

    const container = findButtonContainer();

    if (container) {
      // 有可見的 actions 列：不在裡面就搬進去（涵蓋首次掛載、SPA 換頁、Shorts 換片）
      if (buttonEl.parentNode !== container) {
        resetButtonPosition();
        container.appendChild(buttonEl);
        notePlacement('actions 列');
        return;
      }
      notePlacement(isVisibleInPage(buttonEl) ? 'actions 列' : 'actions 列（但量不到尺寸）');
      return;
    }

    // 沒有可用的 actions 列：一定要浮動而且看得見
    if (!buttonEl.classList.contains('ytdl-btn-floating') || !isVisibleInPage(buttonEl)) {
      floatButton();
      notePlacement('左上角浮動（等待 actions 列）');
    }
  }

  // 每秒自我修復：YouTube 是 SPA，actions 列會被反覆重建，Shorts 換片也不觸發
  // `yt-navigate-finish`。ensureButton() 是冪等的（已正確歸位時什麼都不做），
  // 每秒一次的成本只是幾個 querySelectorAll 加尺寸量測。
  let anchorTimer = null;
  function startAnchorWatch() {
    if (anchorTimer) return;
    anchorTimer = setInterval(ensureButton, 1000);
  }

  // 清除浮動樣式（歸位到頁面容器時用）
  function resetButtonPosition() {
    if (!buttonEl) return;
    buttonEl.classList.remove('ytdl-btn-floating');
    buttonEl.style.position = '';
    buttonEl.style.top = '';
    buttonEl.style.left = '';
    buttonEl.style.zIndex = '';
  }

  // ---- 渲染畫質 / 語言 ----
  // 註：攔截式下載不需要畫質/語言選單（攔的是播放器當前畫質），
  // 故 renderQualities 已移除。進度改用「已攔截 MB」呈現（見 setProgress）。

  function setStatus(text) {
    statusEl.textContent = text || '';
  }

  function setError(err) {
    const msg = err && err.message ? err.message : (err ? String(err) : '');
    if (!msg) { errorEl.hidden = true; errorEl.textContent = ''; return; }
    errorEl.hidden = false;
    errorEl.textContent = msg;
  }

  function setProgress({ loaded, total, phase } = {}) {
    const pct = (total && total > 0) ? Math.min(100, (loaded / total) * 100) : 0;
    bar.style.width = `${pct}%`;
    if (phase) {
      progressText.textContent = phase === 'muxing'
        ? '合併中…'
        : `${pct.toFixed(1)}% · ${formatBytes(loaded || 0)} / ${formatBytes(total || 0)}`;
    } else {
      progressText.textContent = total && total > 0
        ? `${pct.toFixed(1)}% · ${formatBytes(loaded || 0)} / ${formatBytes(total || 0)}`
        : (loaded ? formatBytes(loaded) : '');
    }
  }

  // 下載進行中切換按鈕可用性；active=false 還原
  function setTaskButtons(active) {
    taskActive = active;
    btnStart.disabled = active;
    btnCancel.disabled = !active;
  }

  // 開機即啟動看門狗：即使 main 的 onNavigate 沒被觸發（SPA 事件時序、
  // 或頁面已載入完成才注入），按鈕也會在一秒內出現。
  startAnchorWatch();

  return {
    ensureButton,
    setStatus,
    setError,
    setProgress,
    setTaskButtons,
  };
}
