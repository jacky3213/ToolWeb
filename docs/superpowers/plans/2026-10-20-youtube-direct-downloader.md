# YouTube 直連下載腳本 實作計劃

> **給代理執行者：** 使用 superpowers subagent-driven-development 逐任務實作。
> 步驟使用 checkbox (`- [ ]`) 語法追蹤進度。

**目標：** 從零打造 Tampermonkey 腳本，在瀏覽器內直接下載 YouTube 影片（含 Shorts、SABR），音視頻無損合併，產物發布至 ToolWeb。

**架構：** youtubei.js 自建 InnerTube session 取得多客戶端格式資訊（頁面 player response 後備）→ decipher 解密直連 URL / SabrStream 串流 → Range 並發下載 → mediabunny 無損 mux → File System Access API 串流寫盤（Blob 退回）。esbuild 打包成單一 user.js。

**技術棧：** youtubei.js 18.x（`youtubei.js/web`）、googlevideo 4.x（`googlevideo/sabr-stream`）、mediabunny 1.x、esbuild、node:test。

**規格：** `docs/superpowers/specs/2026-10-20-youtube-direct-downloader-design.md`

**重要執行事項：**
- 所有路徑相對於 repo 根 `D:\ToolWeb`。
- 第三方庫 API 簽名若與本計劃程式碼有出入，以 `userscripts/youtube-direct-downloader/node_modules/<pkg>/` 內的 `.d.ts` / README 為準，**先查再寫**。
- 每個任務結束必須 commit（在 feature branch 上）。
- 純邏輯模組走完整 TDD（RED → GREEN）；瀏覽器/DOM 模組以 build 通過 + 手動清單驗證。

---

## Task 1: 子專案腳手架與 build 打通

**檔案：**
- 建立：`userscripts/youtube-direct-downloader/package.json`
- 建立：`userscripts/youtube-direct-downloader/build.mjs`
- 建立：`userscripts/youtube-direct-downloader/src/main.js`（樁）
- 修改：`.gitignore`（repo 根）

- [ ] **Step 1: 建立 package.json**
  ```json
  {
    "name": "youtube-direct-downloader",
    "version": "0.1.0",
    "license": "MIT",
    "private": true,
    "type": "module",
    "scripts": {
      "test": "node --test tests/*.test.mjs",
      "build": "node build.mjs"
    },
    "dependencies": {
      "googlevideo": "^4.1.1",
      "mediabunny": "1.61.6",
      "youtubei.js": "18.2.0"
    },
    "devDependencies": {
      "esbuild": "0.28.2"
    }
  }
  ```

- [ ] **Step 2: .gitignore 加入子專案 node_modules**
  在 repo 根 `.gitignore` 追加一行：
  ```
  userscripts/*/node_modules/
  ```

- [ ] **Step 3: 建立使用者腳本 header 產生器 + build.mjs**
  ```js
  // build.mjs
  import * as esbuild from 'esbuild';
  import { readFileSync } from 'node:fs';

  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

  const userscriptHeader = `// ==UserScript==
  // @name         YouTube 直連下載 (Direct Downloader)
  // @name:en      YouTube Direct Downloader
  // @namespace    https://github.com/jacky3213
  // @version      ${pkg.version}
  // @description  在瀏覽器內直接下載 YouTube 影片與 Shorts，音視頻無損合併，不經第三方解析站。僅供個人備份，請遵守著作權法與 YouTube 服務條款。
  // @description:en  Download YouTube videos & Shorts directly in the browser with lossless muxing. For personal backup only.
  // @author       jacky3213
  // @match        https://www.youtube.com/*
  // @match        https://m.youtube.com/*
  // @run-at       document-start
  // @noframes
  // @grant        unsafeWindow
  // @grant        GM_xmlhttpRequest
  // @grant        GM_setValue
  // @grant        GM_getValue
  // @connect      www.youtube.com
  // @connect      youtube.com
  // @connect      youtubei.googleapis.com
  // @connect      googlevideo.com
  // ==/UserScript==
  `;

  await esbuild.build({
    entryPoints: ['src/main.js'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120', 'firefox120'],
    minify: true,
    legalComments: 'inline',
    banner: { js: userscriptHeader },
    outfile: '../../public/apks/youtube-direct-downloader.user.js',
    logLevel: 'info',
  });
  ```

- [ ] **Step 4: main.js 樁**
  ```js
  // src/main.js
  console.log('[YT-DL] youtube-direct-downloader loaded, version placeholder');
  ```

- [ ] **Step 5: 安裝依賴並執行 build**
  ```bash
  cd userscripts/youtube-direct-downloader && npm install && npm run build
  ```
  預期：`public/apks/youtube-direct-downloader.user.js` 產生，檔頭含 `==UserScript==`，大小 > 500KB（依賴已打包）。若 esbuild 報 node 內建模組（`fs`/`path`/`crypto` 等）解析錯誤，檢查 import 是否誤入 node 子入口（必須用 `youtubei.js/web`，不得 import `youtubei.js` 根入口）。

- [ ] **Step 6: 驗證產物 header 完整**
  ```bash
  head -25 ../../public/apks/youtube-direct-downloader.user.js
  ```
  預期：看到 `@name`、`@version 0.1.0`、`@match`、`@grant`、`@connect`。

- [ ] **Step 7: Commit**
  ```bash
  git add userscripts/youtube-direct-downloader/package.json userscripts/youtube-direct-downloader/build.mjs userscripts/youtube-direct-downloader/src/main.js .gitignore public/apks/youtube-direct-downloader.user.js
  git commit -m "feat(ytdl): 子專案腳手架與 esbuild 打包管線"
  ```
  （package-lock.json 一併加入；node_modules 不入庫。）

---

## Task 2: formats.js — 格式純邏輯（TDD）

**檔案：**
- 建立：`src/formats.js`
- 測試：`tests/formats.test.mjs`

格式資料形狀（與 youtubei.js Format 物件相容的最低欄位）：
`{ itag, mime_type, has_video, has_audio, quality_label?, fps?, bitrate?, content_length?, language?, url?, cipher? }`

