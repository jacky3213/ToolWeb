# YouTube 直連下載腳本 — 設計規格

日期：2026-10-20
狀態：待使用者審查
參考專案：[SamProjects/ytx-direct-downloader](https://github.com/SamProjects/ytx-direct-downloader)（MIT，僅借鑑原理，程式碼從零自寫）

## 1. 問題與目標

在使用者瀏覽 YouTube 時，直接從瀏覽器下載影片，**不經任何第三方解析站**：

- 支援一般影片與 Shorts
- 支援高畫質（音視頻分離軌）→ 瀏覽器內無損合併為 MP4/WebM
- 不重新編碼、不損失畫質
- 透過 ToolWeb 發布站上架 + Tampermonkey 熱更新

## 2. 範圍

### 含

- YouTube 一般影片（watch 頁）與 Shorts
- 畫質／容器（MP4/WebM）／音軌語言選擇
- 直連 URL 下載（decipher 後的 adaptive formats，Range 並發）
- **SABR/UMP 串流下載（一期即含）**
- File System Access API 串流寫盤 + in-memory Blob 退回
- 下載佇列：逐任務執行、暫停／恢復／取消
- 並發數設定（1–8 路，預設 4，GM 儲存）

### 不含

- X（Twitter）影片下載
- DRM、付費、會員、直播內容
- 字幕下載（二期評估）
- 重新編碼／轉檔（僅無損封裝）
- 播放清單批量下載（二期評估）

## 3. 技術棧

| 依賴 | 版本策略 | 用途 |
|------|---------|------|
| `youtubei.js` | 固定版（`web` 子入口） | `Innertube` session、`Parser`、`Platform`、`YTNodes`、多客戶端 `getBasicInfo`、`format.decipher` |
| `googlevideo` | 固定版（`googlevideo/sabr-stream`） | `SabrStream` — SABR/UMP 串流解協議 |
| `mediabunny` | 固定版 | `Input`/`Output`/`UrlSource`/`StreamTarget`/`Mp4OutputFormat`/`WebMOutputFormat` 無損 mux |
| `esbuild`（dev） | 固定版 | 打包為單一 user.js |

> 版本跟隨參考專案鎖定（youtubei.js 18.x / googlevideo 4.x / mediabunny 1.x），
> 因三者 API 耦合緊，升級需整組驗證。

## 4. 架構

```
YouTube 頁面（SPA）
   │ yt-navigate-finish 事件驅動（非輪詢）
   ▼
┌─ main.js ── 進入點：頁面類型偵測、模組裝配、任務狀態機 ─┐
│                                                        │
│  ui.js        「下載」按鈕、畫質面板、進度、佇列 UI      │
│  yt-client.js Innertube.create(gmFetch 適配)            │
│               ├ 多客戶端 getBasicInfo（ANDROID_VR/     │
│  formats.js   │ ANDROID/TV_SIMPLY/WEB）→ 評分選最佳     │
│               └ 後備：頁面 ytInitialPlayerResponse /   │
│                 movie_player.getPlayerResponse()        │
│  decipher.js  Platform.shim.eval 覆寫（TrustedTypes     │
│               policy，僅執行 YT 播放器源碼）→ 解真實 URL │
│  sabr.js      server_abr_streaming_url decipher +      │
│               ustreamer config + poToken → SabrStream   │
│  downloader.js Range 並發（1–8 路）、暫停/恢復/取消      │
│  muxer.js     mediabunny 音+視頻軌 → MP4/WebM           │
│  fs-writer.js File System Access 串流寫盤               │
│               ↘ 退回 Blob + GM/anchor 下載              │
│  gm-bridge.js GM_xmlhttpRequest 與頁面 fetch 的統一適配 │
└────────────────────────────────────────────────────────┘
   ▼
build.mjs (esbuild) → public/apks/youtube-direct-downloader.user.js
```

### 4.1 串流取得策略（混合式，自建為主）

1. **主路徑**：`Innertube.create()` 自建 session（`generate_session_locally`、
   `retrieve_player`），以多客戶端並行 `getBasicInfo`，對結果評分
   （有可 decipher URL 或 SABR 流者優先）。
2. **後備路徑**：主路徑被擋（`LOGIN_REQUIRED` 等）時，讀取頁面既有的
   player response（`movie_player.getPlayerResponse()` →
   `window.ytInitialPlayerResponse` → script 標籤解析），並攔截頁面
   fetch/XHR 中出現的 `googlevideo.com/videoplayback` URL 作為最後可用格式。
3. **URL 白名單**：所有下載 URL 強制校驗必須位於 `googlevideo.com`，防注入。

### 4.2 SABR/UMP（一期）

- 偵測 `streaming_data.server_abr_streaming_url` 或格式缺少直接 URL 時啟用。
- decipher server URL → 取 `media_ustreamer_request_config` →
  帶 `poToken`（session 提取）建 `SabrStream`，`start({ videoFormat, audioFormat,
  preferMP4, preferH264 })` 得到兩軌串流 → 交給 muxer 合併。
- SABR 請求優先使用頁面原生 fetch（保留 cookie/Origin），退回 gmFetch。
- SABR 可用性取決於播放器 session，不可用時自動退化為直連 URL 路徑。

### 4.3 寫盤策略

| 條件 | 方式 |
|------|------|
| 支援 File System Access API（Chrome/Edge） | `showSaveFilePicker` → 串流寫入（邊下邊寫，記憶體占用恆定） |
| 不支援（Firefox 等） | < 2GB：in-memory Blob → anchor 下載；超過：明確拒絕並提示瀏覽器限制 |

### 4.4 UI 設計

- watch 頁：影片資訊列下方「⬇ 下載」按鈕 → 展開面板
  （畫質清單含解析度/fps/容器/大小、音軌語言下拉、並發數選擇）
- Shorts：右側操作欄「下載」按鈕 → 同一面板
- 下載中：進度條 + 速度 + 已下載/總量 + 暫停/取消
- 佇列：一次執行一個任務，面板顯示等待中的任務
- 樣式內嵌、跟隨 YouTube 深淺色主題（`--yt-spec-*` 變數）

## 5. 專案結構與發布

```
userscripts/youtube-direct-downloader/
  package.json          ← 獨立（type: module），deps 如上
  build.mjs             ← esbuild bundle + userscript header banner
  src/…（如上圖）
  node_modules/         ← .gitignore（repo 不入庫）

tests/                        ← 子專案內自帶 tests/ 目錄
  package.json 的 "test": "node --test tests/*.test.mjs"
  （自包含，不混入網站 repo 的 tests/*.test.ts glob）
```

- 產物：`public/apks/youtube-direct-downloader.user.js`（commit 入庫）
- `tools.json` 加條目（id: `youtube-direct-downloader`，category: Tampermonkey，
  含 installGuide 與 troubleshooting，比照 twitch-recovery 條目格式）
- Tampermonkey header：`@updateURL`/`@downloadURL` 由 ToolWeb 伺服器動態注入
  GitHub Raw（既有機制，不需自己寫）
- `@connect`：`*.youtube.com`、`*.googlevideo.com`、`*.youtubei.googleapis.com`
- `@grant`：`GM_xmlhttpRequest`、`GM_download`（退回用）、`GM_setValue/getValue`

## 6. 測試策略

單元測試（node:test，純邏輯，`userscripts/youtube-direct-downloader/`
內獨立執行 `npm test`，不依賴瀏覽器）：

- formats：視頻/音軌配對、語言優先序（瀏覽器語言 → 原聲）、畫質排序與過濾
- 評分函數：多客戶端結果的選擇邏輯
- URL 處理：googlevideo 白名單校驗、range/rn/rbuf 參數清理
- Range 計算：並發分片切分與重組

手動驗證清單（無法自動化的瀏覽器部分）：

- watch / Shorts / 年齡限制 / 需登入影片
- 直連 URL 與 SABR 兩條路徑各自觸發
- 暫停/恢復/取消、斷網重試
- Chrome（FSA API）與 Firefox（Blob 退回）
- 檔案可用性：下載後 MP4 可播放、音視頻同步

## 7. 風險與對策

| 風險 | 等級 | 對策 |
|------|------|------|
| YouTube 介面/反爬變動（本質性風險） | 高 | 多客戶端 + 頁面攔截後備；鎖定版本快速回滾 |
| SABR 依賴播放器 session，行為不穩定 | 中 | 自動退化直連路徑；UI 明示當前路徑 |
| TrustedTypes/eval 在 Tampermonkey sandbox 受限 | 中 | `unsafeWindow` 存取頁面環境；policy 名稱固定且僅接受 YT 播放器源碼 |
| bundle 體積大（估 1.5–2.5 MB） | 低 | GitHub Raw 可承受；不做 Greasy Fork 可讀版 |
| 高畫質僅出現 360p（格式未激活） | 低 | UI 提示「先在播放器選高畫質播放數秒再刷新」（同參考專案行為） |

## 8. 法律聲明

腳本僅提供技術能力，使用者應自行確保下載行為符合當地法律與
YouTube 服務條款；安裝說明中明示「僅供個人備份，勿散佈受版權保護內容」。
