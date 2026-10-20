import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUserScriptMetadata } from '../lib/userscript-metadata.ts';

const SCRIPT = `// ==UserScript==
// @name         Olevod 影片預載器
// @namespace    https://github.com/jacky3213
// @version      1.3.1
// @description  提前預下載後續 HLS 分片
// ==/UserScript==

console.log('hello');
`;

test('解析 @name 與 @version', () => {
  const meta = parseUserScriptMetadata(SCRIPT);
  assert.equal(meta.name, 'Olevod 影片預載器');
  assert.equal(meta.version, 'v1.3.1');
  assert.equal(meta.description, '提前預下載後續 HLS 分片');
});

test('版本缺少 v 前綴時自動補上', () => {
  const s = '// @version 2.0';
  assert.equal(parseUserScriptMetadata(s).version, 'v2.0');
});

test('已有 v 前綴時不重複補上', () => {
  const s = '// @version v2.0';
  assert.equal(parseUserScriptMetadata(s).version, 'v2.0');
});

test('缺少 @version 時回傳 null', () => {
  const s = '// ==UserScript==\n// @name Test\n// ==/UserScript==';
  assert.equal(parseUserScriptMetadata(s).version, null);
});

test('非 userscript 回傳 null name', () => {
  assert.equal(parseUserScriptMetadata('console.log(1)').name, null);
});

test('沒有 ==UserScript== 區塊時視為無效', () => {
  const fake = '// @name Fake\n// @version 1.0';
  assert.equal(parseUserScriptMetadata(fake).name, null);
});