- [ ] **Step 1: 撰寫失敗的測試**
  ```js
  // tests/formats.test.mjs
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import {
    isGoogleVideoUrl, stripRangeParams, containerOf,
    pairVideoAudio, buildQualityList, pickAudioTrack,
  } from '../src/formats.js';

  test('isGoogleVideoUrl 接受合法網域並拒絕其他', () => {
    assert.equal(isGoogleVideoUrl('https://rr4---sn-xyz.googlevideo.com/videoplayback?x=1'), true);
    assert.equal(isGoogleVideoUrl('https://googlevideo.com/videoplayback'), true);
    assert.equal(isGoogleVideoUrl('https://evil.com/googlevideo.com'), false);
    assert.equal(isGoogleVideoUrl('https://googlevideo.com.evil.com/videoplayback'), false);
    assert.equal(isGoogleVideoUrl('not a url'), false);
  });

  test('stripRangeParams 移除 range/rn/rbuf 但保留其他參數', () => {
    const out = stripRangeParams('https://v.googlevideo.com/videoplayback?range=0-999&rn=1&rbuf=0&itag=140&mime=audio%2Fmp4');
    assert.ok(!out.includes('range='));
    assert.ok(!out.includes('rn='));
    assert.ok(!out.includes('rbuf='));
    assert.ok(out.includes('itag=140'));
  });

  test('containerOf 解析 mime type 容器', () => {
    assert.equal(containerOf('video/mp4; codecs="avc1.640028"'), 'mp4');
    assert.equal(containerOf('audio/webm; codecs="opus"'), 'webm');
  });

  test('pairVideoAudio 同容器優先、音軌取最高位元率', () => {
    const videos = [
      { itag: 137, has_video: true, has_audio: false, mime_type: 'video/mp4', quality_label: '1080p', bitrate: 2000 },
      { itag: 248, has_video: true, has_audio: false, mime_type: 'video/webm', quality_label: '1080p', bitrate: 1800 },
    ];
    const audios = [
      { itag: 251, has_audio: true, has_video: false, mime_type: 'audio/webm', bitrate: 160 },
      { itag: 140, has_audio: true, has_video: false, mime_type: 'audio/mp4', bitrate: 128 },
      { itag: 139, has_audio: true, has_video: false, mime_type: 'audio/mp4', bitrate: 48 },
    ];
    assert.deepEqual(pairVideoAudio(videos, audios), [
      { video: videos[0], audio: audios[1] }, // mp4 + 最高位元率 mp4 音軌(140)
      { video: videos[1], audio: audios[0] }, // webm + 唯一 webm 音軌(251)
    ]);
  });

  test('buildQualityList 依解析度/fps 降序、含漸進式與分離式、估算大小', () => {
    const formats = [
      { itag: 137, has_video: true, has_audio: false, mime_type: 'video/mp4', quality_label: '1080p', fps: 30, height: 1080, content_length: 900 },
      { itag: 140, has_audio: true, has_video: false, mime_type: 'audio/mp4', bitrate: 128, content_length: 100 },
      { itag: 22,  has_video: true, has_audio: true,  mime_type: 'video/mp4', quality_label: '720p', fps: 30, height: 720, content_length: 800 },
      { itag: 299, has_video: true, has_audio: false, mime_type: 'video/mp4', quality_label: '1080p', fps: 60, height: 1080, content_length: 1200 },
    ];
    const list = buildQualityList(formats, { audioLanguage: null });
    assert.equal(list.length, 3); // 1080p60、1080p30、720p(漸進)
    assert.equal(list[0].label, '1080p60');
    assert.equal(list[0].isProgressive, false);
    assert.equal(list[0].sizeBytes, 1200 + 100); // 視頻+配對音軌
    assert.equal(list[2].isProgressive, true);
    assert.equal(list[2].sizeBytes, 800);
  });

  test('pickAudioTrack 語言優先：指定語言 > 原聲 > 任一', () => {
    const tracks = [
      { itag: 140, mime_type: 'audio/mp4', language: 'ja', is_original: false, bitrate: 128 },
      { itag: 141, mime_type: 'audio/mp4', language: 'en', is_original: true,  bitrate: 256 },
    ];
    assert.equal(pickAudioTrack(tracks, 'ja').itag, 140);
    assert.equal(pickAudioTrack(tracks, 'zh-TW').itag, 141); // 無匹配 → 原聲
    assert.equal(pickAudioTrack(tracks, null).itag, 141);
  });
  ```

- [ ] **Step 2: 執行測試確認失敗**
  ```bash
  npm test
  ```
  預期：FAIL（模組不存在）。

- [ ] **Step 3: 撰寫最小實作**
  ```js
  // src/formats.js
  const GOOGLEVIDEO_HOST = /^([a-z0-9-]+\.)*googlevideo\.com$/i;

  export function isGoogleVideoUrl(rawUrl) {
    try { return GOOGLEVIDEO_HOST.test(new URL(rawUrl).hostname); }
    catch { return false; }
  }

  export function stripRangeParams(rawUrl) {
    const u = new URL(rawUrl);
    for (const p of ['range', 'rn', 'rbuf']) u.searchParams.delete(p);
    return u.toString();
  }

  export function containerOf(mimeType) {
    return String(mimeType).split('/')[1].split(';')[0].trim();
  }

  function pickAudioTrackImpl(audios) {
    return [...audios].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? null;
  }

  export function pickAudioTrack(audioFormats, preferredLang) {
    if (!audioFormats?.length) return null;
    if (preferredLang) {
      const exact = audioFormats.filter(f => f.language === preferredLang);
      if (exact.length) return pickAudioTrackImpl(exact);
    }
    const original = audioFormats.filter(f => f.is_original || !f.language);
    if (original.length) return pickAudioTrackImpl(original);
    return pickAudioTrackImpl(audioFormats);
  }

  export function pairVideoAudio(videoFormats, audioFormats) {
    const byContainer = new Map();
    for (const a of audioFormats) {
      const c = containerOf(a.mime_type);
      if (!byContainer.has(c)) byContainer.set(c, []);
      byContainer.get(c).push(a);
    }
    return videoFormats.map(v => ({
      video: v,
      audio: pickAudioTrackImpl(byContainer.get(containerOf(v.mime_type)) ?? audioFormats) ?? null,
    }));
  }

  export function buildQualityList(formats, { audioLanguage }) {
    const videoOnly = formats.filter(f => f.has_video && !f.has_audio);
    const audioOnly = formats.filter(f => f.has_audio && !f.has_video);
    const progressive = formats.filter(f => f.has_video && f.has_audio);
    const chosenAudio = audioLanguage != null
      ? pickAudioTrack(audioOnly, audioLanguage)
      : pickAudioTrackImpl(audioOnly);

    const entries = [];
    for (const p of progressive) {
      entries.push({
        label: p.quality_label ?? `${p.height ?? '?'}p`,
        isProgressive: true, videoFormat: p, audioFormat: null,
        container: containerOf(p.mime_type),
        sizeBytes: p.content_length ?? null,
        height: p.height ?? 0, fps: p.fps ?? 0,
      });
    }
    for (const { video, audio } of pairVideoAudio(videoOnly, chosenAudio ? [chosenAudio] : audioOnly)) {
      entries.push({
        label: (video.quality_label ?? `${video.height ?? '?'}p`) + (video.fps && video.fps !== 30 ? String(video.fps) : ''),
        isProgressive: false, videoFormat: video, audioFormat: audio,
        container: containerOf(video.mime_type),
        sizeBytes: (video.content_length ?? 0) + (audio?.content_length ?? 0) || null,
        height: video.height ?? 0, fps: video.fps ?? 0,
      });
    }
    // 降序：高度 → fps → 漸進式在後
    entries.sort((a, b) => (b.height - a.height) || (b.fps - a.fps) || (a.isProgressive ? 1 : -1));
    // 去除同 label 重複（同解析度不同 itag 保留第一個）
    const seen = new Set();
    return entries.filter(e => (seen.has(e.label) ? false : seen.add(e.label)));
  }
  ```

- [ ] **Step 4: 執行測試確認通過**
  ```bash
  npm test
  ```
  預期：全 PASS。

- [ ] **Step 5: Commit**
  ```bash
  git add src/formats.js tests/formats.test.mjs
  git commit -m "feat(ytdl): 格式配對/語言/畫質清單純邏輯（TDD）"
  ```

---

## Task 3: range-split.js — 分片數學（TDD）

**檔案：**
- 建立：`src/range-split.js`
- 測試：`tests/range-split.test.mjs`

- [ ] **Step 1: 撰寫失敗的測試**
  ```js
  // tests/range-split.test.mjs
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { splitRanges, formatBytes } from '../src/range-split.js';

  test('splitRanges 均勻切分', () => {
    assert.deepEqual(splitRanges(100, 40), [
      { start: 0, end: 39 }, { start: 40, end: 79 }, { start: 80, end: 99 },
    ]);
  });

  test('splitRanges 邊界：剛好整除、單片、無效輸入', () => {
    assert.deepEqual(splitRanges(80, 40), [{ start: 0, end: 39 }, { start: 40, end: 79 }]);
    assert.deepEqual(splitRanges(10, 40), [{ start: 0, end: 9 }]);
    assert.deepEqual(splitRanges(0, 40), []);
    assert.deepEqual(splitRanges(-5, 40), []);
    assert.deepEqual(splitRanges(NaN, 40), []);
  });

  test('formatBytes 人類可讀', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1.00 MB');
    assert.equal(formatBytes(1536), '1.50 MB');
    assert.equal(formatBytes(1024 ** 3), '1.00 GB');
  });
  ```

