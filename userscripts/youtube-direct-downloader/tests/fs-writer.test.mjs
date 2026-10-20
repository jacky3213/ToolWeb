// tests/fs-writer.test.mjs
//
// 迴歸測試：Tampermonkey 沙箱下呼叫原生 API 的 `this` 綁定。
//
// 實際發生過：`window.showSaveFilePicker(...)` 在 TM 沙箱裡丟
//   TypeError: Failed to execute 'showSaveFilePicker' on 'Window': Illegal invocation
// 原因：沙箱的 `window` 不是真正的 Window，原生方法以它為 this 會被拒。
// 修法：一律向 unsafeWindow 取值並 bind 回真 window。

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { supportsFsAccess, openOutput, saveBlobAs } from '../src/fs-writer.js';

const SANDBOX_ONLY = {
  showSaveFilePicker() {
    throw new TypeError("Failed to execute 'showSaveFilePicker' on 'Window': Illegal invocation");
  },
};

afterEach(() => {
  delete globalThis.window;
  delete globalThis.unsafeWindow;
  delete globalThis.document;
  delete globalThis.setTimeout;
});

test('supportsFsAccess：以 unsafeWindow 為準，不看沙箱 window', () => {
  globalThis.window = {};
  globalThis.unsafeWindow = { showSaveFilePicker: () => {} };
  assert.equal(supportsFsAccess(), true, '真 window 有方法即可用');

  globalThis.window = { showSaveFilePicker: () => {} };
  globalThis.unsafeWindow = {}; // 真 window 沒有 → 視為不支援
  assert.equal(supportsFsAccess(), false, '沙箱 window 有方法不算數');
});

test('openOutput：以真 window 為 this 呼叫，不會 Illegal invocation', async () => {
  const picked = [];
  const realWindow = {
    showSaveFilePicker(opts) {
      picked.push({ self: this, opts });
      return Promise.resolve({ createWritable: async () => ({ written: true }) });
    },
  };
  globalThis.unsafeWindow = realWindow;
  globalThis.window = SANDBOX_ONLY; // 若誤用沙箱 window 就會拋錯並退回 blob

  const target = await openOutput('影片 [1080p].mp4', 'mp4');

  assert.equal(target.kind, 'fs', '應成功走 FS Access，不可退回 blob');
  assert.ok(target.writable, '應取得 writable');
  assert.equal(picked.length, 1);
  assert.equal(picked[0].self, realWindow, 'this 必須綁回真 window');
  assert.equal(picked[0].opts.suggestedName, '影片 [1080p].mp4');
  assert.deepEqual(picked[0].opts.types[0].accept, { 'video/mp4': ['.mp4'] });
});

test('openOutput：非 Abort 錯誤（權限等）退回 blob', async () => {
  globalThis.unsafeWindow = {
    showSaveFilePicker: () => Promise.reject(new Error('SecurityError')),
  };

  const target = await openOutput('x.mp4', 'mp4');
  assert.equal(target.kind, 'blob');
  assert.equal(target.writable, null);
});

test('openOutput：使用者取消（AbortError）直接往上拋，不退回 blob', async () => {
  const abort = new Error('cancelled');
  abort.name = 'AbortError';
  globalThis.unsafeWindow = { showSaveFilePicker: () => Promise.reject(abort) };

  await assert.rejects(() => openOutput('x.mp4', 'mp4'), /cancelled/);
});

test('openOutput：真 window 沒有 showSaveFilePicker 時直接用 blob', async () => {
  globalThis.unsafeWindow = {};

  const target = await openOutput('x.webm', 'webm');
  assert.equal(target.kind, 'blob');
});

test('saveBlobAs：objectURL 由真 window 的 URL 建立與回收', () => {
  const revoked = [];
  globalThis.unsafeWindow = {
    URL: {
      createObjectURL: () => 'blob:fake-url',
      revokeObjectURL: (u) => revoked.push(u),
    },
  };
  globalThis.window = {
    URL: {
      createObjectURL() { throw new TypeError('Illegal invocation'); },
    },
  };

  const appended = [];
  const anchor = { href: '', download: '', clicked: false, click() { this.clicked = true; }, remove() {} };
  globalThis.document = {
    createElement: () => anchor,
    body: { appendChild: (n) => appended.push(n) },
  };
  globalThis.setTimeout = (fn) => { fn(); return 0; }; // 立即執行 revoke

  saveBlobAs({ size: 1 }, 'a.mp4');

  assert.equal(anchor.href, 'blob:fake-url', '應使用真 window 建立的 objectURL');
  assert.equal(anchor.download, 'a.mp4');
  assert.equal(anchor.clicked, true, '應觸發下載');
  assert.deepEqual(appended.length, 1);
  assert.deepEqual(revoked, ['blob:fake-url'], 'objectURL 應被回收');
});
