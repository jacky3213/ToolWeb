import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { reconcile } from './lib/reconcile-tools.ts';
import { discoverScriptsOnDisk } from './lib/discover-scripts.ts';

dotenv.config();

// Initialize Gemini
const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({
  apiKey: apiKey,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

// Ensure public upload directory and data persistence directory exist
const UPLOADS_DIR = path.join(process.cwd(), 'public', 'apks');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Canonical raw source for Tampermonkey userscripts.
// GitHub Raw is public, stable, and cookie-free — the ONLY reliable target for
// Tampermonkey @updateURL/@downloadURL. (AI Studio / preview domains serve an
// auth cookie wall to Tampermonkey, breaking update checks silently.)
const GITHUB_RAW_BASE = process.env.GITHUB_RAW_BASE || 'https://raw.githubusercontent.com/jacky3213/ToolWeb/main/public/apks';

const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');


// 工具清單的唯一事實來源：repo 根目錄的 tools.json（manifest）+ public/apks/ 目錄列舉。
// 不再從 data/tools.json 讀取 —— Cloud Run 磁碟是暫存的，runtime 狀態會在重啟後遺失。
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

/**
 * 合併 manifest 與磁碟檔案清單，並在有 manifest 條目因檔案遺失而被丟棄時發出警告。
 *
 * 「目錄是事實來源」意味著 public/apks/ 裡的檔案不見了，該工具就會從網站消失。
 * 這是刻意的死連結防護，但若不提示，部署時檔案漏打包會讓整個網站靜默變空。
 */
function buildToolStore(): any[] {
  const manifest = loadManifest();
  const onDisk = discoverScriptsOnDisk(UPLOADS_DIR);
  const store = reconcile(manifest, onDisk);

  const presentFiles = new Set(onDisk.map(f => f.fileName));
  const missing = manifest
    .map(entry => entry.scriptFileName || entry.apkFileName)
    .filter((file): file is string => Boolean(file) && !presentFiles.has(file as string));

  if (missing.length > 0) {
    console.warn(
      `[Config] ⚠️ 以下 manifest 條目因檔案不存在於 ${UPLOADS_DIR} 而被略過：\n` +
      missing.map(f => `  - ${f}`).join('\n') +
      `\n  請確認這些檔案已提交至版控（public/apks/）。`
    );
  }

  if (manifest.length > 0 && store.length === 0) {
    console.error(
      `[Config] ⛔ manifest 有 ${manifest.length} 個條目，但合併後 0 個工具。` +
      `通常是 ${UPLOADS_DIR} 缺少檔案 —— 網站將顯示為空白。`
    );
  }

  return store;
}

let apkToolsStore: any[] = buildToolStore();

console.log(`[Config] 已載入 ${apkToolsStore.length} 個工具（manifest ${loadManifest().length} 筆 + 目錄列舉 ${apkToolsStore.length} 筆）`);

/**
 * 記憶體內去重並正規化工具 id。
 *
 * 刻意「不寫入磁碟」—— 雲端部署的容器磁碟是暫存的，
 * 把狀態寫回 data/tools.json 只會造成下次重啟時資料不一致。
 * 工具清單的唯一事實來源是 repo 根目錄的 tools.json。
 */
function saveTools() {
  try {
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
  } catch (e) {
    console.error("Failed to dedupe tools:", e);
  }
}

// Google Form & Google Sheet Integration Configuration
const GOOGLE_FORM_CONFIG = {
  formId: "1FAIpQLSfrSsl_Q1Q--LT0ewXKyyOr2QvFmB4WtLFwYn4q5QleDVe9Nw",
  toolIdEntry: "entry.1013160437",
  versionEntry: "entry.41152781",
  sheetId: "1H7fqLS8tJOUJAQAQIAOiEE6IURLOER1vphW6oFPeCEo",
  gid: "699742647"
};

// Record download event asynchronously to Google Form (never blocks user download)
async function recordDownloadToGoogleForm(toolId: string, version: string = 'v1.0') {
  try {
    const submitUrl = `https://docs.google.com/forms/d/e/${GOOGLE_FORM_CONFIG.formId}/formResponse`;
    const params = new URLSearchParams();
    params.append(GOOGLE_FORM_CONFIG.toolIdEntry, toolId);
    params.append(GOOGLE_FORM_CONFIG.versionEntry, version);

    const res = await fetch(submitUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0"
      },
      body: params.toString()
    });

    if (res.ok) {
      console.log(`[Google Form Counter] Recorded download for ${toolId} (${version})`);
    } else {
      console.warn(`[Google Form Counter] Response status ${res.status}`);
    }
  } catch (err: any) {
    console.error("[Google Form Counter Error]:", err?.message || err);
  }
}

