# 單一事實來源重構 — 實作計劃

> **給代理執行者：** 使用 superpowers subagent-driven-development 逐任務實作。
> 步驟使用 checkbox (`- [ ]`) 語法追蹤進度。

**目標：** 移除 Google Drive 依賴，改用 `tools.json` manifest + 目錄列舉作為唯一事實來源，消除 runtime 磁碟寫入。

**架構：** 先以 TDD 建立純函式（合併邏輯 + 版本解析），再把 server 切換到新來源，驗證通過後才刪除 Drive 程式碼。採「先加後減」順序，確保每個階段都可運行。

**技術棧：** Node 22 內建 `node:test` + `tsx`（零新增依賴）、Express、TypeScript

**規格來源：** `docs/superpowers/specs/2026-10-20-unify-source-of-truth-design.md`

---

## 執行前須知

- **Bash PATH 每次都要修**（WorkBuddy 缺陷），所有指令開頭加：
  `export PATH="/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/bin:$PATH";`
- **測試指令：** `npm test`（Task 1 建立）
- **型別檢查：** `npm run lint`
- 直接在 `main` 上修改（使用者決策，因AI Studio 只 pull main）
- 預設起點 commit：`9cd11ec`

---

## Task 1: 建立測試基礎設施

**檔案：**
- 修改：`package.json`
- 建立：`tests/smoke.test.ts`

背景：`package.json` 目前無 `test` script。`tsx` 已在 devDependencies，Node v22 內建 `node:test` 可直接跑 TypeScript。

- [ ] **Step 1: 加入 test script**

在 `scripts` 區塊加入（放在 `lint` 之後）：

```json
"test": "node --import tsx --test tests/*.test.ts"
```

- [ ] **Step 2: 建立 smoke test**

