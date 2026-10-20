# ToolWeb 單一事實來源重構 — 設計規格

- **日期：** 2026-10-20
- **狀態：** 決策完成，待使用者最終核准後進入 Phase 3（Writing Plans）
- **作者：** Claude（superpowers Phase 1）

## 範圍摘要

| 本次要做 | 本次不做 |
|---|---|
| 移除 Google Drive 全部邏輯（~350 行） | APK 不動，維持在 `public/apks/` |
| 建立 `tools.json` manifest 為唯一事實來源 | 管理 UI（`AddToolModal` 等 ~900 行）延後 |
| 目錄列舉自動發現新腳本 | 下載統計改用其他平台（維持 Sheet） |
| 移除 `data/` 與所有磁碟寫入 | `dist/apks/` 冗餘副本（無功能影響） |
| 下載統計簡化為 Sheet 單一來源 + TTL 快取 | |

**淨效果：** `server.ts` 實測 1261 行，預估降至約 450 行；P0 三個問題全部消除。

**規格與程式碼一致性核對（2026-10-20 逐行驗證）：**
所有行號斷言已對照實際檔案確認，修正了 6 處不精確處：
`Math.max` 少列 1 處（原漏 `539`，實為 4 處非 3 處）、Drive 呼叫點標示數與列舉不符（7 處全列並區分處置）、
`saveTools()` 呼叫數誤植為 9（實為 10）、`data/` 內容誤植為 3 檔（實為 4，含空目錄 `readmo/`）、
`server.ts` 行數誤植為 1270（實為 1261）。

---

## 1. 背景與已驗證的事實

目前架構同時從**兩個來源**取檔案，這是本次重構要解決的核心問題。

### 1.1 已驗證的現況

| 事實 | 證據 |
|---|---|
| 熱更新機制運作中且設計正確 | `server.ts:598-650` `refreshScriptsFromGitHub()`，開機 + 60秒 TTL |
| `public/apks/` 檔案完整（7 檔） | Glob 實測，非推測 |
| APK 實際上**已經**從本機提供 | `server.ts:974-997` 先命中 `public/apks/adskip.apk`，`server.ts:1019` 的 Drive fallback 永不執行 |
| 新增腳本在重啟後會消失 | `server.ts:603` 只更新 `apkToolsStore` 中**已存在**的工具 |
| `data/*.json` 是臨時的 | Cloud Run scale-to-zero，無持久化磁碟 |
| 下載統計會漏算「更新」 | `server.ts:691-708` 注入的 `@downloadURL` 指向 raw.githubusercontent.com，Tampermonkey 更新時**繞過伺服器** |
| `uu-preloader` 有 id 錯配 | `data/tools.json` 與 `server.ts:65` 指向不同工具，冷啟動時顯示與實際下載內容不符 |

### 1.2 問題清單

**P0**
1. Drive 每 5 分鐘全量同步並**覆寫整個工具清單**（`server.ts:433-504`），與 GitHub 互相覆蓋 → 使用者所述「兩邊拿檔案」
2. 新增腳本需手動 sync，且 sync 結果只存在臨時磁碟，重啟即失
3. 冷啟動時 `DEFAULT_PRESET_TOOLS` 與 `data/tools.json` 的 `uu-preloader` 指向不同工具 → 下載到錯的腳本

**P1**
4. `/api/sync-gdrive` 無認證（`server.ts:742` `app.all`）→ 開放寫入權限
5. 下載統計機制是三套並存互相比較（`Math.max(sheetCount, memoryDelta)`，`server.ts:459/513/532/539`）
6. 工具中繼資料存在三處：`src/data.ts`、`server.ts:43`、`public/templates/app-info.json`
7. **`data/tools.json` 與 `data/downloads_delta.json` 目前被 git 追蹤**
   （`git ls-files data/` 實測確認）。每次本機 `npm run dev` 產生的下載數字都會被 commit，
   污染版本歷史。本次刪除這兩個檔案時必須一併 `git rm --cached`。

