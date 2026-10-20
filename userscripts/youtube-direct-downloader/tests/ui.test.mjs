// tests/ui.test.mjs
//
// UI 迴歸測試。守兩個已實際發生過的 bug：
//   1. v0.1.1：按鈕被 Polymer 吃掉、永遠不出現（見下）
//   2. v0.1.2：`innerHTML` 被 YouTube 的 Trusted Types 政策擋下，
//      導致畫質清單渲染失敗、面板顯示「取得格式失敗」
//
// 歷史：findButtonContainer() 曾把 `ytd-watch-metadata` 本體當容器，但它是 Polymer
// host，首次 stamp 會清掉非自身渲染的子節點 → 剛 append 的按鈕被移除且不再重建。
//
// 這裡用最小 DOM stub 驗證四條路徑（不引入 jsdom，維持零依賴）：
//   1. 容器尚未渲染 → 浮動顯示（保證看得到）
//   2. 容器出現     → 歸位並清除浮動樣式
//   3. 按鈕被移除   → 自動重建
//   4. 容器消失     → 退回浮動

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 極簡 DOM 節點：只實作 ui.js 實際用到的 API。 */
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.style = {};
    this.hidden = false;
    this.textContent = '';
    this._classes = new Set();
    this._listeners = {};
    // 預設「有尺寸」= 看得見；用 hide() / show() 模擬 YouTube 的隱藏骨架節點
    this._rect = { width: 120, height: 36 };
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      contains: (c) => self._classes.has(c),
    };
  }
  set className(v) {
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this._classes.add(c));
  }
  get className() { return [...this._classes].join(' '); }
  // 模擬 YouTube 的 Trusted Types：任何 innerHTML 指派都必須拋錯。
  // 這是刻意的——若有人改回 `innerHTML = ''`，這裡會立刻失敗。
  set innerHTML(_v) {
    throw new TypeError("Failed to set the 'innerHTML' property on 'Element': This document requires 'TrustedHTML' assignment.");
  }
  replaceChildren(...nodes) {
    this.children.forEach((c) => { c.parentNode = null; });
    this.children = [];
    nodes.forEach((n) => this.appendChild(n));
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getBoundingClientRect() { return this._rect; }
  /** 模擬 display:none / 尺寸為 0 的骨架節點 */
  hide() { this._rect = { width: 0, height: 0 }; }
  show() { this._rect = { width: 120, height: 36 }; }
  appendChild(n) { n.parentNode = this; this.children.push(n); return n; }
  addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); }
  click() { (this._listeners.click || []).forEach((f) => f()); }
}

/** 建立一個乾淨的 stub 環境並載入 ui.js（每次 import 都拿新實例）。 */
async function setup() {
  const selectors = {};
  const body = new FakeNode('body');
  const head = new FakeNode('head');
  const html = new FakeNode('html');

  globalThis.document = {
    body,
    head,
    documentElement: html,
    createElement: (t) => new FakeNode(t),
    createTextNode: (t) => {
      const n = new FakeNode('#text');
      n.textContent = String(t);
      return n;
    },
    getElementById: () => null,
    querySelector: (sel) => selectors[sel] || null,
    querySelectorAll: (sel) => {
      const v = selectors[sel];
      if (!v) return [];
      return Array.isArray(v) ? v : [v];
    },
    addEventListener: () => {},
    contains(node) {
      let n = node;
      while (n) {
        if (n === body || n === head || n === html) return true;
        n = n.parentNode;
      }
      return false;
    },
  };

  const store = {};
  globalThis.GM_getValue = (k, d) => (k in store ? store[k] : d);
  globalThis.GM_setValue = (k, v) => { store[k] = v; };
  globalThis.window = { addEventListener: () => {} };
  globalThis.setInterval = () => 0; // 不讓看門狗把測試 process 拖住

  // 帶 query string 讓 ESM 重新求值，避免模組快取共用狀態
  const { createUI } = await import(`../src/ui.js?t=${Date.now()}-${Math.random()}`);

  const ui = createUI({
    onStart: () => {},
    onPause: () => {},
    onResume: () => {},
    onCancel: () => {},
    onRefresh: () => {},
    onSettingsChange: () => {},
  });

  return { ui, body, selectors };
}

const BUTTON_SEL = 'ytd-watch-metadata #top-level-buttons-computed';
const findBtn = (nodes) =>
  nodes.find((c) => c.tagName === 'BUTTON' && c._classes.has('ytdl-btn'));

test('renderQualities 不使用 innerHTML，可在 Trusted Types 頁面正常渲染', async () => {
  const { ui, body } = await setup();

  // UI 建立後面板已掛進 body；依文件順序為 畫質 / 語言 / 並發數
  const walk = (node, tag, acc = []) => {
    node.children.forEach((c) => {
      if (c.tagName === tag) acc.push(c);
      walk(c, tag, acc);
    });
    return acc;
  };
  const selects = walk(body, 'SELECT');
  assert.equal(selects.length, 3, '應有畫質、語言、並發數三個 select');
  const [qualitySelect, langSelect] = selects;

  // stub 的 innerHTML setter 會拋錯，這行能跑完就代表沒用到 innerHTML
  ui.renderQualities(
    [
      { label: '1080p', container: 'mp4', sizeBytes: 1024, isProgressive: false },
      { label: '720p', container: 'mp4', sizeBytes: 512, isProgressive: true },
    ],
    ['en', 'ja']
  );

  assert.equal(qualitySelect.children.length, 2, '畫質選項應被渲染');
  assert.match(qualitySelect.children[0].textContent, /1080p/);
  assert.match(qualitySelect.children[1].textContent, /含音訊/, '漸進式格式應標註含音訊');

  assert.equal(langSelect.children.length, 3, '語言 = 自動 + en + ja');
  assert.equal(langSelect.children[0].textContent, '自動（瀏覽器語言）');
  assert.equal(langSelect.children[1].textContent, 'en');
});