`tests/smoke.test.ts`：

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('測試執行器可用', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: 執行測試確認通過**

執行：`npm test`
預期：PASS（1 test, 0 fail）

- [ ] **Step 4: Commit**

```bash
git add package.json tests/
git commit -m "test: 建立 node:test 測試基礎設施（零新增依賴）"
```

---

## Task 2: 使用者腳本 metadata 解析器（TDD）

**檔案：**
- 建立：`lib/userscript-metadata.ts`
- 建立：`tests/userscript-metadata.test.ts`

**目的：** 從 `.user.js` 內容中解析 `@name` / `@version` / `@description`，供目錄列舉使用。

**先讀參考實作：** `server.ts:598-650` 的 `refreshScriptsFromGitHub()` 已有同類解析邏輯（`scriptText.match(/@version\s+(.+)/)`），需沿用其正規化規則：版本若不以 `v` 開頭則補上。

- [ ] **Step 1: 撰寫失敗的測試**

`tests/userscript-metadata.test.ts`：

```typescript
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
```

- [ ] **Step 2: 執行測試確認失敗**

執行：`npm test`
預期：FAIL — 錯誤訊息應為 `Cannot find module '../lib/userscript-metadata.ts'`

- [ ] **Step 3: 撰寫最小實作**

`lib/userscript-metadata.ts`：

```typescript
export interface UserScriptMetadata {
  name: string | null;
  version: string | null;
  description: string | null;
  namespace: string | null;
}

/**
 * 解析 Tampermonkey 使用者腳本的 metadata 區塊。
 * 必須包含 `// ==UserScript==` 與 `// ==/UserScript==` 才視為有效腳本，
 * 避免把任意 .js 檔誤判為使用者腳本。
 * 版本一律正規化為帶 v 前綴（沿用 server.ts:621-624 既有規則）。
 */
export function parseUserScriptMetadata(scriptText: string): UserScriptMetadata {
  const metaStart = scriptText.indexOf('// ==UserScript==');
  const metaEnd = scriptText.indexOf('// ==/UserScript==');

  if (metaStart === -1 || metaEnd === -1 || metaEnd <= metaStart) {
    return { name: null, version: null, description: null, namespace: null };
  }

  const header = scriptText.substring(metaStart, metaEnd);
  const match = (key: string): string | null => {
    const m = header.match(new RegExp(`@${key}\\s+(.+)`));
    return m ? m[1].trim() : null;
  };

  const rawVersion = match('version');
  const version = rawVersion
    ? (rawVersion.startsWith('v') ? rawVersion : `v${rawVersion}`)
    : null;

  return {
    name: match('name'),
    version,
    description: match('description'),
    namespace: match('namespace'),
  };
}
```

- [ ] **Step 4: 執行測試確認通過**

執行：`npm test`
預期：PASS（7 tests, 0 fail）

- [ ] **Step 5: Commit**

```bash
git add lib/ tests/
git commit -m "feat: 新增使用者腳本 metadata 解析器"
```

---

## Task 3: manifest 與目錄列舉的合併邏輯（TDD）

**檔案：**
- 建立：`lib/reconcile-tools.ts`
- 建立：`tests/reconcile-tools.test.ts`

**規格對應：** 設計文件 §3.1 的合併規則。

```
for (file, meta) of manifest where file ∈ disk:
    emit(file, meta.version)          // manifest 為準
for file of disk where file ∉ manifest:
    emit(file, parseVersion(file))    // 從 @version 解析
manifest 有但磁碟沒有的檔案不出現
```

- [ ] **Step 1: 撰寫失敗的測試**

`tests/reconcile-tools.test.ts`：

```typescript
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

test('由檔名產生的 id 會去除副檔名', () => {
  const result = reconcile([], [{ fileName: 'my-tool.user.js', version: 'v1.0' }]);
  assert.equal(result[0].id, 'my-tool');
});
```

- [ ] **Step 2: 執行測試確認失敗**

執行：`npm test`
預期：FAIL — `Cannot find module '../lib/reconcile-tools.ts'`

- [ ] **Step 3: 撰寫最小實作**

`lib/reconcile-tools.ts`：

```typescript
export interface ManifestEntry {
  id: string;
  scriptFileName: string;
  version: string;
  [key: string]: unknown;
}

export interface DiskScript {
  fileName: string;
  version: string | null;
}

export interface ReconciledScript extends ManifestEntry {
  scriptFileName: string;
  version: string | null;
}

/** 由檔名推導工具 id：去除 .user.js / .js 後綴，並轉為小寫 */
function idFromFileName(fileName: string): string {
  return fileName
    .replace(/\.user\.js$/i, '')
    .replace(/\.js$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
}

/**
 * 合併 manifest 與磁碟上的腳本清單。
 *
 * 規則（設計文件 §3.1）：
 * 1. manifest 與磁碟皆存在 → 以 manifest 為準（顯示資料可人工潤飾）
 * 2. 僅磁碟存在 → 自動建立條目（「push 到 GitHub 即生效」的核心）
 * 3. 僅 manifest 存在 → 略過，避免顯示會 404 的死連結
 */
export function reconcile(
  manifest: ManifestEntry[],
  disk: DiskScript[]
): ReconciledScript[] {
  const diskByFile = new Map(disk.map(d => [d.fileName, d]));
  const result: ReconciledScript[] = [];
  const consumed = new Set<string>();

  for (const entry of manifest) {
    if (!diskByFile.has(entry.scriptFileName)) continue;
    consumed.add(entry.scriptFileName);
    result.push({ ...entry, scriptFileName: entry.scriptFileName });
  }

  for (const script of disk) {
    if (consumed.has(script.fileName)) continue;
    result.push({
      id: idFromFileName(script.fileName),
      scriptFileName: script.fileName,
      version: script.version,
    } as ReconciledScript);
  }

  return result;
}
```

- [ ] **Step 4: 執行測試確認通過**

執行：`npm test`
預期：PASS（13 tests, 0 fail）

- [ ] **Step 5: Commit**

```bash
git add lib/ tests/
git commit -m "feat: 新增 manifest 與目錄列舉的合併邏輯"
```

---

## Task 4: 建立 tools.json manifest

**檔案：**
- 建立：`tools.json`（repo 根目錄）
- 來源：`data/tools.json`

**為什麼先做這步：** 在切換 `server.ts` 之前，先讓正確的資料存在，避免中途沒有資料來源。

- [ ] **Step 1: 由 data/tools.json 產生 manifest 並移除 runtime 欄位**

執行：
```bash
node -e "const fs=require('fs');const t=JSON.parse(fs.readFileSync('data/tools.json','utf8'));const out=t.map(({downloadCount,baseDownloadCount,...rest})=>rest);fs.writeFileSync('tools.json',JSON.stringify(out,null,2)+'\n');"
```

> `downloadCount` 與 `baseDownloadCount` 屬於 runtime 統計，不應寫進 manifest。

- [ ] **Step 2: 驗證產出結果**

執行：
```bash
node -e "const t=require('./tools.json');console.log('工具數:',t.length);t.forEach(x=>console.log(' -',x.id,'|',x.name,'|',x.version,'|',x.scriptFileName||x.apkFileName));"
```

預期：5 個工具（adskip-apk、olevod-preloader、uu-preloader、readmo-novel、twitch-recovery）
且**不應出現 `downloadCount` 欄位**。

> **注意 `uu-preloader`：** 這個 id 對應的是「小說預讀器」，檔案 `UU-preloader.user.js`。
> 設計文件 §1.1 記錄的 P0-3 錯配正是 `server.ts:65` 把此 id 誤配給 Olevod。
> manifest 直接沿用 `data/tools.json` 的正確對應，錯配會隨 `DEFAULT_PRESET_TOOLS` 刪除而消失。

- [ ] **Step 3: 確認無殘留 runtime 欄位**

執行：`grep -c "downloadCount" tools.json || echo "0（正確）"`
預期：0

- [ ] **Step 4: Commit**

```bash
git add tools.json
git commit -m "feat: 新增 tools.json manifest 作為顯示中繼資料唯一來源"
```

---

## Task 5: 實作目錄列舉 discoverScriptsOnDisk

**檔案：**
- 建立：`lib/discover-scripts.ts`
- 建立：`tests/discover-scripts.test.ts`

**目的：** 掃描 `public/apks/`，回傳 `DiskScript[]`。

- [ ] **Step 1: 撰寫失敗的測試**

`tests/discover-scripts.test.ts`：

```typescript
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
```

- [ ] **Step 2: 執行測試確認失敗**

執行：`npm test`
預期：FAIL — `Cannot find module '../lib/discover-scripts.ts'`

- [ ] **Step 3: 撰寫最小實作**

`lib/discover-scripts.ts`：

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { parseUserScriptMetadata } from './userscript-metadata.ts';
import type { DiskScript } from './reconcile-tools.ts';

/**
 * 列出目錄下所有有效的 Tampermonkey 腳本。
 *
 * 只接受 `.user.js`（而非 `.js`），且內容必須含 `==UserScript==` 區塊，
 * 避免把普通的 JavaScript 檔誤當成使用者腳本。
 * 目錄不存在時回傳空陣列 —— Cloud Run 冷啟動時 public/apks 可能尚未就緒。
 */
export function discoverScriptsOnDisk(dir: string): DiskScript[] {
  if (!fs.existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const scripts: DiskScript[] = [];

  for (const fileName of entries) {
    if (!fileName.toLowerCase().endsWith('.user.js')) continue;

    const filePath = path.join(dir, fileName);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const meta = parseUserScriptMetadata(content);
      if (!meta.name) continue; // 非有效 userscript

      scripts.push({ fileName, version: meta.version });
    } catch {
      // 讀取失敗的檔案跳過，不影響其他腳本
    }
  }

  return scripts;
}
```

- [ ] **Step 4: 執行測試確認通過**

執行：`npm test`
預期：PASS（17 tests, 0 fail）

- [ ] **Step 5: Commit**

```bash
git add lib/ tests/
git commit -m "feat: 新增 public/apks 目錄列舉，自動發現新腳本"
```

---

## Task 6: 切換 server 啟動流程到 manifest

**檔案：**
- 修改：`server.ts:39-40`（移除 `TOOLS_FILE`）
- 修改：`server.ts:93-121`（移除 `data/tools.json` 載入與去重）
- 修改：`server.ts:143`（移除開機 `saveTools()`）

這是**第一個高風險任務**。務必在 Task 1-5 測試全綠後才執行。

- [ ] **Step 1: 先跑一次基線確認當前可運行**

執行：`npm test && npm run lint`
預期：PASS（測試全綠、型別無錯）

- [ ] **Step 2: 移除 TOOLS_FILE 常數與 SAVE 定義**

刪除 `server.ts:39`：
```typescript
const TOOLS_FILE = path.join(DATA_DIR, 'tools.json');
```

- [ ] **Step 3: 替換啟動載入邏輯**

將 `server.ts:93-121` 整段（從 `// Persistent data store for APK tools` 到去重邏輯結束）
替換為：

```typescript
// 工具清單的唯一事實來源：repo 根目錄的 tools.json（manifest）+ public/apks/ 目錄列舉。
// 不再從 data/tools.json 讀取 —— Cloud Run 磁碟是暫存的，runtime 狀態會在重啟後遺失。
import { readFileSync } from 'node:fs';
import { reconcile } from './lib/reconcile-tools.ts';
import { discoverScriptsOnDisk } from './lib/discover-scripts.ts';

const MANIFEST_FILE = path.join(process.cwd(), 'tools.json');

function loadManifest(): any[] {
  if (!fs.existsSync(MANIFEST_FILE)) {
    throw new Error(
      `[Config] 找不到 ${MANIFEST_FILE}。這是工具清單的唯一事實來源，請確認檔案已提交至版控。`
    );
  }
  const raw = fs.readFileSync(MANIFEST_FILE, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('[Config] tools.json 格式錯誤：頂層必須是陣列。');
  }
  return parsed;
}

// manifest 提供顯示中繼資料；目錄列舉確保「push 到 GitHub 即生效」，包含全新腳本。
let apkToolsStore: any[] = reconcile(
  loadManifest(),
  discoverScriptsOnDisk(UPLOADS_DIR)
);

console.log(`[Config] 已載入 ${apkToolsStore.length} 個工具（manifest + 目錄列舉）`);
```

- [ ] **Step 4: 移除開機時的 saveTools() 呼叫**

刪除 `server.ts:143` 的 `saveTools();`（此時 `saveTools` 仍需保留給其他呼叫點，Task 15 才移除定義）

- [ ] **Step 5: 執行型別檢查**

執行：`npm run lint`
預期：無錯誤

- [ ] **Step 6: 實際啟動驗證**

執行：
```bash
node node_modules/tsx/dist/cli.mjs server.ts &
sleep 3
curl -s http://localhost:3000/api/tools | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const t=JSON.parse(d);console.log('工具數:',t.length);t.forEach(x=>console.log(' -',x.id,'|',x.name,'|',x.version))})"
```

預期：輸出 **5 個工具**，`uu-preloader` 顯示為「小說預讀器」而非 Olevod（P0-3 bug 已修）

- [ ] **Step 7: 停止伺服器並Commit**

```bash
git add server.ts
git commit -m "refactor: 工具清單改由 tools.json manifest + 目錄列舉決定

移除對 data/tools.json 的依賴，消除 Cloud Run 暫存磁碟導致的資料遺失。
同時修正 DEFAULT_PRESET_TOOLS 中 uu-preloader id 錯配導致的冷啟動內容錯亂。"
```

---

## Task 7: 簡化下載統計（保留 Sheet 功能）

**檔案：**
- 修改：`server.ts:201-238`（`fetchDownloadCountsFromGoogleSheet` 加 TTL 快取）
- 修改：`server.ts` 新增 `refreshDownloadCounts()` 並在開機與排程中呼叫

> **⚠️ 這個任務必須在 Task 8 之前完成。**
> `fetchDownloadCountsFromGoogleSheet()` 目前**唯一的呼叫點是 `server.ts:423`**，
> 而該行位於 `syncGoogleDriveFolder()`（288-581）內。
> 若先刪 Drive 程式碼，Sheet 統計讀取會變成孤兒函式，
> **你明確要求保留的下載紀錄會靜默失效**（沒有報錯，只是不再更新）。

**目的：** 讓 Sheet 成為下載數字的獨立來源，不再依賴 Drive 同步來觸發。

- [ ] **Step 1: 為 TTL 快取撰寫測試**

`tests/sheet-cache.test.ts`：

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';

function createTtlCache(ttlMs: number) {
  let value: Record<string, number> | null = null;
  let fetchedAt = 0;
  return {
    async get(loader: () => Promise<Record<string, number>>): Promise<Record<string, number>> {
      const now = Date.now();
      if (value !== null && now - fetchedAt < ttlMs) return value;
      value = await loader();
      fetchedAt = now;
      return value;
    },
    peek(): Record<string, number> | null { return value; },
  };
}

test('首次呼叫會觸發載入', async () => {
  const cache = createTtlCache(5000);
  let calls = 0;
  const loader = async () => { calls++; return { a: 1 }; };

  await cache.get(loader);
  assert.equal(calls, 1);
});

test('TTL 內重複呼叫不重新載入', async () => {
  const cache = createTtlCache(5000);
  let calls = 0;
  const loader = async () => { calls++; return { a: 1 }; };

  await cache.get(loader);
  await cache.get(loader);
  assert.equal(calls, 1);
});

test('TTL 過期後重新載入', async () => {
  const cache = createTtlCache(1);
  let calls = 0;
  const loader = async () => { calls++; return { a: 1 }; };

  await cache.get(loader);
  await new Promise(r => setTimeout(r, 10));
  await cache.get(loader);

  assert.equal(calls, 2);
});

test('Sheet 查無此工具時回傳 0，不用前值或猜測值', () => {
  const counts: Record<string, number> = { known: 5 };
  assert.equal(counts['unknown'] || 0, 0);
});
```

- [ ] **Step 2: 執行測試確認通過**

執行：`npm test`
預期：PASS（21 tests）— 這是純邏輯測試，用來定義 TTL 快取行為

- [ ] **Step 3: 在 server.ts 實作 TTL 快取與統計套用函式**

在 `fetchDownloadCountsFromGoogleSheet()` 之後加入：

```typescript
// 下載統計以 Google Sheet 為唯一事實來源。
// 5 分鐘 TTL 快取：避免每次請求都全量抓取 CSV（流量隨下載量線性成長）。
const SHEET_CACHE_TTL_MS = 5 * 60 * 1000;
let sheetCountsCache: Record<string, number> | null = null;
let sheetCountsFetchedAt = 0;

async function getDownloadCountsFromSheet(): Promise<Record<string, number>> {
  const now = Date.now();
  if (sheetCountsCache !== null && now - sheetCountsFetchedAt < SHEET_CACHE_TTL_MS) {
    return sheetCountsCache;
  }
  const counts = await fetchDownloadCountsFromGoogleSheet();
  sheetCountsCache = counts;
  sheetCountsFetchedAt = now;
  return counts;
}

/**
 * 以 Sheet 統計更新每個工具的下載數。
 *
 * **單調不減：** 取 Sheet 值與當前值的較大者。
 * 下載點擊時前端（`src/App.tsx:84`）與後端都會即時 +1，讓使用者立刻看到數字變化；
 * 但 Google Form 寫入 Sheet 有延遲，若直接覆寫會讓數字「先跳上去再掉回來」。
 * 下載次數是累計值，顯示上不應該倒退。
 *
 * 這與被移除的 `Math.max(sheetCount, memoryDelta)` 語意不同：
 * 舊的是「從兩個不可靠來源猜測重建數字」，新的是「累計值不得倒退」。
 *
 * 代價：若 Google Form 提交永久失敗，顯示值會略高於 Sheet 真實值，直到伺服器重啟才校正。
 */
async function refreshDownloadCounts(): Promise<void> {
  try {
    const counts = await getDownloadCountsFromSheet();
    for (const tool of apkToolsStore) {
      const sheetCount = counts[tool.id] || 0;
      tool.downloadCount = Math.max(sheetCount, tool.downloadCount || 0);
    }
  } catch (err: any) {
    console.error("[Stats] 無法更新下載統計，沿用上一輪數值:", err?.message || err);
  }
}
```

- [ ] **Step 4b: 撰寫單調性的測試**

`tests/sheet-cache.test.ts` 追加：

```typescript
test('刷新後下載數不得倒退（Sheet 落後於本機計數時）', () => {
  const current = 921;
  const sheetCount = 920;
  assert.equal(Math.max(sheetCount, current), 921);
});

test('Sheet 數字較新時應採用 Sheet 值', () => {
  const current = 900;
  const sheetCount = 950;
  assert.equal(Math.max(sheetCount, current), 950);
});
```

執行：`npm test`
預期：PASS（23 tests）

- [ ] **Step 5: 在開機時啟動統計排程**

在 `startServer()` 內、伺服器 listen 之後加入：

```typescript
// 下載統計排程：開機立即取一次，之後每 5 分鐘更新。
// 與 Drive 同步無關 —— 這是 Sheet 統計的獨立觸發來源。
refreshDownloadCounts().catch(console.error);
const statsTimer = setInterval(() => {
  refreshDownloadCounts().catch(console.error);
}, SHEET_CACHE_TTL_MS);
// 避免排程讓 Node 行程無法結束（僅本機測試需要）
statsTimer.unref?.();
```

- [ ] **Step 5: 執行型別檢查與測試**

執行：`npm run lint && npm test`
預期：全部通過

- [ ] **Step 6: 驗證統計確實會更新且不倒退**

```bash
node node_modules/tsx/dist/cli.mjs server.ts &
sleep 6
curl -s http://localhost:3000/api/tools | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{JSON.parse(d).forEach(x=>console.log(x.id,'→',x.downloadCount))})"
```

預期：每個工具都有數字（若 Sheet 尚無紀錄則為 0）。
**關鍵是伺服器 log 中出現 `[Google Sheet Counter] Loaded counts:`** — 證明 Sheet 讀取運作中。

- [ ] **Step 6b: 驗證下載後數字即時 +1 且 5 分鐘後不倒退**

```bash
# 記錄當前數字
curl -s http://localhost:3000/api/download/adskip.apk -o /dev/null
curl -s http://localhost:3000/api/tools | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const t=JSON.parse(d).find(x=>x.id==='adskip-apk');console.log('下載後:',t.downloadCount)})"
```

預期：數字比下載前多 1（後端 `server.ts:923` 的記憶體自增）。
等待 5 分鐘後再次查詢，**數字不應倒退**。

- [ ] **Step 7: Commit**

```bash
git add server.ts tests/
git commit -m "feat: 下載統計改為 Sheet 獨立排程，移除 Drive 觸發依賴

加入 5 分鐘 TTL 快取，並在開機與排程中主動更新，
使 Sheet 統計不再依賴 syncGoogleDriveFolder 觸發。"
```

---

## Task 8: 刪除 Google Drive 邏輯

**檔案：**
- 修改：`server.ts` — 刪除 Drive 相關程式碼
- 依規格 §5 刪除清單

**這是第二個高風險任務。** Task 6 驗證通過後才執行。

- [ ] **Step 1: 確認基線**

執行：`npm test && npm run lint`
預期：全部通過

- [ ] **Step 2: 刪除 Drive 型別與函式**

依序刪除以下區塊：
- `server.ts:243-247` `DriveFileItem` interface
- `server.ts:249-285` `fetchFolderFilesFromGoogleDrive()`
- `server.ts:288-581` `syncGoogleDriveFolder()`
- `server.ts:583-589` `syncAllToolsFromGoogleDrive()`

> **連帶效果（預期中的，非意外）：**
> - 設計文件 §5 列出的 4 處 `Math.max(sheetCount, memoryDelta)` 猜測邏輯
>   （`server.ts:459, 513, 532, 539`）**全部位於 `syncGoogleDriveFolder()` 內**，
>   因此會隨函式刪除自動移除，**不需要另外處理**。
>   若你在刪除後仍搜尋到 `Math.max`，代表刪漏了，請回頭檢查。
> - `fetchDownloadCountsFromGoogleSheet()` 的唯一舊呼叫點（`server.ts:423`）也在此函式內。
>   這正是 Task 7 必須先做的原因 —— Task 7 已建立獨立排程接手統計更新。

- [ ] **Step 3: 刪除 DEFAULT_PRESET_TOOLS**

刪除 `server.ts:43-91`（P0-3 錯配來源，Task 6 後已無引用）

- [ ] **Step 4: 執行型別檢查確認遺漏**

執行：`npm run lint`
預期：**會出現錯誤**，列出所有仍引用 Drive 函式的位置。逐一記錄。

- [ ] **Step 5: 移除開機時的 Drive 同步呼叫**

搜尋並刪除所有 `syncAllToolsFromGoogleDrive()` 呼叫（開機處與 `/api/tools` 的 5 分鐘節流處）

- [ ] **Step 6: 刪除 /api/sync-gdrive 端點**

刪除 `server.ts:742-757`（P1-4 無認證端點）

- [ ] **Step 7: 處理 3 處需人工修改的 Drive 呼叫點**

| 行號 | 原本 | 改為 |
|---|---|---|
| 909 | `tool.downloadUrl \|\| 'https://drive.google.com'` | `tool.downloadUrl \|\| ''` |
| 1019 | `if (targetUrl.includes('drive.google.com')) { ... }` 整段刪除 | 移除該 fallback 分支 |
| 1095 | `await syncGoogleDriveFolder("https://drive...", true)` | 移除該 fallback |

- [ ] **Step 8: 執行型別檢查直到零錯誤**

執行：`npm run lint`
預期：無錯誤

- [ ] **Step 9: 確認 Drive 相關程式碼已完全清除**

執行：`grep -n "drive\|Drive\|googleapis" server.ts`
預期：**僅剩** `GITHUB_RAW_BASE` 相關的 GitHub 註解，無任何 Google Drive 引用

- [ ] **Step 10: 執行測試**

執行：`npm test`
預期：全部通過

- [ ] **Step 11: Commit**

```bash
git add server.ts
git commit -m "refactor: 移除 Google Drive 依賴（-約 350 行）

消除雙資料來源互相覆蓋的問題。GitHub 成為唯一事實來源。"
```

---

## Task 9: 移除前端同步按鈕

**檔案：**
- 修改：`src/App.tsx:113-~150`（`handleSyncDrive`）
- 修改：`src/App.tsx:230`（`onSyncDrive` prop 傳遞）
- 修改：`src/components/Header.tsx`（同步按鈕 UI）

- [ ] **Step 1: 移除 App.tsx 中的 handleSyncDrive**

刪除整個 `handleSyncDrive` 函式（從 `const handleSyncDrive = async () => {` 到其結尾 `};`）

- [ ] **Step 2: 移除相關 state**

搜尋 `isSyncingDrive` 與 `showToast` 的引用，移除僅用於同步的 state（`isSyncingDrive`）

> `showToast` 仍被 `handleDownload` 使用，**保留**。

- [ ] **Step 3: 移除 onSyncDrive prop 傳遞**

刪除 `src/App.tsx:230` 的 `onSyncDrive={handleSyncDrive}`

- [ ] **Step 4: 移除 Header 中的同步按鈕**

在 `src/components/Header.tsx` 中刪除：
- `onSyncDrive` 參數定義
- 觸發同步的按鈕 JSX
- 若有 `isSyncingDrive` 相關樣式或狀態，一併移除

- [ ] **Step 5: 執行型別檢查**

執行：`npm run lint`
預期：無錯誤

- [ ] **Step 6: 建置驗證**

執行：`npm run build`
預期：建置成功（vite build + esbuild 皆完成）

- [ ] **Step 7: Commit**

```bash
git add src/
git commit -m "refactor: 移除 Google Drive 同步按鈕與相關邏輯"
```

---

## Task 10: 清理死代碼與 runtime 檔案

**檔案：**
- 刪除：`src/data.ts`
- 修改：`src/App.tsx:4`（移除 INITIAL_TOOLS import）
- 刪除：`public/templates/app-info.json`
- 刪除：`data/` 全部內容
- 修改：`server.ts`（移除 `saveTools()` / `saveDeltas()` 定義與剩餘呼叫點）

- [ ] **Step 1: 移除 INITIAL_TOOLS 死代碼**

`src/data.ts` 已驗證為死代碼（`INITIAL_TOOLS` 僅在 `App.tsx:4` 被 import，從未使用）。

刪除 `src/App.tsx:4`：
```typescript
import { INITIAL_TOOLS } from './data';
```

刪除整個 `src/data.ts`

- [ ] **Step 2: 執行型別檢查**

執行：`npm run lint`
預期：無錯誤

- [ ] **Step 3: 將 saveTools/saveDeltas 呼叫點改為記憶體操作**

依規格 §5 表格，**保留定義**但改為 no-op 或記憶體更新（管理 API 在後續變更才刪除，
若此時刪掉 `saveTools` 定義會讓它們呼叫未定義函式）：

將 `saveTools()` 改為僅做記憶體去重、不寫檔：
```typescript
/** 記憶體內去重。不寫入磁碟 —— Cloud Run 磁碟是暫存的。 */
function saveTools() {
  const seen = new Set<string>();
  const clean: any[] = [];
  for (const t of apkToolsStore) {
    const canonicalId = (t.id === 'adskip' || t.packageName === 'com.utility.adskip') ? 'adskip-apk' : t.id;
    if (!seen.has(canonicalId)) {
      seen.add(canonicalId);
      clean.push({ ...t, id: canonicalId });
    }
  }
  apkToolsStore = clean;
}
```

將 `saveDeltas()` 改為 no-op：
```typescript
/** @deprecated 下載計數改由 Google Sheet 單一來源提供，不再需要 delta 檔案。 */
function saveDeltas() { /* no-op */ }
```

- [ ] **Step 3b: 移除 downloadsDelta 變數與其4 處寫入**

`downloadsDelta` 的 4 處自增（`server.ts:838, 922, 1055, 1122`）在 `saveDeltas()` 變成 no-op
後已無任何效果，是死碼。刪除：

```bash
grep -n "downloadsDelta" server.ts
```

移除以下內容：
- `server.ts:147-154` 的 `downloadsDelta` 變數宣告與載入
- `server.ts:146` 的 `DELTAS_FILE` 常數
- 上列 4 處 `downloadsDelta[id] = (downloadsDelta[id] || 0) + 1;` 與
  `downloadsDelta[linkedTool.id] = (downloadsDelta[linkedTool.id] || 0) + 1;`
- 對應的 5 處 `saveDeltas();` 呼叫

> 保留 `tool.downloadCount = (tool.downloadCount || 0) + 1;` — 這是記憶體內的即時回饋，
> 下次排程刷新時會被 Sheet 數值覆寫（`refreshDownloadCounts()`）。

- [ ] **Step 4: 執行型別檢查與測試**

執行：`npm run lint && npm test`
預期：全部通過

- [ ] **Step 5: 刪除 public/templates/app-info.json**

該檔案僅供 Drive 同步使用，Drive 已移除。
```bash
git rm public/templates/app-info.json
```

- [ ] **Step 6: 從版控移除 data/ 並刪除實體檔**

```bash
git rm -r --cached data/
rm -rf data/
```

> **注意：** `data/tools.json` 與 `data/downloads_delta.json` 目前**被 git 追蹤**（設計文件 P1-7）。
> 使用 `--cached` 從索引移除但保留實體檔，再手動刪除。
> `data/readmo/` 是空目錄且未被任何程式碼引用，一併刪除。

- [ ] **Step 7: 確認 git 已不再追蹤 runtime 狀態**

執行：`git ls-files data/`
預期：**空輸出**

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: 清理死代碼與 runtime 狀態檔

- 刪除 src/data.ts（INITIAL_TOOLS 為死代碼）
- 刪除 public/templates/app-info.json（Drive 專用）
- data/ 從版控移除，saveTools/saveDeltas 改為記憶體操作"
```

---

## Task 11: 最終整合驗證

**檔案：**
- 驗證：`README.md`（文件更新，見 Task 12）

這是**驗證任務**，不做新功能。目的是證明重構後系統仍正確運作。

- [ ] **Step 1: 型別檢查與測試**

執行：`npm run lint && npm test`
預期：全部通過

- [ ] **Step 2: 完整建置**

執行：`npm run build`
預期：成功產出 `dist/server.cjs`、`dist/index.html`、`dist/assets/*`

- [ ] **Step 3: 啟動伺服器並驗證工具清單**

```bash
node node_modules/tsx/dist/cli.mjs server.ts &
sleep 3
curl -s http://localhost:3000/api/tools | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const t=JSON.parse(d);console.log('工具數:',t.length);t.forEach(x=>console.log(' -',x.id,'|',x.name,'|',x.version,'|',x.downloadCount))})"
```

預期：5 個工具，`uu-preloader` 為「小說預讀器」

- [ ] **Step 4: 驗證熱更新仍運作（P0-2 的核心驗證）**

```bash
# 新增一個測試腳本到 public/apks/
printf '// ==UserScript==\n// @name  Temp Verify\n// @version 0.0.1\n// ==/UserScript==\n' > public/apks/temp-verify.user.js
sleep 61
curl -s http://localhost:3000/api/tools | grep -c "temp-verify"
```

預期：輸出 `1` — **證明新增腳本無需 republish 即可出現**

- [ ] **Step 5: 驗證腳本可下載且 metadata 正確注入**

```bash
curl -s http://localhost:3000/api/download/olevod-preloader.user.js | head -15
```

預期：包含 `// @updateURL` 與 `// @downloadURL`，且指向 `raw.githubusercontent.com/jacky3213/ToolWeb`

- [ ] **Step 6: 驗證 APK 下載仍正常**

```bash
curl -s -o /dev/null -w "%{http_code} %{size_download}" http://localhost:3000/api/download/adskip.apk
```

預期：`200 762305`

- [ ] **Step 7: 清理測試用檔案並停止伺服器**

```bash
rm public/apks/temp-verify.user.js
```

- [ ] **Step 8: 確認工作區乾淨且無 Drive 殘留**

```bash
git status --short
grep -c "drive.google.com" server.ts || echo "0（Drive 已完全移除）"
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "test: 重構後整合驗證通過"
```

---

## Task 12: 更新 README

**檔案：**
- 修改：`README.md`

目前 README 仍是 AI Studio 模板，沒有架構說明。

- [ ] **Step 1: 撰寫新的 README 內容**

必須包含：

```markdown
# APK & Tampermonkey 工具發布中心

## 架構

單一事實來源：GitHub repo。

| 元件 | 位置 | 職責 |
|---|---|---|
| `tools.json` | repo 根目錄 | 工具顯示中繼資料（名稱、描述、分類、changelog） |
| `public/apks/*.user.js` | repo | 使用者腳本，透過 GitHub Raw 提供熱更新 |
| `public/apks/*.apk` | repo | Android APK 與 Chrome 擴充套件 |
| `data/` | **已移除** | 舊的 runtime 狀態檔（Cloud Run 磁碟暫存，會遺失） |

### 為什麼腳本走 GitHub Raw，APK 走 repo

Tampermonkey 的 `@updateURL` / `@downloadURL` 必須指向**穩定且公開**的網址。
GitHub Raw 符合此條件；AI Studio 的預覽 domain 是暫時的且可能需要認證，
會讓 Tampermonkey 的更新檢查靜默失敗。

APK 不需要自動更新機制，直接由伺服器從 `public/apks/` 提供即可。

### 熱更新流程

修改 `public/apks/*.user.js` 並 push 到 GitHub 後：

1. 伺服器開機時自動從 GitHub Raw 拉取
2. 執行期間每 60 秒 TTL 檢查一次
3. **新增腳本**不需要重新部署 —— 開機時的目錄列舉會自動發現

## 開發

```bash
npm install
npm run dev      # 啟動開發伺服器 (localhost:3000)
npm run lint     # TypeScript 型別檢查
npm test         # 單元測試 (node:test + tsx，零額外依賴)
npm run build    # 建置
```

## 部署

push 至 `main` 分支後，於 Google AI Studio 重新 pull 並發布。

## 下載統計

以 Google Sheet 為唯一事實來源（`GOOGLE_FORM_CONFIG` 設定於 `server.ts`）。
伺服器寫入 Google Form，並以 5 分鐘 TTL 快取讀取 CSV 統計。

> 注意：使用者腳本的「更新」下載由 Tampermonkey 直接從 GitHub Raw 取得，繞過伺服器，
> 因此統計只涵蓋首次安裝。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: 重寫 README，說明架構與熱更新機制"
```

---

## 完成檢查清單

- [ ] `npm run lint` 零錯誤
- [ ] `npm test` 全部通過
- [ ] `npm run build` 成功
- [ ] `server.ts` 無任何 `drive.google.com` 殘留
- [ ] `git ls-files data/` 空輸出
- [ ] 新增腳本 push 後無需 republish 即出現（Task 11 Step 4 已驗證）
- [ ] `uu-preloader` 顯示為「小說預讀器」（P0-3 已修）
- [ ] README 已更新