---

## 2. 目標

1. **GitHub 成為唯一事實來源**，消除 Drive 依賴
2. **新增腳本不需 republish** — push 到 GitHub 即自動出現
3. **消除臨時磁碟依賴** — 不再有 runtime 狀態遺失風險
4. 修掉 `uu-preloader` 錯配 bug
5. 降低複雜度（core principle：降低複雜度）

### 非目標（YAGNI）

- 不做使用者帳號系統
- 不做管理後台 UI
- 不做多版本歷史瀏覽
- 不追求完整分析平台

---

## 3. 架構決策

### 3.1 資料來源：manifest + 目錄列舉（使用者已選 B）

```
tools.json (repo 根目錄，commit 進版控)
   │  顯示用中繼資料主體
   │
   ├──────────────┬──────────────────────┐
   ↓              ↓                      ↓
  APK 中繼資料   腳本中繼資料         下載統計來源
  (無自我描述能力) (有 @name/@version)   (見 3.3)
```

`public/apks/*.user.js` ← 目錄列舉，補上 manifest 缺的條目

**合併規則（單一函式，可單元測試）：**

```
for (file, meta) of manifest where file ∈ disk:
    emit(file, meta.version)          // manifest 為準
for file of disk where file ∉ manifest:
    emit(file, parseVersion(file))    // 從 @version 解析
```

manifest 有但磁碟沒有的檔案**不出現**（避免顯示死連結）。

### 3.2 移除 Google Drive

刪除 `server.ts` 中所有 Drive 邏輯（`syncGoogleDriveFolder`、`fetchFolderFilesFromGoogleDrive`、`DriveFileItem`、`syncAllToolsFromGoogleDrive`），共約 350 行。

**保留** Sheet 統計（見 3.3）—— 與 Drive 無關。

### 3.3 下載統計：保留 Google Sheet（使用者已決策）

保留 Sheet 作為**下載明細紀錄**（可查「誰在何時下載哪個版本」）。

但必須簡化 — 現行機制是三套狀態互相猜測：

```
baseDownloadCount (Drive app-info.json)
downloadCount     (data/tools.json，臨時磁碟)
downloadsDelta    (data/downloads_delta.json，臨時磁碟)
        ↓
Math.max(sheetCount, memoryDelta)   ← 猜測哪個對
```

**改為單一流程：**

1. Sheet 是唯一事實來源
2. 移除 `downloads_delta.json` 與所有 `Math.max()` 比較邏輯
3. 加 5 分鐘 TTL 記憶體快取，避免每次請求全量抓 CSV
4. Sheet 抓不到時回傳 `0` 並記錄 log，不猜測、不顯示假數字

**已知限制（使用者已知情並接受）：** 腳本的「更新」下載經由 `@downloadURL` 直接抓
raw.githubusercontent.com，**繞過伺服器**，因此 Sheet 不記錄更新次數，只記錄首次安裝。

**APK 統計：** APK 維持在 repo（見 §3.4），其下載仍走 `recordDownloadToGoogleForm()`，
與腳本共用同一份 Sheet，無需額外處理。

### 3.4 APK 維持在 repo（使用者 2026-10-20 決策：選項 C）

**實測後的量化依據：**

| 項目 | 實測值 |
|---|---|
| `adskip.apk` | 762,305 bytes（745 KB） |
| `public/apks/` 總計 | 961 KB |
| `.git` 目錄總計 | **1.5 MB** |

→ **「repo 膨脹」不構成理由**：repo 僅 1.5 MB，APK 只佔 762 KB，且已存在於 git 歷史中
（刪除也無法回收）。

**放棄 Releases 的決定性因素：**

1. GitHub 網頁版上傳器封鎖 `.apk`（使用者實測確認，允許清單含 ZIP 但無 APK）
2. `gh` CLI 本機未安裝（實測確認）
3. 走 REST API 需要 Personal Access Token — 等同完整 repo 寫入權限，
   為單一下載數字付出此代價效益不對稱
