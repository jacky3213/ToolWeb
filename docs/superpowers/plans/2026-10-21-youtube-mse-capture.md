# MSE 攔截式下載器 實作計劃

> **給代理執行者：** 使用 superpowers subagent-driven-development 逐任務實作。
> 步驟使用 checkbox (`- [ ]`) 語法追蹤進度。

**目標：** 將 youtube-direct-downloader 從「直連/SABR 下載器」重構為「攔 SourceBuffer 的 MSE 攔截式下載器」。

**架構：** 攔 `MediaSource.addSourceBuffer` → 包裝 `SourceBuffer.appendBuffer` 收集 fMP4 分片（依 mime 分流 video/audio）→ 16x 靜音跟播 → 拼成 video.mp4 / audio.webm 兩個 Blob → 復用 `muxBlobs` 合併 → 存檔。

**技術棧：** Tampermonkey 沙箱 + 原生 MSE API + mediabunny（合併）+ File System Access（存檔）。測試用 node:test + 自製 DOM stub（零依賴，沿襲現有 `ui.test.mjs` 的做法）。

**參考文件：** `docs/superpowers/specs/2026-10-21-youtube-mse-capture-design.md`

---

## 刪除清單（Task 1 先做，一次清乾淨）

| 刪除檔案 | 對應測試 | 理由 |
|---|---|---|
| `src/downloader.js` | `tests/downloader.test.mjs` | range 下載器已失效 |
| `src/sabr.js` | （無獨立測試） | SABR 卡 poToken |
| `src/decipher.js` | （無獨立測試） | decipher 不再需要 |
| `src/yt-client.js` | `tests/score-info.test.mjs` | Innertube session 不再需要 |
| `src/range-split.js` 的 `splitRanges` | 保留 `formatBytes` | `formatBytes` 仍被 ui.js 用 |

---

## Task 1: 刪除失效模組，收斂依賴

**檔案：**
- 刪除：`src/downloader.js`、`src/sabr.js`、`src/decipher.js`、`src/yt-client.js`
- 刪除：`tests/downloader.test.mjs`、`tests/score-info.test.mjs`
- 修改：`src/range-split.js`（刪 `splitRanges`，保留 `formatBytes`）
- 修改：`tests/range-split.test.mjs`（刪 `splitRanges` 相關測試）

- [ ] **Step 1: 刪除上述檔案與測試**（用 git rm）
- [ ] **Step 2: 修改 range-split.js 只留 formatBytes**，並更新其測試
- [ ] **Step 3: 執行測試確認通過**
  執行：`cd userscripts/youtube-direct-downloader && npm test`
  預期：剩下的 formats / fs-writer / ui / range-split(formatBytes) 測試全綠
- [ ] **Step 4: Commit**
  `git commit -m "refactor(ytdl): 刪除失效的直連/SABR/decipher/Innertube 模組"`

---

## Task 2: capture.js — 攔截 SourceBuffer 收集分片（核心）

**檔案：**
- 建立：`src/capture.js`
- 建立：`tests/capture.test.mjs`

**capture.js 的介面設計：**

```js
// 建立一個 capture 實例，hook MediaSource.addSourceBuffer。
// 回傳 { start, stop, getResult }
//   start(): 掛鉤（若 MediaSource 尚未出現，會自動等待/輪詢）
//   stop(): 卸鉤，回傳 { video: Blob|null, audio: Blob|null, meta }
//   getResult(): 不卸鉤、立即回傳當前收集到的 Blob（供進度顯示）
export function createCapture() { ... }
```

**核心規則（TDD 重點）：**
1. `isInitSegment(buf)`：前 4 bytes 為 `ftyp`（0x66 74 79 70）
2. 依 `mime` 分流：`mime.includes('video')` → video track；`includes('audio')` → audio track
3. 每個 track 依序收集：init segment 放最前，media segments 接續
4. 資料型別：`appendBuffer` 傳入可能是 `ArrayBuffer` 或 `ArrayBufferView`（`Uint8Array`），要正規化為 `Uint8Array`
5. `stop()` 後拼 Blob：`new Blob([...chunks], { type: mime })`

- [ ] **Step 1: 寫失敗測試**（tests/capture.test.mjs）
  用自製 stub：`FakeMediaSource` + `FakeSourceBuffer`，模擬 addSourceBuffer / appendBuffer。
  測試案例：
  - isInitSegment 正確判斷 ftyp
  - video/audio 依 mime 分流
  - init 段在最前、media 依序
  - ArrayBuffer 與 Uint8Array 都能正規化
  - stop() 回傳正確的 video/audio Blob
- [ ] **Step 2: 執行測試確認失敗**（RED）
- [ ] **Step 3: 實作 capture.js 讓測試通過**（GREEN）
- [ ] **Step 4: 執行測試確認通過**
- [ ] **Step 5: Commit**
  `git commit -m "feat(ytdl): capture.js 攔截 SourceBuffer 收集 fMP4 分片"`

---

## Task 3: playback-driver.js — 16x 靜音跟播控制

**檔案：**
- 建立：`src/playback-driver.js`
- 建立：`tests/playback-driver.test.mjs`

**playback-driver.js 的介面設計：**

```js
// 控制 YouTube 播放器做 16x 靜音完整跟播。
// 回傳 { start, cancel }
//   start(): 找 video → muted=true → playbackRate=16 → currentTime=0 → play
//   cancel(): 還原 playbackRate=1、muted=false、pause
// 完成訊號：監聽 video 的 'ended' 事件，觸發 onComplete 回呼
export function createPlaybackDriver({ findVideo, onComplete, onProgress }) { ... }
```