- [ ] **Step 2: 執行測試確認失敗**
  ```bash
  npm test
  ```
  預期：range-split 相關 FAIL。

- [ ] **Step 3: 最小實作**
  ```js
  // src/range-split.js
  export function splitRanges(totalSize, chunkSize) {
    if (!Number.isFinite(totalSize) || totalSize <= 0 || !Number.isFinite(chunkSize) || chunkSize <= 0) return [];
    const ranges = [];
    for (let start = 0; start < totalSize; start += chunkSize) {
      ranges.push({ start, end: Math.min(start + chunkSize, totalSize) - 1 });
    }
    return ranges;
  }

  export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '?';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes, i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return `${v.toFixed(2)} ${units[i]}`;
  }
  ```

- [ ] **Step 4: 執行測試確認通過**
  ```bash
  npm test
  ```
  預期：全 PASS。

- [ ] **Step 5: Commit**
  ```bash
  git add src/range-split.js tests/range-split.test.mjs
  git commit -m "feat(ytdl): Range 分片與大小格式化（TDD）"
  ```

---

## Task 4: gm-bridge.js — GM/頁面 fetch 統一適配

**檔案：**
- 建立：`src/gm-bridge.js`

說明：youtubei.js 需要一個 WHATWG fetch 形狀的函式；Tampermonkey sandbox 內頁面 fetch 帶 cookie 但受 CORS 限制，`GM_xmlhttpRequest` 跨域但無 cookie。InnerTube API 呼叫走 GM（帶基本 header），googlevideo 下載優先頁面 fetch（參考專案行為，保留 Origin 降低 bot 判定）。

- [ ] **Step 1: 實作**
  ```js
  // src/gm-bridge.js
  // GM fetch：把 GM_xmlhttpRequest 包成 fetch 形狀（供 youtubei.js 使用），支援 AbortSignal
  export function gmFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    return new Promise((resolve, reject) => {
      const handle = GM_xmlhttpRequest({
        method: init.method ?? 'GET',
        url,
        headers: init.headers ?? {},
        data: init.body ?? undefined,
        responseType: 'arraybuffer',
        onload: (res) => resolve(new Response(res.response, {
          status: res.status, statusText: res.statusText,
          headers: parseHeaders(res.responseHeaders),
        })),
        onerror: () => reject(new TypeError(`GM fetch failed: ${url}`)),
        ontimeout: () => reject(new TypeError(`GM fetch timeout: ${url}`)),
        onabort: () => reject(new DOMException('Aborted', 'AbortError')),
      });
      init.signal?.addEventListener('abort', () => handle?.abort?.(), { once: true });
    });
  }

  function parseHeaders(raw) {
    const h = new Headers();
    for (const line of String(raw ?? '').split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) h.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    }
    return h;
  }

  // 頁面原生 fetch（保留 cookie/Origin；googlevideo 下載優先用）
  export function pageFetch(input, init) {
    return unsafeWindow.fetch(input, init);
  }

  // googlevideo 專用：頁面 fetch 優先，失敗退 GM
  export async function mediaFetch(url, init) {
    try { return await pageFetch(url, init); }
    catch { return gmFetch(url, init); }
  }
  ```

- [ ] **Step 2: build 驗證（語法/打包層）**
  ```bash
  npm run build
  ```
  預期：成功（此模組尚無人 import，先確保可打包；或臨時在 main.js import 再 build）。

- [ ] **Step 3: Commit**
  ```bash
  git add src/gm-bridge.js
  git commit -m "feat(ytdl): GM_xmlhttpRequest 與頁面 fetch 適配層"
  ```

---

## Task 5: yt-client.js — session 與多客戶端資訊（評分邏輯 TDD）

**檔案：**
- 建立：`src/yt-client.js`（含純函式 `scoreInfoCandidate`）
- 測試：`tests/score-info.test.mjs`

- [ ] **Step 1: 撰寫失敗的測試（評分純函式）**
  ```js
  // tests/score-info.test.mjs
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { scoreInfoCandidate } from '../src/yt-client.js';

  const mk = (over = {}) => ({
    ok: true, client: 'WEB', error: null,
    hasDirectUrls: false, hasSabr: false, isLoginRequired: false, ...over,
  });

  test('評分：可 decipher 直連 URL > SABR > 失敗/需登入', () => {
    assert.ok(scoreInfoCandidate(mk({ hasDirectUrls: true })) > scoreInfoCandidate(mk({ hasSabr: true })));
    assert.ok(scoreInfoCandidate(mk({ hasSabr: true })) > scoreInfoCandidate(mk()));
    assert.equal(scoreInfoCandidate(mk({ ok: false })), -1);
    assert.equal(scoreInfoCandidate(mk({ isLoginRequired: true })), -1);
  });

  test('評分：同級時直連+可選格式多者勝出', () => {
    const a = mk({ hasDirectUrls: true, formatCount: 12 });
    const b = mk({ hasDirectUrls: true, formatCount: 5 });
    assert.ok(scoreInfoCandidate(a) > scoreInfoCandidate(b));
  });
  ```

- [ ] **Step 2: 執行測試確認失敗**
  ```bash
  npm test
  ```
  預期：FAIL（模組不存在）。

- [ ] **Step 3: 實作 yt-client.js**
  ```js
  // src/yt-client.js
  import { Innertube, Parser } from 'youtubei.js/web';
  import { isGoogleVideoUrl } from './formats.js';

  export const CLIENT_CANDIDATES = ['ANDROID_VR', 'ANDROID', 'TV_SIMPLY', 'WEB'];

  export function scoreInfoCandidate(c) {
    if (!c.ok || c.isLoginRequired) return -1;
    let s = 0;
    if (c.hasDirectUrls) s += 3;
    if (c.hasSabr) s += 2;
    s += Math.min((c.formatCount ?? 0) / 10, 1); // 最多 +1
    return s;
  }

  // 建立並快取 Innertube session（youtubei.js 自帶 visitor data / player 抓取）
  let sessionPromise = null;
  export function getYouTubeClient(gmFetch, { cookie } = {}) {
    sessionPromise ??= Innertube.create({
      fetch: gmFetch,
      retrieve_player: true,
      generate_session_locally: true,
      enable_session_cache: false,
      cookie,
    }).catch(err => { sessionPromise = null; throw err; });
    return sessionPromise;
  }

  // 單一客戶端嘗試；回傳候選描述（絕不 throw）
  async function probeClient(client, videoId, session) {
    try {
      const info = await session.getBasicInfo(videoId, { client });
      const streamData = info?.streaming_data;
      const formats = [...(info?.formats ?? []), ...(info?.adaptive_formats ?? [])];
      const hasDirectUrls = formats.some(f => f.url || f.cipher);
      return {
        ok: true, client, info,
        hasDirectUrls, hasSabr: Boolean(streamData?.server_abr_streaming_url),
        isLoginRequired: false,
        formatCount: formats.length,
      };
    } catch (err) {
      return {
        ok: false, client, info: null, hasDirectUrls: false, hasSabr: false,
        isLoginRequired: /LOGIN_REQUIRED|Sign in/i.test(String(err?.message ?? err)),
        error: err, formatCount: 0,
      };
    }
  }

  // 主入口：多客戶端並行 → 評分取最佳；全敗時退頁面 player response
  export async function loadVideoInfo(videoId, gmFetch, pagePlayerResponse) {
    const session = await getYouTubeClient(gmFetch);
    const candidates = await Promise.all(
      CLIENT_CANDIDATES.map(c => probeClient(c, videoId, session)),
    );
    const best = candidates
      .filter(c => scoreInfoCandidate(c) > 0)
      .sort((a, b) => scoreInfoCandidate(b) - scoreInfoCandidate(a))[0];
    if (best) return { source: 'innertube', client: best.client, info: best.info };

    if (pagePlayerResponse?.streamingData) {
      const parsed = Parser.parseResponse(pagePlayerResponse);
      if (parsed?.streaming_data) return { source: 'page', client: 'PAGE', info: parsed };
    }
    const err = candidates.find(c => c.error)?.error ?? new Error('No stream info obtained');
    throw err;
  }
  ```
  > 執行者注意：`getBasicInfo` 的 options 參數鍵名（`client`）與回傳欄位
  > （`formats`/`adaptive_formats`/`streaming_data`）請對照
  > `node_modules/youtubei.js/dist/src/core/clients/` 與 `VideoInfo` 型別定義；
  > `Parser.parseResponse` 若需第二參數（session），從 `node_modules` 型別確認後補上。