4. **APK 下載量已被 Sheet 統計涵蓋**（`recordDownloadToGoogleForm` 對 APK 與腳本皆有記錄）

**結論：APK 維持 `public/apks/adskip.apk`，下載路由不變，本次重構完全不碰 APK。**

**附帶清理項：** `dist/apks/` 是 `public/apks/` 的建置副本，但**伺服器從不讀取**它
（`server.ts:23` 的 `UPLOADS_DIR` 指向 `public/apks`）。部署時 APK 在 image 內會有兩份。
此為既有冗餘，**本次不處理**（無功能影響），列為後續優化項。

### 3.5 附錄：未採用的 APK 遷移方案（記錄用，非執行）

> **狀態：已決策走選項 C，本節僅保留調研記錄供日後重新評估。**
> 若未來 APK 體積暴增、或需要精確的 APK 下載統計，可重新評估選項 A。

**觸發本次評估的發現：GitHub 網頁版上傳器封鎖 `.apk`。**

錯誤訊息 `We don't support that file type.`，允許清單含 ZIP 但**不含 APK**。
這是 GitHub 自 2022 年底起的策略，**非使用者操作錯誤**。

`gh` CLI 在本機**未安裝**（實測 `gh --version` → command not found）。

**因此「手動上傳且改動成本不高」的先決條件不成立。** 三個選項：

| 選項 | 一次性成本 | 每次發版成本 | 取得的下載網址 | 代價 |
|---|---|---|---|---|
| **A. curl + Personal Access Token** | 建立 PAT（勾 `repo` scope） | 1 條 curl 指令 | `.../download/v1.5/adskip.apk` ✅乾淨 | PAT 等同完整 repo 寫入權限，須妥善保管與設到期日 |
| **B. 改名為 `.zip` 上傳** | 0 | 重新命名再拖曳 | `.../download/v1.5/adskip-v1.5.zip` ❌ | 使用者下載後必須自行改名為 `.apk` 才能安裝 |
| **C. APK 留在 repo** | 0 | 正常 commit | `site.com/api/download/adskip.apk` ✅乾淨 | 失去 Releases 的 `download_count`，但 Sheet 統計仍涵蓋 APK |

**證據強度說明（區分已驗證與推測）：**

| 主張 | 強度 |
|---|---|
| 網頁 UI 阻擋 `.apk` | ✅ 已驗證（使用者實測） |
| `gh` 未安裝 | ✅ 已驗證（實測） |
| REST API 可接受 `.apk` | ⚠️ **未驗證** — 依據是多個公開 GitHub Action 上傳 `app-debug.apk` 的既有用法，但本專案尚未實測 |

**建議：若不想處理 PAT，選項 C（維持 APK 在 repo）是合理的。**
理由：`.git` 僅 1.5 MB，APK 只佔 762 KB 且已在歷史中；
APK 下載量仍可從 Sheet 統計取得（目前 `recordDownloadToGoogleForm` 已涵蓋 APK 下載）。
為了單一數字欄位付出 PAT 管理成本，效益不對稱。

> 若走選項 A，PAT 僅用於上傳，**絕不寫入 repo 或任何檔案**，並設定到期日。

### 3.6 選項 A 的具體操作（若選 A）

```bash
# 1. 建立 PAT：https://github.com/settings/tokens → Generate new token (classic)
#    勾選 repo scope，設定到期日（例如 90 天）

# 2. 建立 Release 並上傳（-F 指定檔案）
gh release create v1.5 public/apks/adskip.apk \
  --repo jacky3213/ToolWeb \
  --title "開屏跳過 v1.5" \
  --notes ""

# 或不用 gh，直接打 API：
# curl -X POST https://uploads.github.com/repos/jacky3213/ToolWeb/releases/<id>/assets?name=adskip.apk \
#   -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/octet-stream" \
#   --data-binary @public/apks/adskip.apk
```

