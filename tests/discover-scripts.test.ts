import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverScriptsOnDisk } from '../lib/discover-scripts.ts';

function makeTempDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-test-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  }
  return dir;
}

const VALID = `// ==UserScript==
// @name         Test Script
// @version      1.0
// ==/UserScript==
`;

test('只回傳 .user.js 檔案', () => {
  const dir = makeTempDir({
    'a.user.js': VALID,
    'b.apk': 'binary',
    'c.txt': 'text',
    'd.js': 'not a userscript',
  });

  const result = discoverScriptsOnDisk(dir);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(result.length, 1);
  assert.equal(result[0].fileName, 'a.user.js');
});

test('解析出腳本內的版本', () => {
  const dir = makeTempDir({ 'x.user.js': VALID });

  const result = discoverScriptsOnDisk(dir);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(result[0].version, 'v1.0');
});

test('內容非 userscript 的 .user.js 檔會被跳過', () => {
  const dir = makeTempDir({ 'fake.user.js': 'console.log("not a userscript")' });

  const result = discoverScriptsOnDisk(dir);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(result.length, 0);
});

test('目錄不存在時回傳空陣列而非拋錯', () => {
  const result = discoverScriptsOnDisk('/nonexistent/path/xyz');
  assert.deepEqual(result, []);
});