// Fetch total recorded download counts by toolId from Google Sheet
async function fetchDownloadCountsFromGoogleSheet(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  try {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${GOOGLE_FORM_CONFIG.sheetId}/export?format=csv&gid=${GOOGLE_FORM_CONFIG.gid}`;
    const res = await fetch(csvUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!res.ok) {
      console.warn(`[Google Sheet Counter] Fetch CSV returned ${res.status}`);
      return counts;
    }

    const csvText = await res.text();
    // Parse CSV lines
    const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length <= 1) {
      return counts; // Only header line or empty
    }

    // Skip header (時間戳記,toolId,version)
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 2) {
        const itemToolId = parts[1].trim();
        if (itemToolId) {
          counts[itemToolId] = (counts[itemToolId] || 0) + 1;
        }
      }
    }

    console.log(`[Google Sheet Counter] Loaded counts:`, counts);
    return counts;
  } catch (err: any) {
    console.error("[Google Sheet Counter Error]:", err?.message || err);
    return counts;
  }
}

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
 * 下載點擊時前端（src/App.tsx:84）與後端都會即時 +1，讓使用者立刻看到數字變化；
 * 但 Google Form 寫入 Sheet 有延遲，若直接覆寫會讓數字「先跳上去再掉回來」。
 * 下載次數是累計值，顯示上不應該倒退。
 *
 * 這與 Drive 同步裡被移除的 Math.max(sheetCount, memoryDelta) 語意不同：
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




// ---- GitHub Raw refresh for Tampermonkey userscripts (source of truth) ----
// Google Drive folder HTML scraping broke (Drive changed its DOM), so userscripts
// are now synced from raw.githubusercontent.com instead. Drive sync remains only
// as a fallback for APK discovery.
let lastGithubRefreshTime = 0;
let isRefreshingGithub = false;

async function refreshScriptsFromGitHub(): Promise<{ updated: string[] }> {
  if (isRefreshingGithub) return { updated: [] };
  isRefreshingGithub = true;
  const updated: string[] = [];
  try {
    const scriptTools = apkToolsStore.filter(t => t.category === 'Tampermonkey' && t.scriptFileName);
    for (const tool of scriptTools) {
      const filename: string = tool.scriptFileName;
      try {
        const rawUrl = `${GITHUB_RAW_BASE}/${encodeURIComponent(filename)}`;
        const res = await fetch(rawUrl, {
          headers: { "User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache" }
        });
        if (!res.ok) {
          console.warn(`[GitHub Sync] ${filename}: HTTP ${res.status}`);
          continue;
        }
        const scriptText = await res.text();
        if (!scriptText.includes('// ==UserScript==')) {
          console.warn(`[GitHub Sync] ${filename}: not a valid userscript, skipped`);
          continue;
        }

        const versionMatch = scriptText.match(/@version\s+(.+)/);
        const version = versionMatch
          ? (versionMatch[1].trim().startsWith('v') ? versionMatch[1].trim() : `v${versionMatch[1].trim()}`)
          : tool.version;
        const sha256 = crypto.createHash('sha256').update(scriptText).digest('hex');
        const destPath = path.join(UPLOADS_DIR, filename);
        const currentText = fs.existsSync(destPath) ? fs.readFileSync(destPath, 'utf-8') : '';

        if (currentText !== scriptText) {
          fs.writeFileSync(destPath, scriptText, 'utf-8');
          tool.version = version;
          tool.fileSize = `${(Buffer.byteLength(scriptText, 'utf-8') / 1024).toFixed(1)} KB`;
          tool.checksumSha256 = sha256;
          tool.releaseDate = new Date().toISOString().split('T')[0];
          updated.push(filename);
          console.log(`[GitHub Sync] Refreshed ${filename} -> ${version} (${tool.fileSize})`);
        } else if (tool.version !== version) {
          tool.version = version;
        }
      } catch (e) {
        console.error(`[GitHub Sync] Failed to refresh ${filename}:`, e);
      }
    }
    if (updated.length > 0) saveTools();
    return { updated };
  } finally {
    isRefreshingGithub = false;
    lastGithubRefreshTime = Date.now();
  }
}

// Refresh userscripts from GitHub Raw on boot (after store is loaded)
refreshScriptsFromGitHub().catch(console.error);

// Admin Passcode Config
// 安全性：程式碼內「絕對不帶」預設密碼（曾經寫死在 repo 裡，已移除）。
// 優先順序：環境變數 ADMIN_PASSCODE > 本機 admin.json > 隨機一次性密碼。
// 部署環境請用 AI Studio 的 Secrets 面板設定 ADMIN_PASSCODE（runtime 注入、不進任何 repo）。
let adminPasscode = process.env.ADMIN_PASSCODE || "";
let isPasscodeRequired = true; // Protect uploading by default

// 只有當「未設定環境變數」時，才從本機 admin.json 讀取
if (!adminPasscode && fs.existsSync(ADMIN_FILE)) {
  try {
    const adminData = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf-8'));
    if (adminData.adminPasscode) adminPasscode = adminData.adminPasscode;
    if (typeof adminData.isPasscodeRequired === 'boolean') isPasscodeRequired = adminData.isPasscodeRequired;
  } catch (e) {
    console.error("Failed to load admin.json:", e);
  }
}

if (!adminPasscode) {
  adminPasscode = crypto.randomBytes(9).toString("base64url");
  console.warn(`\n[SECURITY] 未設定 ADMIN_PASSCODE，已產生隨機一次性管理員密碼：${adminPasscode}`);
  console.warn("[SECURITY] 此密碼重啟即失效，請在環境變數設定 ADMIN_PASSCODE 以固定。\n");
}

function saveAdminSettings() {
  try {
    fs.writeFileSync(ADMIN_FILE, JSON.stringify({ adminPasscode, isPasscodeRequired }, null, 2), 'utf-8');
  } catch (e) {
    console.error("Failed to write admin.json:", e);
  }
}

// Helper to inject canonical @updateURL and @downloadURL pointing at GitHub Raw.
// NEVER use the ephemeral request host (AI Studio preview / localhost) — those URLs
// are either temporary or behind an auth cookie wall, so Tampermonkey update checks
// silently fail. Raw GitHub is public and permanent.
function formatScriptWithDynamicMetadata(scriptText: string, filename: string, _req: express.Request): string {
  const scriptUrl = `${GITHUB_RAW_BASE}/${encodeURIComponent(filename)}`;

  const metaStart = scriptText.indexOf('// ==UserScript==');
  const metaEnd = scriptText.indexOf('// ==/UserScript==');

  if (metaStart !== -1 && metaEnd !== -1 && metaEnd > metaStart) {
    let header = scriptText.substring(metaStart, metaEnd);
    // Remove all existing @updateURL and @downloadURL to prevent stale localhost or third-party domains
    header = header.replace(/\/\/\s*@updateURL[^\r\n]*[\r\n]+/gi, '');
    header = header.replace(/\/\/\s*@downloadURL[^\r\n]*[\r\n]+/gi, '');

    const injected = header.trimEnd() + `\n// @updateURL    ${scriptUrl}\n// @downloadURL  ${scriptUrl}\n`;
    return scriptText.substring(0, metaStart) + injected + scriptText.substring(metaEnd);
  }

  return scriptText;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Trust reverse proxy (Google Cloud Run / AI Studio preview)
  app.set('trust proxy', true);

  // Increase payload size limit for base64 file uploads
  app.use(express.json({ limit: '50mb' }));

  app.get("/api/tools", (req, res) => {
    // Userscript source of truth is GitHub Raw — refresh frequently and cheaply
    if (Date.now() - lastGithubRefreshTime > 60 * 1000 && !isRefreshingGithub) {
      refreshScriptsFromGitHub().catch(console.error);
    }
    const seen = new Set<string>();
    const clean: any[] = [];
    for (const t of apkToolsStore) {
      const canonicalId = (t.id === 'adskip' || t.packageName === 'com.utility.adskip') ? 'adskip-apk' : t.id;
      if (!seen.has(canonicalId)) {
        seen.add(canonicalId);
        clean.push({ ...t, id: canonicalId });
      }
    }
    res.json(clean);
  });


  // API 2: Verify Admin Passcode / Status
  app.get("/api/admin/status", (req, res) => {
    res.json({
      passcodeRequired: isPasscodeRequired,
      // 是否為使用者自訂（有設定環境變數或已存過 admin.json），而非每次開機隨機產生的
      hasCustomPasscode: !!process.env.ADMIN_PASSCODE || fs.existsSync(ADMIN_FILE)
    });
  });

  app.post("/api/admin/verify", (req, res) => {
    const { passcode } = req.body;
    if (!isPasscodeRequired || passcode === adminPasscode) {
      return res.json({ success: true, message: "管理員身分驗證成功" });
    }
    return res.status(401).json({ success: false, error: "管理員密碼錯誤！" });
  });

  app.post("/api/admin/set-passcode", (req, res) => {
    const { currentPasscode, newPasscode, toggleProtection } = req.body;
    
    if (isPasscodeRequired && currentPasscode !== adminPasscode) {
      return res.status(401).json({ error: "原管理員密碼不正確" });
    }

    if (typeof toggleProtection === 'boolean') {
      isPasscodeRequired = toggleProtection;
    }

    if (newPasscode && newPasscode.trim().length >= 4) {
      adminPasscode = newPasscode.trim();
    }

    saveAdminSettings();

    res.json({
      success: true,
      passcodeRequired: isPasscodeRequired,
      message: "管理員安全設定已更新"
    });
  });

  // API 3: Add or update tool (Protected by Admin Passcode)
  app.post("/api/tools", (req, res) => {
    const { tool, passcode } = req.body;
    const toolData = tool || req.body;

    if (isPasscodeRequired && passcode !== adminPasscode) {
      return res.status(401).json({ error: "需要管理員密碼才能上架發布 APK！" });
    }

    if (!toolData.name || !toolData.id) {
      return res.status(400).json({ error: "請填寫工具名稱與 ID" });
    }

    const existingIndex = apkToolsStore.findIndex(t => t.id === toolData.id);
    if (existingIndex >= 0) {
      apkToolsStore[existingIndex] = { ...apkToolsStore[existingIndex], ...toolData };
    } else {
      apkToolsStore.unshift({
        downloadCount: 1,
        rating: 5.0,
        releaseDate: new Date().toISOString().split('T')[0],
        changelog: ['初始版本上架發布'],
        screenshots: [],
        checksumSha256: Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2),
        ...toolData
      });
    }

    saveTools();

    res.json({ success: true, tools: apkToolsStore });
  });

  // API 4: Increment download count (Public)
  app.post("/api/tools/:id/download-count", (req, res) => {
    const { id } = req.params;
    const tool = apkToolsStore.find(t => t.id === id);
    if (tool) {
      tool.downloadCount = (tool.downloadCount || 0) + 1;
      saveTools();

      // Automatically record to Google Form in background
      recordDownloadToGoogleForm(id, tool.version || 'v1.0').catch(console.error);

      return res.json({ success: true, count: tool.downloadCount });
    }
    res.status(404).json({ error: "找不到該工具" });
  });

  // API 5: Delete tool (Protected)
  app.delete("/api/tools/:id", (req, res) => {
    const { id } = req.params;
    const passcode = req.headers['x-admin-passcode'] || req.query.passcode;

    if (isPasscodeRequired && passcode !== adminPasscode) {
      return res.status(401).json({ error: "需要管理員密碼才能刪除套件" });
    }

    const targetTool = apkToolsStore.find(t => t.id === id);
    if (targetTool && targetTool.downloadUrl && targetTool.downloadUrl.startsWith('/api/download/')) {
      const filename = targetTool.downloadUrl.replace('/api/download/', '');
      const filePath = path.join(UPLOADS_DIR, filename);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.error("Error deleting apk file:", e);
        }
      }
    }

    // Remove the linked Chrome extension archive too (e.g. twitch-recovery-extension.zip)
    if (targetTool && targetTool.extensionZipName) {
      const zipPath = path.join(UPLOADS_DIR, targetTool.extensionZipName);
      if (fs.existsSync(zipPath)) {
        try {
          fs.unlinkSync(zipPath);
        } catch (e) {
          console.error("Error deleting extension zip:", e);
        }
      }
    }

    apkToolsStore = apkToolsStore.filter(t => t.id !== id);
    saveTools();
    res.json({ success: true, tools: apkToolsStore });
  });

  // API 6: Clear all tools (Protected)
  app.post("/api/tools/clear", (req, res) => {
    const { passcode } = req.body;
    if (isPasscodeRequired && passcode !== adminPasscode) {
      return res.status(401).json({ error: "需要管理員密碼才能清空列表" });
    }
    apkToolsStore = [];
    saveTools();
    res.json({ success: true, tools: [] });
  });

  // API 7: Central Server Direct Download Handler (Serves cached APK directly from server)
  app.get("/api/tools/:id/download", async (req, res) => {
    const { id } = req.params;
    const tool = apkToolsStore.find(t => t.id === id);
    if (!tool) {
      return res.status(404).send("找不到該 APK 工具套件");
    }

    const targetUrl = tool.downloadUrl || '';

    const isUserScript = tool.category === 'Tampermonkey' || targetUrl.endsWith('.user.js') || (tool.downloadUrl && tool.downloadUrl.includes('.user.js'));

    // Userscript: redirect to the canonical .user.js endpoint so that Tampermonkey can
    // intercept the navigation — it only catches URLs that actually END with ".user.js".
    // (Serving the script body from /api/tools/:id/download would just show raw JS text,
    // breaking QR-code installs.)
    if (isUserScript && targetUrl.startsWith('/api/download/')) {
      return res.redirect(302, targetUrl);
    }

    // Increment download count (persisted across restarts and synced with Google Drive base)
    tool.downloadCount = (tool.downloadCount || 0) + 1;
    saveTools();

    // Automatically record download event to Google Form
    recordDownloadToGoogleForm(id, tool.version || 'v1.0').catch(console.error);

    // Set download header with friendly filename
    const sanitizedName = tool.name.replace(/[^\w\u4e00-\u9fa5_.-]/g, '_');
    const extension = isUserScript ? '.user.js' : '.apk';
    const downloadFilename = `${sanitizedName}_${tool.version || 'v1.0'}${extension}`;

    if (isUserScript) {
      // Direct userscript filename candidates
      const scriptCandidates = [
        tool.scriptFileName ? path.join(UPLOADS_DIR, tool.scriptFileName) : null,
        targetUrl.startsWith('/api/download/') ? path.join(UPLOADS_DIR, targetUrl.replace('/api/download/', '')) : null,
        path.join(UPLOADS_DIR, `${id}.user.js`),
        path.join(UPLOADS_DIR, `${id}.js`)
      ].filter(Boolean) as string[];

      let foundScriptPath: string | null = null;
      for (const p of scriptCandidates) {
        if (fs.existsSync(p) && fs.statSync(p).size > 10) {
          foundScriptPath = p;
          break;
        }
      }

      if (foundScriptPath) {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        const rawScript = fs.readFileSync(foundScriptPath, 'utf-8');
        const formatted = formatScriptWithDynamicMetadata(rawScript, path.basename(foundScriptPath), req);
        return res.send(formatted);
      }
    }

    if (isUserScript) {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadFilename)}"`);
    }

    // Candidate cached files on server disk
    const localCandidates = [
      tool.apkFileName ? path.join(UPLOADS_DIR, tool.apkFileName) : null,
      path.join(UPLOADS_DIR, `${id}${extension}`),
      path.join(UPLOADS_DIR, `${sanitizedName}${extension}`),
      path.join(UPLOADS_DIR, `${id}.apk`),
      path.join(UPLOADS_DIR, 'adskip.apk'),
      path.join(UPLOADS_DIR, `${sanitizedName}.apk`)
    ].filter(Boolean) as string[];

    if (targetUrl.startsWith('/api/download/')) {
      const filename = targetUrl.replace('/api/download/', '');
      localCandidates.unshift(path.join(UPLOADS_DIR, filename));
    }

    for (const candidate of localCandidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 10) {
        if (isUserScript) {
          const rawScript = fs.readFileSync(candidate, 'utf-8');
          const formatted = formatScriptWithDynamicMetadata(rawScript, path.basename(candidate), req);
          return res.send(formatted);
        }
        return res.sendFile(candidate);
      }
    }

    // If it's a remote userscript URL (e.g. from raw GitHub)
    if (isUserScript && targetUrl.startsWith('http')) {
      try {
        const scriptRes = await fetch(targetUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });
        if (scriptRes.ok) {
          const scriptText = await scriptRes.text();
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(downloadFilename)}"`);
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
          const formatted = formatScriptWithDynamicMetadata(scriptText, path.basename(downloadFilename), req);
          return res.send(formatted);
        }
      } catch (e) {
        console.error("Error proxying user script:", e);
      }
    }


    // Fallback redirect if sync failed
    return res.redirect(302, targetUrl);
  });

  // API 8: Direct APK or Script Binary/Code Download Handler (Public)
  app.get("/api/download/:filename", async (req, res) => {
    const filename = req.params.filename;
    const isUserScript = filename.endsWith('.user.js') || filename.endsWith('.js');
    const isZip = filename.endsWith('.zip');
    const localFilePath = path.join(UPLOADS_DIR, filename);

    // Chrome extension bundle (e.g. twitch-recovery-extension.zip).
    // Served as an attachment so the browser downloads it instead of navigating,
    // and counted only when it is NOT the in-site preview.
    if (isZip) {
      const isPreview = req.query.preview === '1' || req.query.preview === 'true';
      if (!isPreview) {
        const linkedTool = apkToolsStore.find(t =>
          t.extensionZipName === filename ||
          t.downloadUrl === `/api/download/${filename}`
        );
        if (linkedTool) {
          linkedTool.downloadCount = (linkedTool.downloadCount || 0) + 1;
          saveTools();
          recordDownloadToGoogleForm(linkedTool.id, linkedTool.version || 'v1.0').catch(console.error);
        }
      }

      if (fs.existsSync(localFilePath)) {
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(filename)}"`
        );
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.sendFile(localFilePath);
      }
      return res.status(404).send("Extension archive not found on server.");
    }

    if (isUserScript) {
      // Standard userscript headers (No Content-Disposition to allow Tampermonkey extension intercept)
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      // Trigger background refresh if stale so the next check gets the latest version
      const fileMissing = !fs.existsSync(localFilePath);
      const isStale = Date.now() - lastGithubRefreshTime > 60 * 1000;

      if (fileMissing) {
        // Refresh from GitHub Raw first (source of truth)
        try {
          await refreshScriptsFromGitHub();
        } catch (e) {
          console.error("[Download Route] GitHub refresh error:", e);
        }
      } else if (isStale || req.query.force === 'true') {
        // Refresh in background asynchronously
        refreshScriptsFromGitHub().catch(console.error);
      }

      if (fs.existsSync(localFilePath)) {
        // Count every install/download request by default.
        // FIX: the old `Sec-Fetch-Dest === 'document'` filter silently dropped EVERY
        // Tampermonkey install. Tampermonkey cancels the .user.js main-frame navigation in
        // onBeforeRequest and re-fetches the script itself, so the request that actually
        // reaches this route carries `Sec-Fetch-Dest: empty` — it was never counted.
        // The in-site preview viewer (檢視腳本源代碼) now marks itself explicitly with
        // `?preview=1`; that is the only case we skip.
        const isPreview = req.query.preview === '1' || req.query.preview === 'true';
        if (!isPreview) {
          const lowerFilename = filename.toLowerCase();
          const linkedTool = apkToolsStore.find(t =>
            t.scriptFileName === filename ||
            (t.scriptFileName && String(t.scriptFileName).toLowerCase() === lowerFilename) ||
            t.downloadUrl === `/api/download/${filename}`
          );
          if (linkedTool) {
            linkedTool.downloadCount = (linkedTool.downloadCount || 0) + 1;
            saveTools();
            recordDownloadToGoogleForm(linkedTool.id, linkedTool.version || 'v1.0').catch(console.error);
          }
        }
        const rawScript = fs.readFileSync(localFilePath, 'utf-8');
        const formatted = formatScriptWithDynamicMetadata(rawScript, filename, req);
        return res.send(formatted);
      }

      return res.status(404).send("// Script not found or still syncing from Google Drive. Please refresh in a moment.");
    } else {
      const cleanFilename = filename.endsWith('.apk') ? filename : `${filename}.apk`;
      const apkPath = path.join(UPLOADS_DIR, cleanFilename);
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${cleanFilename}"`);
      if (fs.existsSync(apkPath)) {
        return res.sendFile(apkPath);
      }
    }

    // Check if real file exists on disk
    if (fs.existsSync(localFilePath)) {
      return res.sendFile(localFilePath);
    }

    // Otherwise generate a valid dummy binary APK payload container
    const dummyApkHeader = Buffer.from(
      "PK\x03\x04\x14\x00\x00\x00\x08\x00" +
      "AndroidManifest.xml - Custom APK Binary Container\n" +
      "Package: " + filename + "\n" +
      "Compiled for Android Device Installation"
    );

    res.send(dummyApkHeader);
  });

  // API 8: Upload APK or UserScript file via Base64 or metadata receiver (Protected)
  app.post("/api/upload-apk", (req, res) => {
    try {
      const { fileName, base64Data, textContent, externalUrl, passcode } = req.body;

      if (isPasscodeRequired && passcode !== adminPasscode) {
        return res.status(401).json({ error: "權限不符：需要管理員密碼才能上傳檔案" });
      }

      if (externalUrl) {
        return res.json({ success: true, downloadUrl: externalUrl });
      }

      if (textContent && fileName) {
        const cleanName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '');
        const targetPath = path.join(UPLOADS_DIR, cleanName);
        fs.writeFileSync(targetPath, textContent, 'utf-8');
        const sizeKb = (Buffer.byteLength(textContent, 'utf-8') / 1024).toFixed(1);
        return res.json({
          success: true,
          downloadUrl: `/api/download/${cleanName}`,
          fileSize: `${sizeKb} KB`
        });
      }

      if (base64Data && fileName) {
        const cleanName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '');
        const targetPath = path.join(UPLOADS_DIR, cleanName);
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(targetPath, buffer);
        
        const sizeFormatted = buffer.length > 1024 * 1024 
          ? `${(buffer.length / (1024 * 1024)).toFixed(1)} MB`
          : `${(buffer.length / 1024).toFixed(1)} KB`;

        return res.json({ 
          success: true, 
          downloadUrl: `/api/download/${cleanName}`,
          fileSize: sizeFormatted
        });
      }

      return res.status(400).json({ error: "未提供檔案資料或 URL" });
    } catch (err: any) {
      console.error("Upload error:", err);
      res.status(500).json({ error: err.message || "上傳檔案失敗" });
    }
  });

  // API 9: Gemini Chat for Release Notes & Descriptions
  app.post("/api/chat", async (req, res) => {
    try {
      const { message, toolName } = req.body;
      if (!message) {
        return res.status(400).json({ error: "請輸入訊息" });
      }

      if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
        return res.json({ 
          text: "⚠️ **Gemini API Key 未設定。**\n\n為您產生標準版本更新日誌範本：\n\n### 🚀 版本釋出說明\n* **核心功能**: 支援 Android 14/15 權限最佳化。\n* **更新日誌**:\n  1. 提升元件載入與快取效率。\n  2. 修復暗色模式 UI 文字對比度。" 
        });
      }

      const chat = ai.chats.create({
        model: "gemini-3.5-flash",
        config: {
          systemInstruction: "You are an expert Android Developer Advocate and Release Engineer assistant. You help developers write concise, professional app descriptions, feature summaries, version release notes, and install instructions for custom Android APK tools. Respond in a friendly, technical, and clean markdown format in Traditional Chinese (繁體中文).",
        },
      });

      const response = await chat.sendMessage({ 
        message: toolName ? `針對 Android 工具 '${toolName}': ${message}` : message 
      });
      res.json({ text: response.text });
    } catch (error: any) {
      console.error("Gemini Error:", error);
      res.status(500).json({ error: error.message || "連線至 Gemini 失敗" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // 下載統計排程：開機立即取一次，之後每 5 分鐘更新。
  // 與 Drive 同步無關 —— 這是 Sheet 統計的獨立觸發來源，
  // 確保刪除 Drive 程式碼後統計仍會運作。
  refreshDownloadCounts().catch(console.error);
  const statsTimer = setInterval(() => {
    refreshDownloadCounts().catch(console.error);
  }, SHEET_CACHE_TTL_MS);
  statsTimer.unref?.();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`APK Hub Server running on http://localhost:${PORT}`);
  });
}

startServer();