**遷移期的雙軌：** 若走選項 A 或 B，部署後 `public/apks/adskip.apk` 暫時保留一版作為回退，
確認新網址運作正常後，下一個 commit 移除。

---

## 4. 元件設計

### 4.1 `tools.json`（repo 根目錄，新增）

顯示用中繼資料。欄位沿用現有 `ApkTool` 型別（`src/types.ts`），但移除 `downloadCount`
（那是 runtime 統計，不該在 manifest）。

> **命名釐清：** 此檔案取代並**刪除** `data/tools.json`。兩者同名但語意相反：
> 前者是 commit 進版控的唯讀來源，後者是 runtime 產生的可變狀態。
> 遷移期間不可同時存在，Task 1 會先刪除舊檔再建立新檔，避免 `data/` 重新被寫入。

### 4.2 `loadManifest()`（server.ts）

啟動時讀取 `tools.json`。檔案不存在時報錯並退出（fail fast，不猜測）。

### 4.3 `discoverScriptsFromDisk()`

列舉 `public/apks/`，對 manifest 未涵蓋的 `.user.js` 自動建立條目，
用 `@name` / `@version` / `@description` 填最小欄位，`category` 預設 `'Tampermonkey'`。

### 4.4 `refreshScriptsFromGitHub()`（保留並調整）

原樣保留 60 秒 TTL 與動態注入 metadata 的邏輯（這是現有資產）。
調整：改為對 `discoverScriptsFromDisk()` 的輸出全部生效，而非僅既有 store。

---

## 5. 刪除清單

| 項目 | 位置 | 理由 |
|---|---|---|
| `fetchFolderFilesFromGoogleDrive()` | `server.ts:249-285` | Drive 依賴（37 行） |
| `syncGoogleDriveFolder()` | `server.ts:288-581` | Drive 依賴（294 行） |
| `syncAllToolsFromGoogleDrive()` | `server.ts:583-589` | Drive 依賴 |
| `DriveFileItem` interface | `server.ts:243-247` | Drive 依賴 |
| `DEFAULT_PRESET_TOOLS` | `server.ts:43-91` | P0-3 錯配來源 |
| `Math.max()` 猜測邏輯 **×4** | `server.ts:459, 513, 532, 539` | 統計簡化後不需要 |
| `src/data.ts` | 整檔 | 死代碼（`INITIAL_TOOLS` 已 import 未使用） |
| `public/templates/app-info.json` | 整檔 | Drive 同步用 |
| `/api/sync-gdrive` | `server.ts:742-757` | P1-4 無認證 |
| `data/` 全部內容 | `data/.gitkeep`、`data/tools.json`、`data/downloads_delta.json`、**空目錄 `data/readmo/`** | 臨時磁碟依賴 |

**`drive.google.com` 全部 7 處出現與處置（已於 2026-10-20 逐行核對）：**

| 行號 | 所在位置 | 處置 |
|---|---|---|
| 58 | `DEFAULT_PRESET_TOOLS` 內 | 隨該常數刪除 |
| 255 | `fetchFolderFilesFromGoogleDrive()` 內 | 隨函式刪除 |
| 584 | `syncAllToolsFromGoogleDrive()` 內 | 隨函式刪除 |
| 744 | `/api/sync-gdrive` 內 | 隨端點刪除 |
| 909 | `GET /api/tools/:id/download` 的 `targetUrl` 預設值 | **需手動改** |
| 1019 | `GET /api/tools/:id/download` 的 Drive fallback 分支 | **需手動改** |
| 1095 | `GET /api/download/:filename` 的 Drive fallback 分支 | **需手動改** |

> **注意：只有 3 處（909、1019、1095）需要人工修改**，其餘 4 處都隨程式碼刪除而消失。

**刪除 `data/` 的連帶影響 —寫入點盤點：**

`saveTools()` 定義於 `server.ts:124`，`saveDeltas()` 定義於 `server.ts:156`。
全檔共有 **10 個 `saveTools()` 與 5 個 `saveDeltas()` 呼叫點**，逐一處置如下：

