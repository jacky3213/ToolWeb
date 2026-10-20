# APK & Tampermonkey 工具發布中心

個人開發工具的發布站：Android APK 套件與 Tampermonkey 使用者腳本。

## 架構

**單一事實來源是 GitHub repo**，網站本身不保存任何設定或狀態。

| 元件 | 位置 | 職責 |
|---|---|---|
| `tools.json` | repo 根目錄 | 工具顯示中繼資料（名稱、描述、分類、changelog、安裝說明） |
| `public/apks/*.user.js` | repo | Tampermonkey 腳本，透過 GitHub Raw 提供熱更新 |
| `public/apks/*.apk` | repo | Android APK 與 Chrome 擴充套件 |
| `lib/` | 伺服器端純邏輯 | manifest 合併、目錄列舉、腳本 metadata 解析 |

工具清單在開機時由兩份資料合併而成：

```
tools.json (manifest)          public/apks/ (目錄列舉)
   │                                  │
   │  提供顯示用中繼資料                │  提供「哪些檔案真的存在」
   └──────────────┬───────────────────┘
                  ↓
        reconcile() 合併
```

合併規則（定義於 `lib/reconcile-tools.ts`）：

1. **兩者都有** → 以 manifest 為準（顯示資料可人工潤飾）
2. **只有目錄有** → 自動建立條目，名稱/版本從腳本的 `@name`/`@version` 讀取
3. **只有 manifest 有** → 略過，避免顯示會 404 的死連結

### 為什麼腳本走 GitHub Raw，APK 留在 repo

Tampermonkey 的 `@updateURL` / `@downloadURL` 必須指向**穩定且公開**的網址。
GitHub Raw 符合這個條件；AI Studio 的預覽 domain 是暫時的、且可能需要認證，
會讓 Tampermonkey 的更新檢查**靜默失敗**。

伺服器在回傳腳本時會動態注入這兩個欄位（`formatScriptWithDynamicMetadata()`），
把它們統一導向 GitHub Raw。

APK 不需要自動更新機制，由伺服器直接從 `public/apks/` 提供即可。

> 曾評估過改用 GitHub Releases 託管 APK，但 GitHub 網頁上傳器封鎖 `.apk`，
> 改用 API 則需要等同完整 repo 寫入權限的 Personal Access Token。
> 考量到 repo 僅 1.5 MB、APK 下載量已由 Sheet 統計涵蓋，故維持現狀。
> 詳見設計文件 §3.4。

### 熱更新流程

修改 `public/apks/*.user.js` 並 push 到 GitHub 後：

1. 伺服器每 60 秒檢查一次目錄與 GitHub Raw
2. **既有腳本的內容更新** —— 自動套用
3. **全新腳本** —— 自動建立條目並出現在網站上，**不需要重新部署**

重建清單時會保留使用者當次下載累積的計數，避免數字跳動。

> ⚠️ 由於「目錄是事實來源」，若部署時 `public/apks/` 的檔案沒有進到 image，
> 網站會顯示為空白。啟動 log 會明確列出缺少的檔名，請留意 `[Config] ⚠️`。

## 開發

```bash
npm install
npm run dev      # 開發伺服器 http://localhost:3000
npm run lint     # TypeScript 型別檢查
npm test         # 單元測試
npm run build    # 建置至 dist/
```

### 測試

使用 Node 內建的 `node:test` 搭配既有的 `tsx`，**零額外依賴**：

```bash
npm test                                            # 全部測試
node --import tsx --test tests/reconcile-tools.test.ts   # 單一檔案
```

測試涵蓋 `lib/` 下的純邏輯：腳本 metadata 解析、manifest 合併、
目錄列舉、下載統計的 TTL 快取與單調性。

## 部署

push 至 `main` 分支後，於 Google AI Studio 重新 pull 並發布。

需要的環境變數：

| 變數 | 用途 | 是否必需 |
|---|---|---|
| `GEMINI_API_KEY` | AI 助理功能 | 選用 |
| `ADMIN_PASSCODE` | 管理員權限 | 選用（未設定則每次重啟產生隨機密碼） |
| `GITHUB_RAW_BASE` | 腳本 Raw CDN 位置 | 選用（有預設值） |

## 下載統計

以 **Google Sheet** 為唯一事實來源（設定於 `server.ts` 的 `GOOGLE_FORM_CONFIG`）。

- 下載時伺服器寫入 Google Form，並以 **5 分鐘 TTL 快取**讀取 CSV 統計
- 顯示值採**單調不減**（取 Sheet 值與本機計數的較大者），
  避免 Google Form 寫入延遲導致數字「先跳上去再掉回來」

> **已知限制：** 使用者腳本的「更新」下載由 Tampermonkey 直接從 GitHub Raw 取得，
> **繞過伺服器**，因此統計只涵蓋首次安裝，不含自動更新。

## 設計文件

重構的完整決策記錄位於 [`docs/superpowers/`](./docs/superpowers/)：

- `specs/` — 設計規格（問題分析、架構決策、風險）
- `plans/` — 實作計劃（任務拆解與驗證方式）