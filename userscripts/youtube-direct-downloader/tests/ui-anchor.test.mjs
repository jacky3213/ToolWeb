// tests/ui-anchor.test.mjs
//
// 迴歸測試：v0.1.1 修掉的「按鈕被 Polymer 吃掉、永遠不出現」。
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
  set innerHTML(_v) { this.children = []; this.textContent = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
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