| 行號 | 呼叫 | 所屬功能 | 處置 |
|---|---|---|---|
| 143 | `saveTools()` | 開機 | 移除 |
| 558–559 | `saveTools()` `saveDeltas()` | Drive 同步結尾 | 隨 Drive 刪除 |
| 644 | `saveTools()` | `refreshScriptsFromGitHub` | **改為記憶體更新** |
| 828 | `saveTools()` | `POST /api/tools` | 隨管理 API 刪除（§6-B 延後） |
| 840–841 | `saveTools()` `saveDeltas()` | `POST /:id/download-count` | 隨統計簡化移除 |
| 886 | `saveTools()` | `DELETE /api/tools/:id` | 隨管理 API 刪除（§6-B 延後） |
| 897 | `saveTools()` | `POST /api/tools/clear` | 隨管理 API 刪除（§6-B 延後） |
| 924–925 | `saveTools()` `saveDeltas()` | `GET /:id/download` | `saveDeltas` 移除 |
| 1057–1058 | `saveTools()` `saveDeltas()` | `GET /download/:filename` (zip) | `saveDeltas` 移除 |
| 1124–1125 | `saveTools()` `saveDeltas()` | `GET /download/:filename` (js) | `saveDeltas` 移除 |

> **⚠️ 跨變更相依：** 828、886、897 三處位於「延後處理」的管理 API 中，
> 而它們依賴的 `saveTools()` 會在本次被移除。**這代表 §6-B 的管理 UI 清理不能無限期延後**，
> 否則會留下呼叫已刪除函式的壞程式碼。
> 處理方式：本次先將這三處的 `saveTools()` 改為記憶體操作（與 644 相同處理），
> 待管理 UI 刪除時整段移除。

**淨結果：** 刪除後 `apkToolsStore` 只存在於記憶體，由 manifest + 目錄列舉決定，無任何磁碟寫入。

**注意：** `server.ts:98-121` 讀取 `data/tools.json` 的啟動邏輯也一併移除，
改由 `loadManifest()` 讀 repo 根目錄的 `tools.json`。

**不刪除（使用者選擇保留）：**
- `recordDownloadToGoogleForm()` / `fetchDownloadCountsFromGoogleSheet()` — Sheet 明細紀錄，
  但需加 5 分鐘 TTL 快取並移除 `Math.max()` 猜測（見 §3.3）
- `AddToolModal` / `AdminPasscodeModal` — 本次不動，列為後續清理項（見 §6-B）

---

## 6. 未決事項 — 已全部決策

- **A. 下載統計** → **保留 Google Sheet**，簡化流程，見 §3.3 ✅
- **B. 管理 UI** → **拆分處理**（使用者 2026-10-20 決策）

  **本次刪除（與 Drive 強耦合，移除 Drive 後必然失效）：**
  | 項目 | 行數 | 理由 |
  |---|---|---|
  | `POST /api/sync-gdrive` | `server.ts:742-757` | Drive 依賴，保留即失效 |
  | `handleSyncDrive()` | `App.tsx:113-~150` | 呼叫上述端點 |
  | `onSyncDrive` prop | `Header.tsx` | 同步按鈕 UI |
  | 「同步 Google Drive」按鈕 | `Header.tsx` | 移除 Drive 後無意義 |

  **延後至後續變更（與本次重構無關的獨立議題）：**
  | 項目 | 行數 | 說明 |
  |---|---|---|
  | ~~`AddToolModal.tsx`~~ | 496 | ✅ 已於 2026-10-20 完成清理 |
  | ~~`AdminPasscodeModal.tsx`~~ | 209 | ✅ 已於 2026-10-20 完成清理 |
  | ~~`App.tsx` 管理相關 state/handler/render~~ | ~100 | ✅ 已清理 |
  | ~~`Header` / `ToolCard` 相關 props~~ | ~25 | ✅ 已清理 |
  | ~~`POST /api/tools`~~ | — | ✅ 已移除 |
  | ~~`DELETE /api/tools/:id`、`POST /api/tools/clear`~~ | — | ✅ 已移除 |
  | ~~`POST /api/upload-apk`~~ | — | ✅ 已移除 |
  | ~~`adminPasscode` / `isPasscodeRequired` 整套~~ | — | ✅ 已移除 |

  **最終結果：** 網站成為純唯讀的下載站，伺服器只剩 4 個端點
  （`GET /api/tools`、兩個下載路由、`POST /api/chat`）。
  發布流程改為編輯 `tools.json` + 把檔案放入 `public/apks/`。
  `data/` 目錄已完全刪除（啟動實測確認不會重新建立）。

  **拆分理由：** 移除 Drive 是**後端資料來源**變更（單一檔案 `server.ts`，約 350 行）；
  移除管理 UI 是**前端產品決策**（8 個檔案，約 900 行）。混在同一次變更裡，
  若出問題無法判斷是哪一項造成，且會讓 `git diff` 失去可讀性。
  兩者風險等級與關注點都不同，應分開提交。

