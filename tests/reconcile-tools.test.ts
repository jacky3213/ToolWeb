import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../lib/reconcile-tools.ts';

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