- [ ] **Step 4: 執行測試確認通過**
  ```bash
  npm test
  ```
  預期：全 PASS。

- [ ] **Step 5: Commit**
  ```bash
  git add src/yt-client.js tests/score-info.test.mjs
  git commit -m "feat(ytdl): Innertube session、多客戶端探測與評分（TDD）"
  ```

---

## Task 6: decipher.js — 播放器簽名執行環境

**檔案：**
- 建立：`src/decipher.js`

- [ ] **Step 1: 實作**
  ```js
  // src/decipher.js
  import { Platform } from 'youtubei.js/web';
  import { isGoogleVideoUrl } from './formats.js';

  // client 實例由 main.js 注入（避免循環依賴）
  let clientProvider = null;
  export function setClientProvider(fn) { clientProvider = fn; }

  // youtubei.js 執行播放器簽名程式碼需要 eval；Tampermonkey sandbox + TrustedTypes
  // 環境下必須以 TrustedScript policy 放行，並在頁面 context 執行。
  // 必須在 Innertube.create() 之前呼叫。
  let installed = false;
  export function installEvalEnvironment() {
    if (installed) return;
    installed = true;
    const pageWin = unsafeWindow;
    const pageEval = pageWin.eval.bind(pageWin);
    const tt = pageWin.trustedTypes;
    const policy = tt?.createPolicy
      ? tt.createPolicy('ytdl-player-eval', { createScript: (s) => s })
      : null;
    Platform.shim.eval = (code) => {
      if (typeof code !== 'string' || code.length < 64) {
        throw new Error('[YT-DL] refused to eval suspicious code');
      }
      return policy ? pageEval(policy.createScript(code)) : pageEval(code);
    };
  }

  async function getPlayer(info) {
    const client = await clientProvider?.();
    return info?.actions?.session?.player ?? client?.session?.player ?? null;
  }

  // 對單一格式 decipher 出真實下載 URL（含白名單校驗）
  export async function decipherFormat(info, format) {
    const player = await getPlayer(info);
    if (!player) throw new Error('[YT-DL] no player for decipher');
    const url = format.decipher(player);
    if (!isGoogleVideoUrl(url)) throw new Error('[YT-DL] deciphered URL is not googlevideo');
    return url;
  }

  // 對 SABR server_abr_streaming_url decipher（含白名單校驗）
  export async function decipherServerUrl(info, url) {
    const player = await getPlayer(info);
    if (!player) throw new Error('[YT-DL] no player for decipher');
    const out = player.decipher(url);
    if (!isGoogleVideoUrl(out)) throw new Error('[YT-DL] deciphered URL is not googlevideo');
    return out;
  }
  ```
  > 執行者注意：
  > 1. `Platform.shim.eval` 的覆寫時機必須在 `Innertube.create()` **之前**（main.js 中 installEvalEnvironment 最先呼叫）。
  > 2. `info.actions.session.player` 欄位路徑與 `player.decipher(url)` 簽名對照
  >    youtubei.js `VideoInfo` / `Player` 型別定義後修正。

- [ ] **Step 2: build 驗證**
  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**
  ```bash
  git add src/decipher.js
  git commit -m "feat(ytdl): TrustedTypes 播放器 eval 環境與格式 decipher"
  ```

---

## Task 7: downloader.js — Range 並發下載器

**檔案：**
- 建立：`src/downloader.js`

依賴 Task 3 的 `splitRanges`。行為：預先配置 `Uint8Array(totalSize)`，N 路並發抓分片寫入對應 offset；`AbortController` 取消；pause 以 gate Promise 實現；單片失敗指數退避重試（最多 3 次）。

