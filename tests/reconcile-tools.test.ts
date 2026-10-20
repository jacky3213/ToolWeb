import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, mergeToolStore } from '../lib/reconcile-tools.ts';

interface ManifestEntry { id: string; scriptFileName: string; version: string; }
interface DiskScript { fileName: string; version: string | null; }

test('manifest 與磁碟皆有：以 manifest 版本為準', () => {
  const manifest: ManifestEntry[] = [
    { id: 'olevod', scriptFileName: 'olevod.user.js', version: 'v9.9' },
  ];
  const disk: DiskScript[] = [{ fileName: 'olevod.user.js', version: 'v1.0' }];

  const result = reconcile(manifest, disk);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'olevod');
  assert.equal(result[0].version, 'v9.9');
});

test('僅磁碟有：自動建立條目並採用腳本內的版本', () => {
  const result = reconcile([], [{ fileName: 'brand-new.user.js', version: 'v3.0' }]);

  assert.equal(result.length, 1);
  assert.equal(result[0].scriptFileName, 'brand-new.user.js');
  assert.equal(result[0].version, 'v3.0');
  assert.equal(result[0].id, 'brand-new');
});

test('僅 manifest 有（磁碟缺少）：不出現，避免死連結', () => {
  const manifest: ManifestEntry[] = [
    { id: 'ghost', scriptFileName: 'ghost.user.js', version: 'v1.0' },
  ];
  assert.equal(reconcile(manifest, []).length, 0);
});

test('磁碟腳本無版本時 version 為 null，不編造假值', () => {
  const result = reconcile([], [{ fileName: 'noversion.user.js', version: null }]);
  assert.equal(result[0].version, null);
});

test('混合情境：manifest 優先，目錄補齊其餘', () => {
  const manifest: ManifestEntry[] = [
    { id: 'a', scriptFileName: 'a.user.js', version: 'v1.0' },
  ];
  const disk: DiskScript[] = [
    { fileName: 'a.user.js', version: 'v0.1' },
    { fileName: 'b.user.js', version: 'v2.0' },
  ];

  const result = reconcile(manifest, disk);

  assert.deepEqual(
    result.map(r => `${r.scriptFileName}@${r.version}`).sort(),
    ['a.user.js@v1.0', 'b.user.js@v2.0']
  );
});

test('由檔名產生的 id 會去除附檔名', () => {
  const result = reconcile([], [{ fileName: 'my-tool.user.js', version: 'v1.0' }]);
  assert.equal(result[0].id, 'my-tool');
});

// --- APK 條目：manifest 以 apkFileName 指向檔案，不是 scriptFileName ---

test('APK 條目以 apkFileName 比對磁碟，保留完整 manifest 資料', () => {
  const manifest = [{
    id: 'adskip-apk',
    apkFileName: 'adskip.apk',
    version: 'v1.4',
    name: '開屏跳過',
  } as any];
  const disk = [{ fileName: 'adskip.apk', version: null }];

  const result = reconcile(manifest, disk);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'adskip-apk');
  assert.equal(result[0].name, '開屏跳過');
  assert.equal(result[0].version, 'v1.4');
});

test('APK 條目的檔案不存在於磁碟時略過（死連結防護）', () => {
  const manifest = [{
    id: 'ghost-apk',
    apkFileName: 'ghost.apk',
    version: 'v1.0',
  } as any];

  assert.equal(reconcile(manifest, []).length, 0);
});

test('磁碟上有 manifest 未登錄的 APK 時自動建立條目', () => {
  const result = reconcile([], [{ fileName: 'brand-new.apk', version: null }]);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'brand-new');
  assert.equal(result[0].apkFileName, 'brand-new.apk');
});

test('混合情境：腳本與 APK 同時存在且皆被正確識別', () => {
  const manifest = [
    { id: 'adskip-apk', apkFileName: 'adskip.apk', version: 'v1.4', name: '開屏跳過' },
    { id: 'olevod', scriptFileName: 'olevod.user.js', version: 'v1.3.1', name: 'Olevod' },
  ] as any[];
  const disk = [
    { fileName: 'adskip.apk', version: null },
    { fileName: 'olevod.user.js', version: 'v1.3.1' },
    { fileName: 'new-tool.user.js', version: 'v2.0' },
  ];

  const result = reconcile(manifest, disk);
  const byId = new Map(result.map(r => [r.id, r]));

  assert.equal(result.length, 3);
  assert.equal(byId.get('adskip-apk')!.name, '開屏跳過');
  assert.equal(byId.get('olevod')!.name, 'Olevod');
  assert.equal(byId.get('new-tool')!.version, 'v2.0');
});

// --- mergeToolStore：週期性重建 store 時保留執行期狀態 ---

test('新的清單中多出的工具會被加入', () => {
  const current = [{ id: 'a', name: 'A', downloadCount: 10 }] as any[];
  const desired = [
    { id: 'a', name: 'A', version: 'v1' },
    { id: 'b', name: 'B', version: 'v2' },
  ] as any[];

  const merged = mergeToolStore(current, desired);

  assert.deepEqual(merged.map(m => m.id), ['a', 'b']);
});

test('合併時保留既有工具的下載次數（執行期狀態）', () => {
  const current = [{ id: 'a', name: 'A', downloadCount: 42 }] as any[];
  const desired = [{ id: 'a', name: 'A 更新後', version: 'v9' }] as any[];

  const merged = mergeToolStore(current, desired);

  assert.equal(merged[0].downloadCount, 42);
  assert.equal(merged[0].name, 'A 更新後');
});

test('檔案被刪除的工具會從清單中消失', () => {
  const current = [
    { id: 'a', downloadCount: 1 },
    { id: 'gone', downloadCount: 5 },
  ] as any[];
  const desired = [{ id: 'a', version: 'v1' }] as any[];

  const merged = mergeToolStore(current, desired);

  assert.deepEqual(merged.map(m => m.id), ['a']);
});

test('新工具沒有下載次數時初始為 undefined，由統計排程填入', () => {
  const merged = mergeToolStore([], [{ id: 'new', version: 'v1' }] as any[]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'new');
});

test('自動建立的條目帶有腳本名稱與描述，網站才不會顯示空白', () => {
  const disk = [{
    fileName: 'brand-new.user.js',
    version: 'v1.0',
    name: '全新工具',
    description: '自動發現的說明',
  }] as any;

  const [entry] = reconcile([], disk);

  assert.equal(entry.name, '全新工具');
  assert.equal(entry.description, '自動發現的說明');
  assert.equal(entry.category, 'Tampermonkey');
});