**核心規則（TDD 重點）：**
1. `findVideo` 預設：`document.querySelector('video')`
2. `start()` 依序設定 muted → playbackRate → currentTime=0 → play
3. 監聽 `ended` → 呼叫 `onComplete`
4. 進度回報：`timeupdate` 事件 → `onProgress({ currentTime, duration })`
5. `cancel()` 還原狀態

- [ ] **Step 1: 寫失敗測試**（用自製 FakeVideo stub，實作 muted/playbackRate/currentTime/play/pause/addEventListener）
- [ ] **Step 2: RED**
- [ ] **Step 3: 實作 playback-driver.js**（GREEN）
- [ ] **Step 4: GREEN 驗證**
- [ ] **Step 5: Commit**
  `git commit -m "feat(ytdl): playback-driver.js 16x 靜音跟播控制"`

---

## Task 4: fmp4 組裝 — capture 結果 → 可合併的 Blob

**檔案：**
- 修改：`src/capture.js`（補齊 `buildBlob` 邏輯，若 Task 2 未完整）

**說明：** 若 Task 2 的 capture.js 已包含「拼 Blob」邏輯，此任務可併入 Task 2。獨立成任務是為了讓「分片收集」與「Blob 組裝」可分別驗證。視 Task 2 實作結果，此任務可能省略。

- [ ] **Step 1: 確認 Task 2 是否已涵蓋 Blob 組裝**；若已涵蓋，標記本任務完成並跳過。

---

## Task 5: main.js 重構 — 串起攔截流程

**檔案：**
- 修改：`src/main.js`（大幅重寫，移除直連/SABR/Innertube 邏輯）
- 修改：`src/ui.js`（改 UI 介面：移除畫質/語言選單，改為「攔截下載」導向）

**main.js 新流程：**
```
onNavigate → 解析 videoId → ui.ensureButton()
點「下載」→ 建立 capture → start 攔截 → 建立 playbackDriver → 16x 跟播
  → 播放中：onProgress 更新 UI（已攔截 MB）
  → ended → capture.stop() 拿 video/audio Blob
  → muxBlobs({ videoBlob, audioBlob, container:'mp4', target }) 合併
  → 存檔（openOutput / saveBlobAs）
  → UI 顯示「完成 ✅」
```

**ui.js 新介面：** 移除 `renderQualities`、畫質/語言/並發選單；保留 `ensureButton`（錨定邏輯不變）、`setStatus`、`setError`、`setProgress`；`setTaskButtons` 簡化為「開始/取消」。

- [ ] **Step 1: 寫失敗測試**（針對 main.js 中可抽離的純函式，如 `sanitizeFilename`、`parseVideoId`；main.js 的組裝邏輯因依賴 DOM/沙箱，以整合手測為主，單元測試覆蓋可抽離部分）
- [ ] **Step 2: RED**
- [ ] **Step 3: 重構 main.js + ui.js**（GREEN）
- [ ] **Step 4: 執行 `npm run build` 確認可打包**
- [ ] **Step 5: Commit**
  `git commit -m "refactor(ytdl): main.js 改為 MSE 攔截下載流程"`

---

## Task 6: 整合驗證 + tools.json 更新

**檔案：**
- 修改：`userscripts/youtube-direct-downloader/package.json`（版本 0.2.0）
- 修改：`tools.json`（版本/versionCode/fileSize/checksum/changelog）
- 修改：`build.mjs`（若 entry 或 header 需調整）

- [ ] **Step 1: 跑完整測試 + build**
  執行：`npm test && npm run build`
- [ ] **Step 2: 更新 tools.json（version 0.2.0、重算 checksum）**
- [ ] **Step 3: Commit**
  `git commit -m "release(ytdl): v0.2.0 MSE 攔截式下載器"`

---

## 驗證標準（對應設計文件 §7）

1. Chrome/Edge 開 SABR-only 高畫質影片 → 下載出**可播放的含音訊 mp4**
2. 畫質是播放器當前畫質（AV1/VP9），非 360p
3. 16x 下 5 分鐘影片 ~30 秒完成攔截
4. 背景分頁有提示
5. 保留的單元測試全綠

---

## 風險與注意

- **Task 2 的 stub 是關鍵**：`FakeMediaSource` 要能模擬 `addSourceBuffer` 回傳 `FakeSourceBuffer`，後者的 `appendBuffer` 要能接 `ArrayBuffer`/`Uint8Array`。這是 capture.js 可測性的核心。
- **Task 5 的整合測試較弱**：main.js 組裝邏輯依賴真實 DOM/沙箱，單元測試難度高。以「可抽離的純函式」單元測試 + 「手動整合驗證」雙軌進行。
- **muxBlobs 的 mp4+webm 跨容器合併**未在單元測試驗證過（現有測試只測 formatBytes 等純函式），需在整合驗證階段（Task 6）實測確認。
- **進度介面不一致（Task 5 需處理）**：playback-driver 的 `onProgress` 回報 `{ currentTime, duration }`（時間），
  而 capture 的進度是「已攔截 MB」（位元組）。UI 的 `setProgress` 目前吃 `{ loaded, total }`（位元組）。
  Task 5 實作時，UI 進度改以「已攔截 MB」為主（call `capture.getResult()` 算總位元組），
  播放進度（currentTime/duration）可另顯示在狀態列文字，不必塞進進度條。
  這是刻意簡化：攔截下載的「進度」本質是「已抓多少 MB」，不是「播到哪秒」。