- [ ] **Step 1: 實作**
  ```js
  // src/downloader.js
  import { splitRanges } from './range-split.js';

  const DEFAULT_CHUNK = 8 * 1024 * 1024; // 8MB

  export function createDownloadTask({ url, totalSize, fetchImpl, concurrency = 4, chunkSize = DEFAULT_CHUNK, onProgress }) {
    const ranges = splitRanges(totalSize, chunkSize);
    const buffer = new Uint8Array(totalSize);
    const controller = new AbortController();
    let paused = false, pauseGate = Promise.resolve(), pauseResolve = null;
    let done = 0;

    const waitIfPaused = () => pauseGate;

    async function fetchRange({ start, end }, attempt = 0) {
      await waitIfPaused();
      const res = await fetchImpl(url, {
        headers: { Range: `bytes=${start}-${end}` }, signal: controller.signal,
      });
      if (!res.ok && res.status !== 206) throw new Error(`range ${start}-${end} HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.length !== end - start + 1) throw new Error(`range ${start}-${end} short read: ${data.length}`);
      buffer.set(data, start);
      done += data.length;
      onProgress?.({ loaded: done, total: totalSize });
    }

    async function fetchRangeWithRetry(range) {
      for (let attempt = 0; ; attempt++) {
        try { return await fetchRange(range); }
        catch (err) {
          if (controller.signal.aborted) throw err;
          if (attempt >= 3) throw err;
          await sleep(1000 * 2 ** attempt);
        }
      }
    }

    const queue = [...ranges];
    async function worker() {
      while (queue.length) {
        await waitIfPaused();
        const range = queue.shift();
        if (!range) break;
        await fetchRangeWithRetry(range);
      }
    }

    return {
      start: () => Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker))
        .then(() => ({ buffer, blob: () => new Blob([buffer]) })),
      pause() { if (!paused) { paused = true; pauseGate = new Promise(r => pauseResolve = r); } },
      resume() { paused = false; pauseResolve?.(); },
      cancel() { controller.abort(); },
      get progress() { return totalSize ? done / totalSize : 0; },
    };
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  ```

- [ ] **Step 2: 以 node 內建 fetch 做整合煙霧測試（可選）**
  在 `tests/downloader.test.mjs` 寫一個用 `node:http` local server 供分片請求的測試（205/206 行為），斷言重組後位元組等於伺服器內容。若時間成本高，至少驗證 `createDownloadTask` 對 `totalSize=0` 不丟例外出空任務。

- [ ] **Step 3: build 驗證**
  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**
  ```bash
  git add src/downloader.js tests/downloader.test.mjs
  git commit -m "feat(ytdl): Range 並發下載器（暫停/恢復/取消/重試）"
  ```

---

## Task 8: muxer.js — mediabunny 無損合併

**檔案：**
- 建立：`src/muxer.js`

- [ ] **Step 0: 查閱 API**
  讀 `node_modules/mediabunny/dist/modules/`（或 `mediabunny` README）確認：
  `Input`、`BlobSource`、`UrlSource`、`ReadableStreamSource`、`Output`、`StreamTarget`、`BlobTarget`、
  `Mp4OutputFormat`、`WebMOutputFormat`、`EncodedPacketSink`、`EncodedVideoPacketSource`、
  `EncodedAudioPacketSource` 的建構簽名。以下程式碼按參考專案同款模式撰寫，若簽名有出入以 .d.ts 修正。

- [ ] **Step 1: 實作**
  ```js
  // src/muxer.js
  import {
    Input, Output, BlobSource, StreamTarget, BlobTarget,
    Mp4OutputFormat, WebMOutputFormat,
    EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource,
  } from 'mediabunny';

  // 把來源軌的編碼封包接到輸出軌（無損 copy，不重編碼）
  async function copyTrack(input, kind, output) {
    const track = kind === 'video' ? input.videoTracks[0] : input.audioTracks[0];
    if (!track) throw new Error(`[YT-DL] source has no ${kind} track`);
    const sink = new EncodedPacketSink(track);
    return kind === 'video'
      ? output.addVideoTrack(new EncodedVideoPacketSource(sink, track))
      : output.addAudioTrack(new EncodedAudioPacketSource(sink, track));
  }

  // 直連路徑：兩個 Blob（下載完成的視頻/音頻）→ 合併寫入 target
  export async function muxBlobs({ videoBlob, audioBlob, container, target }) {
    const format = container === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat();
    const output = new Output({ target, format });
    const videoInput = new Input({ source: new BlobSource(videoBlob) });
    await copyTrack(videoInput, 'video', output);
    if (audioBlob) {
      const audioInput = new Input({ source: new BlobSource(audioBlob) });
      await copyTrack(audioInput, 'audio', output);
    }
    await output.finalize();
  }

  // 串流寫盤用的 target（FSA writable）
  export function streamTargetFor(writable) {
    return new StreamTarget(writable);
  }

  // 記憶體退回用的 target
  export function blobTarget() {
    return new BlobTarget();
  }
  ```

- [ ] **Step 2: build 驗證**
  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**
  ```bash
  git add src/muxer.js
  git commit -m "feat(ytdl): mediabunny 音視頻無損封裝"
  ```

---

## Task 9: fs-writer.js — 串流寫盤與退回

**檔案：**
- 建立：`src/fs-writer.js`

- [ ] **Step 1: 實作**
  ```js
  // src/fs-writer.js
  export function supportsFsAccess() {
    return typeof window.showSaveFilePicker === 'function';
  }

  const EXT_TO_MIME = {
    mp4: 'video/mp4', webm: 'video/webm', 'm4a': 'audio/mp4',
  };

  // 回傳統一描述：{ kind: 'fs'|'blob', writable, suggestedName, container }
  // fs → writable 為 FileSystemWritableFileStream（本身是 WritableStream 子類，
  //       直接交給 mediabunny StreamTarget）
  // blob → writable 為 null，由 main.js 改用 BlobTarget
  export async function openOutput(suggestedName, container) {
    if (supportsFsAccess()) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: container.toUpperCase(), accept: { [EXT_TO_MIME[container] ?? 'application/octet-stream']: [`.${container}`] } }],
        });
        return { kind: 'fs', writable: await handle.createWritable(), suggestedName, container };
      } catch (err) {
        if (err?.name === 'AbortError') throw err; // 使用者取消存檔 → 整個任務取消
        // 其他錯誤（例如瀏覽器限制）退回 Blob
      }
    }
    return { kind: 'blob', writable: null, suggestedName, container };
  }

  // Blob 退回路徑的存檔（anchor + objectURL，同源無 CORS 問題）
  export function saveBlobAs(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }
  ```
  > 執行者注意：`StreamTarget` 期望的 writable 形狀（WritableStream vs FileSystemWritableFileStream）
  > 以 mediabunny .d.ts 為準；`FileSystemWritableFileStream` 本身就是 WritableStream 子類，
  > 直接傳 `createWritable()` 結果最可能正確。

- [ ] **Step 2: build 驗證 + Commit**
  ```bash
  npm run build
  git add src/fs-writer.js
  git commit -m "feat(ytdl): File System Access 寫盤與 Blob 退回"
  ```

---

## Task 10: sabr.js — SABR/UMP 串流路徑

**檔案：**
- 建立：`src/sabr.js`

- [ ] **Step 0: 查閱 API**
  讀 `node_modules/googlevideo/` 的 `sabr-stream` 型別：`SabrStream` 建構參數
  （`fetch`、`serverAbrStreamingUrl`、`videoPlaybackUstreamerConfig`、`clientInfo`、`poToken`、`formats`）
  與 `start({ videoFormat, audioFormat, preferMP4, preferH264 })` 回傳形狀（`videoStream`/`audioStream`）。

- [ ] **Step 1: 實作**
  ```js
  // src/sabr.js
  import { SabrStream } from 'googlevideo/sabr-stream';
  import { ReadableStreamSource } from 'mediabunny';
  import { isGoogleVideoUrl } from './formats.js';

  export function hasSabrStreaming(info) {
    return Boolean(info?.streaming_data?.server_abr_streaming_url);
  }

  export async function startSabrDownload({ info, videoFormat, audioFormat, pageFetch, decipher, poToken }) {
    const sd = info.streaming_data;
    const serverAbrUrl = await decipher(sd.server_abr_streaming_url);
    if (!isGoogleVideoUrl(serverAbrUrl)) throw new Error('[YT-DL] SABR url not googlevideo');

    const ustreamerConfig = info.player_config?.media_common_config
      ?.media_ustreamer_request_config?.video_playback_ustreamer_config;
    if (!ustreamerConfig) throw new Error('[YT-DL] missing ustreamer config');

    const clientInfo = {
      clientName: info.actions?.session?.context?.client?.clientName ?? 'WEB',
      clientVersion: info.actions?.session?.context?.client?.clientVersion ?? '2.0',
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
    };

    const sabr = new SabrStream({
      fetch: pageFetch, // SABR 優先頁面 fetch（保留 session 語境）
      serverAbrStreamingUrl: serverAbrUrl,
      videoPlaybackUstreamerConfig: ustreamerConfig,
      clientInfo,
      poToken,
    });

    const { videoStream, audioStream } = await sabr.start({
      videoFormat, audioFormat, preferMP4: true, preferH264: true,
    });
    return {
      abort: () => sabr.abort?.(),
      toSources: () => ({
        videoSource: new ReadableStreamSource(videoStream, { type: 'video', container: 'mp4' }),
        audioSource: audioStream ? new ReadableStreamSource(audioStream, { type: 'audio', container: 'mp4' }) : null,
      }),
    };
  }
  ```
  > 執行者注意：`ReadableStreamSource` 建構參數與 `sabr.start()` 回傳的串流內容格式
  > （UMP 解出的 fMP4 init+segments？）對照參考專案 `media-runtime.js` 的匯出用法
  > 與 mediabunny .d.ts；必要時在 `toSources` 內補 container/codec 元資料。
  > muxer 的 `copyTrack` 需新增 `source` 直入版本（`new Input({ source })`）。

- [ ] **Step 2: build 驗證 + Commit**
  ```bash
  npm run build
  git add src/sabr.js
  git commit -m "feat(ytdl): SABR/UMP 串流下載路徑"
  ```

---

## Task 11: ui.js + main.js — UI、佇列與總裝配

**檔案：**
- 建立：`src/ui.js`、`src/settings.js`
- 修改：`src/main.js`（替換樁）

- [ ] **Step 1: settings.js（GM 儲存）**
  ```js
  // src/settings.js
  const KEY_PREFIX = 'ytdl:';
  export const getSetting = (key, fallback) => {
    const v = GM_getValue(KEY_PREFIX + key, undefined);
    return v === undefined ? fallback : v;
  };
  export const setSetting = (key, value) => GM_setValue(KEY_PREFIX + key, value);
  ```

- [ ] **Step 2: ui.js（按鈕 + 面板 + 進度，完整實作）**
  ```js
  // src/ui.js
  import { formatBytes } from './range-split.js';

  const CSS = `
  .ytdl-btn { display:inline-flex; align-items:center; gap:6px; cursor:pointer;
    border:0; border-radius:18px; padding:0 14px; height:36px; font-size:14px; font-weight:500;
    background: var(--yt-spec-badge-chip-background, rgba(0,0,0,.05));
    color: var(--yt-spec-text-primary, #0f0f0f); }
  .ytdl-panel { position:fixed; right:24px; bottom:24px; z-index:99999; width:330px;
    background: var(--yt-spec-menu-background, #fff); color: var(--yt-spec-text-primary, #0f0f0f);
    border:1px solid var(--yt-spec-outline, rgba(0,0,0,.1)); border-radius:12px; padding:14px;
    box-shadow:0 8px 24px rgba(0,0,0,.25); font-size:13px; }
  .ytdl-panel h4 { margin:0 0 8px; font-size:14px; }
  .ytdl-panel label { display:block; margin:8px 0 4px; opacity:.8; }
  .ytdl-panel select { width:100%; padding:4px; border-radius:6px;
    border:1px solid var(--yt-spec-outline, rgba(0,0,0,.2)); background:transparent; color:inherit; }
  .ytdl-progress { height:8px; border-radius:4px; overflow:hidden; margin:8px 0 4px;
    background: var(--yt-spec-general-background-b, rgba(0,0,0,.1)); }
  .ytdl-progress > div { height:100%; width:0; background:#ff0033; transition:width .2s; }
  .ytdl-row { display:flex; gap:8px; margin-top:8px; }
  .ytdl-row button { flex:1; padding:6px; border:1px solid var(--yt-spec-outline, rgba(0,0,0,.2));
    border-radius:8px; background:transparent; color:inherit; cursor:pointer; }
  .ytdl-start { width:100%; margin-top:10px; padding:8px; border:0; border-radius:8px;
    background:#f03; color:#fff; font-weight:600; cursor:pointer; }
  .ytdl-error { color:#f33; margin-top:8px; white-space:pre-wrap; }
  .ytdl-note { opacity:.65; margin-top:6px; }
  `;

  export function createUI({ onStart, onPause, onResume, onCancel, onRefresh, onSettingsChange }) {
    injectStyles();
    const el = { button: null, panel: null };

    function injectStyles() {
      if (document.getElementById('ytdl-style')) return;
      const s = document.createElement('style');
      s.id = 'ytdl-style';
      s.textContent = CSS;
      document.documentElement.appendChild(s);
    }

    // watch 頁：操作列；Shorts：右側操作欄（selector 以當下 DOM 實測為準，必要時調整）
    function findButtonHost() {
      return document.querySelector('ytd-watch-metadata #top-level-buttons-computed')
          ?? document.querySelector('#actions.ytd-reel-action-bar-renderer')
          ?? document.querySelector('ytd-reel-video-renderer[is-active] #actions');
    }

    function ensureButton() {
      if (el.button?.isConnected) return;
      const host = findButtonHost();
      if (!host) return;
      const btn = document.createElement('button');
      btn.className = 'ytdl-btn';
      btn.textContent = '⬇ 下載';
      btn.addEventListener('click', togglePanel);
      host.appendChild(btn);
      el.button = btn;
    }

    function togglePanel() {
      if (el.panel?.isConnected) { el.panel.remove(); return; }
      const p = document.createElement('div');
      p.className = 'ytdl-panel';
      p.innerHTML = `
        <h4>YouTube 直連下載</h4>
        <label>畫質</label><select class="ytdl-quality" disabled><option>解析中…</option></select>
        <label>音軌語言</label><select class="ytdl-lang" disabled><option>預設</option></select>
        <label>並發數</label><select class="ytdl-conc">${[1,2,3,4,5,6,7,8].map(n => `<option${n===4?' selected':''}>${n}</option>`).join('')}</select>
        <div class="ytdl-progress"><div></div></div>
        <div class="ytdl-status ytdl-note">就緒</div>
        <div class="ytdl-row">
          <button class="ytdl-pause" hidden>暫停</button>
          <button class="ytdl-cancel" hidden>取消</button>
          <button class="ytdl-refresh">刷新格式</button>
        </div>
        <button class="ytdl-start" disabled>開始下載</button>
        <div class="ytdl-error"></div>`;
      document.body.appendChild(p);
      el.panel = p;
      p.querySelector('.ytdl-start').addEventListener('click', () => onStart(getSelection()));
      p.querySelector('.ytdl-pause').addEventListener('click', () => {
        const b = p.querySelector('.ytdl-pause');
        if (b.dataset.mode === 'resume') { b.textContent = '暫停'; b.dataset.mode = 'pause'; onResume(); }
        else { b.textContent = '恢復'; b.dataset.mode = 'resume'; onPause(); }
      });
      p.querySelector('.ytdl-cancel').addEventListener('click', onCancel);
      p.querySelector('.ytdl-refresh').addEventListener('click', onRefresh);
      p.querySelector('.ytdl-conc').addEventListener('change', (e) => onSettingsChange({ concurrency: Number(e.target.value) }));
    }

    function getSelection() {
      const q = el.panel?.querySelector('.ytdl-quality');
      const l = el.panel?.querySelector('.ytdl-lang');
      const c = el.panel?.querySelector('.ytdl-conc');
      return {
        qualityIndex: q ? Number(q.value) : -1,
        language: l?.value && l.value !== 'default' ? l.value : null,
        concurrency: c ? Number(c.value) : 4,
      };
    }

    function renderQualities(qualities, languages) {
      if (!el.panel?.isConnected) return;
      const q = el.panel.querySelector('.ytdl-quality');
      q.innerHTML = qualities.map((e, i) =>
        `<option value="${i}">${e.label} · ${e.container.toUpperCase()}${e.sizeBytes ? ' · ' + formatBytes(e.sizeBytes) : ''}${e.isProgressive ? ' · 含音訊' : ''}</option>`).join('');
      q.disabled = !qualities.length;
      const l = el.panel.querySelector('.ytdl-lang');
      l.innerHTML = ['<option value="default">自動（瀏覽器語言）</option>',
        ...languages.map(x => `<option value="${x}">${x}</option>`)].join('');
      l.disabled = false;
      el.panel.querySelector('.ytdl-start').disabled = !qualities.length;
    }

    function setStatus(text) { if (el.panel?.isConnected) el.panel.querySelector('.ytdl-status').textContent = text; }
    function setError(err) { if (el.panel?.isConnected) el.panel.querySelector('.ytdl-error').textContent = err ? String(err?.message ?? err) : ''; }

    function setProgress({ loaded = 0, total = 0, phase = '' }) {
      if (!el.panel?.isConnected) return;
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      el.panel.querySelector('.ytdl-progress > div').style.width = `${pct}%`;
      setStatus(`${phase} ${pct}%${total ? `（${formatBytes(loaded)} / ${formatBytes(total)}）` : ''}`);
    }

    function setTaskButtons(active) {
      if (!el.panel?.isConnected) return;
      el.panel.querySelector('.ytdl-pause').hidden = !active;
      el.panel.querySelector('.ytdl-cancel').hidden = !active;
      el.panel.querySelector('.ytdl-start').disabled = active;
    }

    return { ensureButton, renderQualities, setStatus, setError, setProgress, setTaskButtons };
  }
  ```
  > 執行者注意：Shorts 的按鈕掛載點 selector（`ytd-reel-video-renderer[is-active]`）
  > 以實際 DOM 驗證為準，找不到就往上层找穩定容器。SPA 導航後 `ensureButton`
  > 會因 `isConnected === false` 自動重掛。

- [ ] **Step 3: main.js 總裝配（完整實作）**
  ```js
  // src/main.js
  import { installEvalEnvironment, setClientProvider, decipherFormat, decipherServerUrl } from './decipher.js';
  import { gmFetch, pageFetch, mediaFetch } from './gm-bridge.js';
  import { getYouTubeClient, loadVideoInfo } from './yt-client.js';
  import { buildQualityList, stripRangeParams } from './formats.js';
  import { createDownloadTask } from './downloader.js';
  import { muxBlobs, streamTargetFor, blobTarget } from './muxer.js';
  import { openOutput, saveBlobAs, supportsFsAccess } from './fs-writer.js';
  import { hasSabrStreaming, startSabrDownload } from './sabr.js';
  import { createUI } from './ui.js';
  import { getSetting, setSetting } from './settings.js';

  installEvalEnvironment(); // 必須最先：在 Innertube.create 之前覆寫 Platform.shim.eval

  const app = {
    videoId: null, info: null, qualities: [], languages: [],
    clientPromise: null, poToken: null,
    pageCapture: { playerResponse: null, mediaUrls: new Map() },
  };
  setClientProvider(() => app.clientPromise);

  function ensureClient() {
    app.clientPromise ??= getYouTubeClient(gmFetch, { cookie: document.cookie }).then((c) => {
      app.poToken = c.session?.po_token ?? null;
      return c;
    });
    return app.clientPromise;
  }

  // --- 頁面攔截（後備來源）---
  function installPageCapture() {
    const w = unsafeWindow;
    const origFetch = w.fetch.bind(w);
    w.fetch = async (input, init) => {
      const res = await origFetch(input, init);
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (url?.includes('googlevideo.com/videoplayback')) {
          app.pageCapture.mediaUrls.set(stripRangeParams(url), Date.now());
        } else if (url?.includes('/youtubei/v1/player')) {
          res.clone().json().then((j) => { if (j?.streamingData) app.pageCapture.playerResponse = j; }).catch(() => {});
        }
      } catch { /* 不影響頁面 */ }
      return res;
    };
    const grabInitial = () => {
      if (w.ytInitialPlayerResponse?.streamingData) app.pageCapture.playerResponse = w.ytInitialPlayerResponse;
    };
    grabInitial();
    document.addEventListener('yt-navigate-finish', () => setTimeout(grabInitial, 500));
  }

  function parseVideoId() {
    const m = location.pathname.match(/\/(?:watch\?v=|shorts\/|live\/)?([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
    return new URLSearchParams(location.search).get('v');
  }

  function sanitizeFilename(name) {
    return String(name).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'video';
  }

  // --- 下載佇列（一次一個）---
  const queue = [];
  let currentTask = null;
  function enqueue(job) { queue.push(job); if (!currentTask) runNext(); }
  async function runNext() {
    const job = queue.shift();
    if (!job) { currentTask = null; return; }
    currentTask = job;
    app.ui.setTaskButtons(true);
    try { await job(); app.ui.setStatus('完成 ✓'); }
    catch (err) {
      if (err?.name === 'AbortError') app.ui.setStatus('已取消');
      else app.ui.setError(err);
    } finally {
      app.ui.setTaskButtons(false);
      currentTask = null;
      if (queue.length) runNext();
      else app.ui.setStatus('就緒');
    }
  }

  // --- 導航 ---
  async function onNavigate() {
    const vid = parseVideoId();
    if (!vid) return;
    app.videoId = vid;
    app.info = null; app.qualities = []; app.languages = [];
    app.ui.ensureButton();
    await refreshFormats();
  }

  async function refreshFormats() {
    app.ui.setError('');
    app.ui.setStatus('解析格式中…');
    try {
      await ensureClient();
      const { info } = await loadVideoInfo(app.videoId, gmFetch, app.pageCapture.playerResponse);
      app.info = info;
      const formats = [...(info.formats ?? []), ...(info.adaptive_formats ?? [])];
      const browserLang = navigator.language;
      app.qualities = buildQualityList(formats, { audioLanguage: browserLang });
      app.languages = [...new Set(formats.filter(f => f.has_audio && f.language).map(f => f.language))];
      app.ui.renderQualities(app.qualities, app.languages);
      app.ui.setStatus(`已取得 ${app.qualities.length} 種畫質${hasSabrStreaming(info) ? '（含 SABR 路徑）' : '（直連）'}`);
    } catch (err) {
      app.ui.setError(`取得格式失敗：${err?.message ?? err}`);
      app.ui.setStatus('失敗，可點「刷新格式」重試');
    }
  }

  // --- 下載執行 ---
  function startDownload({ qualityIndex, language, concurrency }) {
    setSetting('concurrency', concurrency);
    const entry = app.qualities[qualityIndex];
    if (!entry || !app.info) return;
    const title = app.info.basic_info?.title ?? app.info.video_details?.title ?? app.videoId;
    const filename = `${sanitizeFilename(title)} [${entry.label}].${entry.container}`;
    enqueue(() => runDownloadTask({ entry, language, concurrency, filename }));
  }

  async function runDownloadTask({ entry, language, concurrency, filename }) {
    const info = app.info;
    const target = await openOutput(filename, entry.container);
    const concurrencySaved = getSetting('concurrency', 4);

    // 路徑 A：直連 URL（格式可 decipher）
    const canDirect = entry.videoFormat.url || entry.videoFormat.cipher;
    if (canDirect) {
      app.ui.setStatus('下載中（直連）');
      const videoUrl = await decipherFormat(info, entry.videoFormat);
      const videoTask = createDownloadTask({
        url: videoUrl, totalSize: entry.videoFormat.content_length,
        fetchImpl: mediaFetch, concurrency, onProgress: (p) => app.ui.setProgress({ ...p, phase: '視頻' }),
      });
      currentTask.controls = videoTask;
      let audioTask = null, audioBlob = null;
      if (entry.audioFormat) {
        const audioUrl = await decipherFormat(info, entry.audioFormat);
        audioTask = createDownloadTask({
          url: audioUrl, totalSize: entry.audioFormat.content_length,
          fetchImpl: mediaFetch, concurrency, onProgress: (p) => app.ui.setProgress({ ...p, phase: '音頻' }),
        });
      }
      const [videoRes, audioRes] = await Promise.all([videoTask.start(), audioTask?.start()]);
      app.ui.setStatus('合併中…');
      if (target.kind === 'fs') {
        await muxBlobs({ videoBlob: videoRes.blob(), audioBlob: audioRes?.blob(), container: entry.container, target: streamTargetFor(target.writable) });
      } else {
        const bt = blobTarget();
        await muxBlobs({ videoBlob: videoRes.blob(), audioBlob: audioRes?.blob(), container: entry.container, target: bt });
        saveBlobAs(await bt.blob, filename); // BlobTarget 的 blob 存取方式以 .d.ts 為準
      }
      return;
    }

    // 路徑 B：SABR（無直接 URL）
    if (hasSabrStreaming(info)) {
      app.ui.setStatus('下載中（SABR）');
      const sabr = await startSabrDownload({
        info, videoFormat: entry.videoFormat, audioFormat: entry.audioFormat,
        pageFetch, decipher: (url) => decipherServerUrl(info, url), poToken: app.poToken,
      });
      currentTask.controls = { pause() {}, resume() {}, cancel() { sabr.abort(); } };
      // SABR 兩軌串流 → mediabunny 直接 remux 到 target
      const { muxSources } = await import('./muxer.js');
      await muxSources({ ...sabr.toSources(), container: entry.container,
        target: target.kind === 'fs' ? streamTargetFor(target.writable) : blobTarget() });
      return;
    }
    throw new Error('此畫質無直連 URL 且 SABR 不可用，請嘗試其他畫質或刷新格式');
  }

  // --- 裝配 ---
  installPageCapture();
  app.ui = createUI({
    onStart: startDownload,
    onPause: () => currentTask?.controls?.pause(),
    onResume: () => currentTask?.controls?.resume(),
    onCancel: () => currentTask?.controls?.cancel(),
    onRefresh: refreshFormats,
    onSettingsChange: ({ concurrency }) => setSetting('concurrency', concurrency),
  });
  window.addEventListener('yt-navigate-finish', () => onNavigate());
  if (document.readyState !== 'loading') onNavigate();
  else document.addEventListener('DOMContentLoaded', onNavigate, { once: true });
  console.log('[YT-DL] youtube-direct-downloader ready');
  ```
  > 執行者注意：
  > 1. `muxer.js` 需新增 `muxSources({ videoSource, audioSource, container, target })`
  >    （Task 10 已註記）：與 `muxBlobs` 相同，但 `Input` 的 source 直接用傳入的
  >    `ReadableStreamSource` 而非 `BlobSource`。
  > 2. `runDownloadTask` 內 blob 退回時 `bt.blob` 的存取形式（同步 getter 或
  >    `getFile()`）對照 mediabunny `BlobTarget` 型別。
  > 3. `currentTask.controls` 掛在 job 函數外的 currentTask 變數上，pause/cancel
  >    按鈕即時生效。

- [ ] **Step 4: build + 安裝到瀏覽器手動驗證（開發者本機）**
  ```bash
  npm run build
  ```
  將 `public/apks/youtube-direct-downloader.user.js` 拖入 Tampermonkey，按 spec §6 手動清單逐項驗證（watch/Shorts/直連/SABR/暫停/取消/Chrome+Firefox）。**此步驟需要真人操作瀏覽器，代理無法代做 — 標記為使用者驗證點。**

- [ ] **Step 5: Commit**
  ```bash
  git add src/ui.js src/settings.js src/main.js
  git commit -m "feat(ytdl): UI、下載佇列與總裝配"
  ```

---

## Task 12: 發布上架

**檔案：**
- 修改：`tools.json`
- 產物：`public/apks/youtube-direct-downloader.user.js`（build 後）

- [ ] **Step 1: build 最終版**
  ```bash
  cd userscripts/youtube-direct-downloader && npm test && npm run build
  ```
  預期：測試全綠 + 產物更新。

- [ ] **Step 2: tools.json 加條目**
  ```json
  {
    "id": "youtube-direct-downloader",
    "name": "YouTube 直連下載 (Direct Downloader)",
    "packageName": "https://github.com/jacky3213",
    "version": "v0.1.0",
    "versionCode": 100,
    "minSdk": "Tampermonkey (Chrome/Edge 建議，需 File System Access API 支援高畫質合併)",
    "architecture": "universal",
    "fileSize": "<build 後實測>",
    "icon": "Terminal",
    "category": "Tampermonkey",
    "summary": "在瀏覽器內直接下載 YouTube 影片與 Shorts，音視頻無損合併，不經第三方解析站",
    "description": "在 YouTube 影片與 Shorts 頁面一鍵下載：多客戶端直連串流、SABR/UMP 支援、畫質/容器/音軌語言選擇、瀏覽器內無損合併（不重新編碼）、Range 並發下載（1–8 路）、File System Access 串流寫盤、下載佇列與暫停/恢復/取消。僅供個人備份使用，請遵守著作權法與 YouTube 服務條款。",
    "changelog": ["v0.1.0 首次發布——直連 URL 與 SABR 雙路徑、無損合併、佇列管理"],
    "downloadUrl": "/api/download/youtube-direct-downloader.user.js",
    "scriptFileName": "youtube-direct-downloader.user.js",
    "rating": 5,
    "releaseDate": "<當日日期>",
    "checksumSha256": "<sha256sum 計算>",
    "screenshots": [],
    "installGuide": {
      "steps": [
        "安裝瀏覽器擴充 Tampermonkey（建議 Chrome / Edge）",
        "點擊「立即安裝腳本」，Tampermonkey 會自動跳出安裝頁，按「安裝」",
        "打開 YouTube 任一影片頁，影片資訊下方出現「⬇ 下載」按鈕即安裝成功",
        "選擇畫質後按開始；高畫質合併會跳出存檔視窗（串流寫盤）"
      ],
      "verify": "打開 YouTube 影片頁，按 F12 → Console 應看到 [YT-DL] 開頭日誌。只顯示 360p 時，先在播放器手動選高畫質播放數秒，再點下載重新整理格式。",
      "troubleshooting": {
        "title": "安裝後沒有出現下載按鈕？",
        "steps": [
          "chrome://extensions → Tampermonkey → 詳細資料 → 開啟「允許使用者指令碼」",
          "確認腳本已啟用且網址是 youtube.com 網域",
          "重新整理頁面；Shorts 與 watch 頁都支援，但嵌入 iframe 內的播放器不支援"
        ],
        "note": "說明：不支援 DRM、付費、直播內容。高畫質合併需要 Chrome/Edge 的 File System Access API；Firefox 會退回記憶體合併（大型影片可能受記憶體限制）。本工具僅供個人備份，請勿散佈受版權保護的內容。"
      }
    },
    "isOfficial": true,
    "isFeatured": false
  }
  ```

- [ ] **Step 3: 驗證網站 reconcile 正常**
  ```bash
  cd ../.. && npm test
  ```
  預期：網站既有測試（含 reconcile-tools）全綠——新條目不破壞合併邏輯。

- [ ] **Step 4: Commit**
  ```bash
  git add tools.json public/apks/youtube-direct-downloader.user.js
  git commit -m "release(ytdl): v0.1.0 上架 YouTube 直連下載腳本"
  ```

---

## 完成後（Phase 7 前置）

- [ ] 全測試綠：子專案 `npm test` + 網站 `npm test`
- [ ] `npm run build` 產物 header 完整
- [ ] 手動驗證清單（spec §6）由使用者確認
- [ ] 進入 Finishing：合併/PR 選項

## 規格覆蓋率對照

| 規格需求 | 負責任務 |
|---|---|
| §2 畫質/容器/語言選擇 | Task 2, 11 |
| §2 直連 Range 並發 | Task 3, 4, 7 |
| §2 SABR 一期 | Task 10 |
| §2 FSA 寫盤 + Blob 退回 | Task 9 |
| §2 佇列/暫停/恢復/取消 | Task 7, 11 |
| §2 並發數設定 | Task 11 (settings + UI) |
| §4.1 混合式取得（自建主 + 頁面後備 + 白名單） | Task 5, 6, 11(3) |
| §4.2 SABR 細節 | Task 10 |
| §5 專案結構/發布 | Task 1, 12 |
| §6 測試 | 各 TDD task + Task 12 Step 3 |