test('容器尚未渲染時，按鈕以浮動方式顯示（不會靜默消失）', async () => {
  const { ui, body } = await setup();
  ui.ensureButton();

  const btn = findBtn(body.children);
  assert.ok(btn, '按鈕應被建立');
  assert.equal(btn.style.position, 'fixed', '應為浮動定位');
  assert.ok(btn._classes.has('ytdl-btn-floating'), '應帶浮動標記');
  assert.equal(btn.attrs.id, 'ytdl-download-btn');
});

test('actions 列出現後，按鈕歸位並清除浮動樣式', async () => {
  const { ui, body, selectors } = await setup();
  ui.ensureButton();
  const btn = findBtn(body.children);

  const actions = new FakeNode('div');
  body.appendChild(actions);
  selectors[BUTTON_SEL] = actions;

  ui.ensureButton();

  assert.ok(actions.children.includes(btn), '按鈕應被移入 actions 列');
  assert.ok(!btn._classes.has('ytdl-btn-floating'), '浮動標記應被清除');
  assert.equal(btn.style.position, '', '固定定位應被重設');
});

test('按鈕被 YouTube 重新渲染移除後，會自動重建', async () => {
  const { ui, body, selectors } = await setup();
  const actions = new FakeNode('div');
  body.appendChild(actions);
  selectors[BUTTON_SEL] = actions;

  ui.ensureButton();
  const first = findBtn(actions.children);
  assert.ok(first);

  // 模擬 Polymer 清掉子節點
  actions.children = [];
  first.parentNode = null;

  ui.ensureButton();

  const rebuilt = findBtn(actions.children);
  assert.ok(rebuilt, '按鈕應重新出現在 actions 列');
  assert.ok(document.contains(rebuilt), '重建後必須仍在文件內');
  assert.ok(!rebuilt._classes.has('ytdl-btn-floating'), '有容器時不應退回浮動');
});

test('容器消失（SPA 換頁）時退回浮動，保持可見', async () => {
  const { ui, body, selectors } = await setup();
  const actions = new FakeNode('div');
  body.appendChild(actions);
  selectors[BUTTON_SEL] = actions;

  ui.ensureButton();
  const btn = findBtn(actions.children);
  assert.ok(btn);

  delete selectors[BUTTON_SEL];
  ui.ensureButton();

  assert.ok(btn._classes.has('ytdl-btn-floating'), '應退回浮動狀態');
  assert.ok(document.contains(btn), '仍須留在文件內，不可消失');
});

// ---- 可見性：v0.1.3 修的「一打開有看到，之後就不見了」 ----
//
// YouTube 會留下尺寸為 0 的骨架節點。舊版只檢查 document.contains()，
// 把按鈕搬進隱藏骨架後 contains 仍為 true，但人眼完全看不到。

test('容器存在但量不到尺寸時，不把按鈕搬進去（維持浮動）', async () => {
  const { ui, body, selectors } = await setup();

  const hidden = new FakeNode('div');
  hidden.hide();
  body.appendChild(hidden);
  selectors[BUTTON_SEL] = hidden;

  ui.ensureButton();

  const btn = findBtn(body.children);
  assert.ok(btn, '按鈕應存在');
  assert.ok(btn._classes.has('ytdl-btn-floating'), '應維持浮動，不可搬進隱藏容器');
  assert.ok(!hidden.children.includes(btn), '不可被放進隱藏骨架');
});

test('同時存在隱藏與可見容器時，選擇可見的那個', async () => {
  const { ui, body, selectors } = await setup();

  const hidden = new FakeNode('div');
  hidden.hide();
  body.appendChild(hidden);
  const visible = new FakeNode('div');
  body.appendChild(visible);
  selectors[BUTTON_SEL] = [hidden, visible]; // 隱藏的在前面，模擬 querySelector 先命中

  ui.ensureButton();

  assert.equal(visible.children.length, 1, '應放進可見的容器');
  assert.equal(hidden.children.length, 0, '不可放進隱藏的容器');
});

test('容器後來變成隱藏（一閃就不見）時，按鈕退回浮動', async () => {
  const { ui, body, selectors } = await setup();

  const actions = new FakeNode('div');
  body.appendChild(actions);
  selectors[BUTTON_SEL] = actions;

  ui.ensureButton();
  const btn = findBtn(actions.children);
  assert.ok(btn, '應先歸位到 actions 列');

  actions.hide(); // YouTube 把 actions 列藏起來或換成隱藏骨架
  ui.ensureButton(); // 看門狗每秒會做的事

  assert.ok(btn._classes.has('ytdl-btn-floating'), '應退回浮動');
  assert.equal(btn.parentNode, body, '應掛回 body');
  assert.ok(document.contains(btn), '不可消失');
});
