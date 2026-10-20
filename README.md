# APK & Tampermonkey 工具發布中心

個人開發工具的發布站：Android APK 套件與 Tampermonkey 使用者腳本。

## 架構

**單一事實來源是 GitHub repo**，網站本身不保存任何設定或狀態 —— 是一個純唯讀的下載站。

| 元件 | 位置 | 職責 |
|---|---|---|
| `tools.json` | repo 根目錄 | 工具顯示中繼資料（名稱、描述、分類、changelog、安裝說明） |
| `public/apks/*.user.js` | repo | Tampermonkey 腳本，透過 GitHub Raw 提供熱更新 |
| `public/apks/*.apk` | repo | Android APK 與 Chrome 擴充套件 |
| `lib/` | 伺服器端純邏輯 | manifest 合併、目錄列舉、腳本 metadata 解析 |

伺服器只有四個端點，全部是唯讀的：

| 端點 | 用途 |
|---|---|
| `GET /api/tools` | 工具清單 |
| `GET /api/tools/:id/download` | 由工具 id 觸發下載 |
| `GET /api/download/:filename` | 直接下載腳本 / APK |
| `POST /api/chat` | AI 助理（需 `GEMINI_API_KEY`） |

### 發布新工具

網站沒有後台，發布流程就是編輯檔案：

1. 把 `.user.js` 或 `.apk` 放進 `public/apks/`
2. 在 `tools.json` 加一筆，填寫名稱、描述、分類、changelog 等顯示資料
   （省略也可以 —— 腳本的名稱與版本會從 `@name` / `@version` 自動解析，
   只是不會有 icon、changelog、安裝說明這些豐富欄位）
3. commit + push

工具會在**約一分鐘內**自動出現在網站上，不需要重新部署。

> 刪除工具 = 從 `public/apks/` 移除檔案，並從 `tools.json` 刪掉該筆。
> 檔案不見時 manifest 條目會被自動略過，不會留下死連結。

### 熱更新

伺服器每 60 秒檢查一次目錄與 GitHub Raw：

- **既有腳本的內容更新** —— 自動套用
- **全新腳本** —— 自動建立條目並出現在網站上，**不需要重新部署**

重建清單時會保留使用者當次下載累積的計數，避免數字跳動。

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

### 熱更新的注意事項

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
| `GEMINI_API_KEY` | AI 助理功能（`POST /api/chat`） | 選用 |
| `GITHUB_RAW_BASE` | 腳本 Raw CDN 位置 | 選用（有預設值） |

> 網站已無任何寫入端點，因此不需要 `ADMIN_PASSCODE`。

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