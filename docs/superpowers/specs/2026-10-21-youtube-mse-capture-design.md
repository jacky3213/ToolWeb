# YouTube 攔截式下載器（MSE SourceBuffer 攔截）設計

> 日期：2026-10-21
> 狀態：待使用者核准
> 前置背景：2026-10-20 起，原 youtube-direct-downloader 的直連/SABR 兩條下載路徑，
> 因 YouTube 反爬升級（SABR-only + PO Token attestation）而全面失效，只剩 360p 可下載，
> 已判定無實用價值，決定整組替換為本方案。

## 1. 目標

在 Tampermonkey 沙箱內，攔截 YouTube 播放器餵給 `SourceBuffer` 的 fMP4 分片，
拼成完整的高畫質影片（視訊 + 音訊），不依賴直連 URL、不碰 SABR 協議、不需 PO Token。

## 2. 核心原理（已實測驗證）

YouTube 桌面版播放器使用 MSE（`MediaSource` + `SourceBuffer`）播放。它在**記憶體內部**
已完成 SABR/UMP 解密與 PO Token attestation，餵給 `SourceBuffer.appendBuffer()` 的是
**乾淨的 fMP4 分片**（無 UMP 包裝、無加密）。

實測證據（2026-10-21 探針腳本）：

```
addSourceBuffer mime=video/mp4; codecs="av01.0.08M.08"   ← AV1 高畫質
addSourceBuffer mime=audio/webm; codecs="opus"           ← 音訊軌
appendBuffer #2 init=true (ftyp/moov)                    ← init segment
16x 加速播放 → 資料持續累積、不漏段（267s 影片 → 25.44MB，video+audio 分軌完整）
```

結論：**攔 `SourceBuffer.appendBuffer` 可取得高畫質 fMP4，徹底繞開 PO Token 死結。**

## 3. 抓取策略

**第一版採用「16x 靜音完整跟播」**：

- 使用者點「下載」→ 腳本設定 `video.muted = true; video.playbackRate = 16; video.play()`
- 播放器從頭（`currentTime = 0`）加速播到尾，邊播邊攔 `appendBuffer`
- 播完（`ended` 事件）即完成攔截，觸發拼檔

**為何不先做「跳段/並行」更高速方案**：
- 16x 已可將 5 分鐘影片壓到 ~20 秒，多數情境足夠
- 跳段（`currentTime` 跳躍）會跳過中間分片、觸發重新緩衝，漏段風險高
- 先把「完整正確的檔」做對，再談加速（列為後續優化項）

**已記錄的風險**：使用者必須讓該分頁**保持在前景**；背景分頁會被瀏覽器限速，
導致攔截不完整。設計上會偵測 `visibilitychange` 並提示。

## 4. 資料流與拼檔

```
攔截層：hook MediaSource.addSourceBuffer → 包裝 SourceBuffer.appendBuffer
  ↓ 依 mime 分流
  video track（video/mp4, AV1/VP9）      audio track（audio/webm, opus）
  ↓ 依序收集分片                          ↓ 依序收集分片
  init segment + media segments           init segment + media segments
  ↓                                       ↓
  拼成 video.mp4 Blob                     拼成 audio.webm Blob
  ↓                                       ↓
  └────────── muxBlobs()（mediabunny）合併 ┘
              ↓
        存檔（File System Access 串流寫盤 / Blob 下載）
```

### 4.1 fMP4 組裝規則

- **init segment**（`ftyp` box 開頭、含 `moov`）：每個 track 各一份，必須放在**最前面**
- **media segments**：依 append 順序串接在 init segment 之後
- 判斷 init segment：`data` 前 4 bytes 為 `ftyp`（0x66 74 79 70）
- 每個 track 用一個獨立 buffer，video 與 audio **不可混接**

### 4.2 合併

復用現有 `muxer.js` 的 `muxBlobs({ videoBlob, audioBlob, container: 'mp4', target })`。
mediabunny 已支援跨容器合併（mp4 video + webm audio → 輸出 mp4），
`INPUT_FORMATS = [MP4, WEBM, MATROSKA]` 已涵蓋。

