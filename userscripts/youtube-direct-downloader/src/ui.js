// src/ui.js
//
// 完整 Tampermonkey 注入式 UI：下載按鈕 + 右下角浮動面板。
// 依賴：style 注入、quality/lang/concurrency 三個 select、進度條、狀態/錯誤區、
// 暫停/恢復/取消/刷新/開始 控制項。所有樣式以 YouTube 的 `--yt-spec-*` CSS 變數
// 為基礎，自動跟隨深淺色主題。
//
// 持久化透過 settings.js（GM_setValue/GM_getValue），同時在控制項變動時呼叫
// onSettingsChange 讓 main 同步運行期設定。

import { getSetting, setSetting } from './settings.js';
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
export function createUI({ onStart, onPause, onResume, onCancel, onRefresh, onSettingsChange }) {
  injectStyle();

  let buttonEl = null;
  let panelEl = null;
  let paused = false;
  let taskActive = false;

  // 暫存目前控制項選擇，便於 onSettingsChange / 預設回填
  const settings = {
    concurrency: Number(getSetting('concurrency', 4)) || 4,
    qualityIndex: Number(getSetting('qualityIndex', 0)) || 0,
    language: String(getSetting('language', 'auto')),
  };

  // ---- 面板骨架 ----
  const qualitySelect = el('select', { id: 'ytdl-quality', class: 'ytdl-select' });
  const langSelect = el('select', { id: 'ytdl-lang', class: 'ytdl-select' });
  const concSelect = el('select', { id: 'ytdl-concurrency', class: 'ytdl-select' });
  for (let i = 1; i <= 8; i++) {
    concSelect.appendChild(el('option', { value: String(i), text: String(i) }));
  }
  concSelect.value = String(settings.concurrency);

  const bar = el('div', { class: 'ytdl-bar' });
  const progressText = el('div', { class: 'ytdl-progress-text', text: '尚未開始' });
  const statusEl = el('div', { class: 'ytdl-status', text: '' });
  const errorEl = el('div', { class: 'ytdl-error', hidden: true });

  const btnToggle = el('button', { class: 'ytdl-pause', text: '暫停', disabled: true });
  const btnCancel = el('button', { class: 'ytdl-cancel', text: '取消', disabled: true });
  const btnRefresh = el('button', { class: 'ytdl-refresh', text: '刷新格式' });
  const btnStart = el('button', { class: 'ytdl-start', text: '開始下載' });

  // 單一「暫停/恢復」切換按鈕：文字在 暫停 ↔ 恢復 間切換
  function togglePause() {
    if (!taskActive) return;
    if (!paused) {
      paused = true;
      btnToggle.textContent = '恢復';
      onPause && onPause();
    } else {
      paused = false;
      btnToggle.textContent = '暫停';
      onResume && onResume();
    }
  }
  btnToggle.addEventListener('click', togglePause);

  btnCancel.addEventListener('click', () => { onCancel && onCancel(); });
  btnRefresh.addEventListener('click', () => { onRefresh && onRefresh(); });
  btnStart.addEventListener('click', () => {
    if (!taskActive) {
      onStart && onStart(
        Number(qualitySelect.value),
        langSelect.value,
        Number(concSelect.value)
      );
    }
  });

  // 控制項變動 → 持久化 + 通知 main
  function emitSettings() {
    setSetting('concurrency', settings.concurrency);
    setSetting('qualityIndex', settings.qualityIndex);
    setSetting('language', settings.language);
    onSettingsChange && onSettingsChange({ ...settings });
  }
  qualitySelect.addEventListener('change', () => {
    settings.qualityIndex = Number(qualitySelect.value);
    emitSettings();
  });
  langSelect.addEventListener('change', () => {
    settings.language = langSelect.value;
    emitSettings();
  });
  concSelect.addEventListener('change', () => {
    settings.concurrency = Number(concSelect.value);
    emitSettings();
  });

  const panel = el('div', { class: 'ytdl-panel ytdl-style-base', hidden: true, id: 'ytdl-panel' }, [
    el('div', { class: 'ytdl-head' }, [
      el('span', { text: 'YouTube 直連下載' }),
      el('button', { class: 'ytdl-close', text: '×', title: '關閉' , onclick: () => { panel.hidden = true; } }),
    ]),
    el('div', { class: 'ytdl-body' }, [
      el('div', { class: 'ytdl-row' }, [
        el('label', { text: '畫質' }),
        qualitySelect,
      ]),
      el('div', { class: 'ytdl-row' }, [
        el('label', { text: '音軌語言' }),
        langSelect,
      ]),
      el('div', { class: 'ytdl-row' }, [
        el('label', { text: '並發數（分片下載）' }),
        concSelect,
      ]),
      el('div', { class: 'ytdl-progress-wrap' }, [
        el('div', { class: 'ytdl-progress' }, [bar]),
        progressText,
      ]),
      statusEl,
      errorEl,
      el('div', { class: 'ytdl-actions' }, [
        btnToggle, btnCancel, btnRefresh, btnStart,
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
  // ⚠️ 不可把 `ytd-watch-metadata` / `ytd-reel-video-renderer` **本體**當容器。
  // 它們是 Polymer host，首次 stamp 會清掉不是自己產生的子節點 —— 太早 append
  // 進去的按鈕會被吃掉，而且不會報錯、不會重試，看起來就是「完全沒有按鈕」。
  // 只接受 Polymer 真正渲染出來的 actions 列。
  function findButtonContainer() {
    const selectors = [
      'ytd-watch-metadata #top-level-buttons-computed',
      'ytd-watch-metadata #actions',
      'ytd-reel-video-renderer[is-active] #actions',
      'ytd-reel-video-renderer[is-active] #top-level-buttons-computed',
      '#top-level-buttons-computed',
    ];
    for (const sel of selectors) {
      const node = document.querySelector(sel);
      if (node) return node;
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

    if (!document.contains(buttonEl)) {
      // 首次建立，或先前的按鈕被 YouTube 重新渲染時移除
      if (container) {
        resetButtonPosition();
        container.appendChild(buttonEl);
      } else {
        floatButton();
      }
      return;
    }

    if (container) {
      // 仍在浮動，或容器被換掉（SPA 換頁 / Shorts 切換）→ 歸位
      if (buttonEl.classList.contains('ytdl-btn-floating') || buttonEl.parentNode !== container) {
        resetButtonPosition();
        container.appendChild(buttonEl);
      }
    } else if (!buttonEl.classList.contains('ytdl-btn-floating')) {
      // 原容器消失：退回浮動，保持可見
      floatButton();
    }
  }

  // 低頻自我修復：YouTube 是 SPA，actions 列會被反覆重建，Shorts 換片也不觸發
  // `yt-navigate-finish`。每秒只做一次 document.contains（成本可忽略），
  // 僅在按鈕遺失或仍在浮動時才查詢選擇器。
  let anchorTimer = null;
  function startAnchorWatch() {
    if (anchorTimer) return;
    anchorTimer = setInterval(() => {
      if (!buttonEl || !document.contains(buttonEl) || buttonEl.classList.contains('ytdl-btn-floating')) {
        ensureButton();
      }
    }, 1000);
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
  function renderQualities(qualities, languages) {
    // 用 replaceChildren() 清空。`innerHTML = ''` 在 YouTube 的 Trusted Types
    // 政策下會丟 TypeError（即使只是清空），導致整個格式清單渲染失敗。
    qualitySelect.replaceChildren();
    if (!qualities || !qualities.length) {
      qualitySelect.appendChild(el('option', { value: '-1', text: '（無可用畫質）' }));
    } else {
      for (let i = 0; i < qualities.length; i++) {
        const q = qualities[i];
        const size = q.sizeBytes != null ? ` · ${formatBytes(q.sizeBytes)}` : '';
        const prog = q.isProgressive ? ' · 含音訊' : '';
        qualitySelect.appendChild(
          el('option', { value: String(i), text: `${q.label} · ${q.container}${size}${prog}` })
        );
      }
    }
    // 選擇範圍保護：若之前存的大於現有數量，退回 0
    if (settings.qualityIndex >= qualities.length) settings.qualityIndex = 0;
    if (qualities.length) qualitySelect.value = String(settings.qualityIndex);

    langSelect.replaceChildren();
    langSelect.appendChild(el('option', { value: 'auto', text: '自動（瀏覽器語言）' }));
    const langs = (languages || []).filter(Boolean);
    for (const l of langs) {
      langSelect.appendChild(el('option', { value: l, text: l }));
    }
    if (langs.includes(settings.language)) langSelect.value = settings.language;
    else langSelect.value = 'auto';
  }

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
    if (active) {
      paused = false;
      btnToggle.disabled = false;
      btnToggle.textContent = '暫停';
    } else {
      btnToggle.disabled = true;
    }
  }

  // 開機即啟動看門狗：即使 main 的 onNavigate 沒被觸發（SPA 事件時序、
  // 或頁面已載入完成才注入），按鈕也會在一秒內出現。
  startAnchorWatch();

  return {
    ensureButton,
    renderQualities,
    setStatus,
    setError,
    setProgress,
    setTaskButtons,
  };
}