- **C. APK 遷移 Releases** → **放棄遷移，維持在 repo**（使用者 2026-10-20 決策，選項 C）。
  GitHub 網頁上傳器封鎖 `.apk`、`gh` 未安裝、API 路徑需 PAT，
  而 APK 下載量已被 Sheet 統計涵蓋 — 成本與效益不對稱。詳見 §3.4。
- **D. 未追蹤暫存檔** → `.op_old.js`（olevod v1.2.4 舊版）與 `.uu_diff.txt`（diff 輸出）
  皆為未進版控的開發殘留，已確認無用途並刪除 ✅

---

## 7. 下載統計方案對比

| 方案 | 成本 | 維護 | 能否統計腳本 | 能否統計 APK | 時間戳明細 |
|---|---|---|---|---|---|
| Google Sheets（現況） | 免費 | 中（Form+Sheet 兩處） | ✅ 但漏算更新 | ✅ | ✅ |
| GitHub Releases `download_count` | 免費 | **零** | ❌ | ✅ | ❌ |
| Cloud Logging | 免費 | 中（需 gcloud CLI） | ✅ | ✅ | ✅（30天留存） |
| 完全不做 | 免費 | 零 | ❌ | ❌ | ❌ |

**關鍵限制：** 使用者腳本的「更新」下載已經繞過伺服器（`@downloadURL` 指向 raw.githubusercontent.com），
**現有 Sheet 也已經漏算這部分**。所以現有數字本來就不完整。

**決策：保留 Sheet（使用者 2026-10-20 決定）**，理由是使用者有查詢下載明細的需求。
Sheet 保留但需簡化，見 §3.3。APK 亦由同一份 Sheet 統計（維持在 repo，見 §3.4）。

---

## 8. 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 多實例 TTL 獨立，冷啟動期間版本不一致 | 使用者拿到不同版本（數分鐘） | 接受現狀；使用者自行評估 |
| manifest 欄位寫錯 | 顯示錯誤資訊 | 目錄列舉仍保證腳本可下載 |
| 刪除 Drive 後無法回退 | — | git 可還原；且 Drive 資料仍在原處不動 |
| 刪除 `data/tools.json` 遺失既有下載數 | 已累積的計數歸零重新累積 | 下載數本就是 runtime 統計，歷史值無意義；Sheet 明細不受影響 |

---

## 9. 驗證策略

依 superpowers「證據優於聲明」：每個任務完成後執行 `npm test`（新增）與 `npm run lint`，
並實際啟動 `npm run dev` 打 API 驗證，不接受「應該可以」。

---

## 10. 執行分支

使用者已選擇**直接在 `main` 上修改**（因 AI Studio 只 pull main，開分支會脫節）。
所有變更以小步 commit 進行，每步可 `git diff` 檢查。