## 5. 檔案結構（在現有 userscripts/youtube-direct-downloader 內重構）

| 檔案 | 變更 |
|---|---|
| `src/capture.js` | **新增**：攔截 MediaSource/SourceBuffer，收集分片，輸出 { videoBlob, audioBlob, meta } |
| `src/playback-driver.js` | **新增**：控制播放器（16x 靜音、回捲、偵測 ended） |
| `src/muxer.js` | 復用（`muxBlobs` 不動） |
| `src/fs-writer.js` | 復用（`openOutput` / `saveBlobAs` 不動） |
| `src/main.js` | **大幅簡化**：移除直連/SABR 下載路徑，改為「攔截下載」流程 |
| `src/ui.js` | 改為「攔截下載」UI（觸發按鈕、進度、完成提示） |
| `src/yt-client.js` / `src/sabr.js` / `src/downloader.js` / `src/decipher.js` | **刪除**（不再需要 Innertube session、SABR、range 下載、decipher） |
| `src/formats.js` | 保留 `containerOf` / `formatBytes` 等純工具；移除畫質清單相關 |

## 6. UI 設計

- 影片頁仍注入「⬇ 下載」按鈕（沿用 v0.1.3 的錨定邏輯，已驗證可靠）
- 點擊後顯示面板：
  - 狀態列：「準備攔截… → 加速播放中（16x）… → 拼檔中… → 下載完成 ✅」
  - 進度：以「已攔截 MB」呈現（video/audio 分開）
  - 完成後觸發存檔（File System Access 優先，退回 Blob）

## 7. 驗證標準（完成定義）

1. 在 Chrome/Edge 開啟一支 SABR-only 高畫質影片，能下載出**可播放的 mp4**（含音訊）
2. 畫質是**播放器當前畫質**（非 360p），AV1/VP9 高畫質均能成功
3. 16x 加速下，5 分鐘影片在 ~30 秒內完成攔截
4. 分頁切到背景時，有明確提示（而非靜默產出缺損檔）
5. 既有 33 個單元測試中，仍保留有意義的（`formatBytes`、`containerOf`、`muxBlobs` 合併邏輯、UI 錨定）通過

## 8. 已知限制（誠實告知）

- **下載時間 ≈ 影片時長 / 16**，無法像直連那樣「全速拉取」
- **必須保持分頁前景**，背景會被瀏覽器限速
- **攔到的是「播放器選擇的畫質」**，若播放器自動降畫質（網路差），攔到的也會降
- 依賴 YouTube 的 MSE 播放路徑；若未來改用 WebCodecs（不解碼直接丟 frame），本方案失效
  （屆時需改攔 `VideoDecoder`，工程更大）

## 9. 後續優化（不在第一版）

- **「跳段到最新 preload 位置」加速**（第二版，使用者已指定方向）：
  每 0.5s（或更短）將 `currentTime` 跳到「播放器目前已緩衝到的最新位置」，
  讓攔截速度不再受限於「實際播放速度」，而是跟著緩衝前緣走。
  相較於「盲目跳段」，此法沿著 `video.buffered` 的緩衝邊界跳，理論上不漏段。
  實作重點：讀 `video.buffered.end(video.buffered.length - 1)` 取得緩衝前緣，
  將 `currentTime` 設到該處（或略減安全邊距），搭配 16x 播放。
  ⚠️ 風險：跳躍會觸發重新 seek，需實測是否反而更慢或漏段；先做成可開關的實驗選項。
- 自動切換到最高畫質再攔截
- 多影片佇列

---

## 待使用者確認的決策（已全數核准）

1. **抓取策略**：第一版只做「16x 完整跟播」→ ✅ 同意
2. **範圍**：整組刪除直連/SABR/decipher/Innertube session，只留攔截下載 → ✅ 同意
3. **畫質**：第一版攔「播放器當前畫質」→ ✅ 同意
4. **加速**：第一版 16x；第二版「跳段到最新 preload 位置」→ ✅ 同意

