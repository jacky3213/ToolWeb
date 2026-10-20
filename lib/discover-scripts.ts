import fs from 'node:fs';
import path from 'node:path';
import { parseUserScriptMetadata } from './userscript-metadata.ts';
import type { DiskScript } from './reconcile-tools.ts';

/**
 * 列出目錄下所有可發布的檔案（Tampermonkey 腳本與 Android APK）。
 *
 * 掃描 `.user.js` 與 `.apk` 兩種：
 * - `.user.js` 必須能被 `parseUserScriptMetadata` 解析出名稱才算有效，
 *   否則會把普通 JavaScript 檔誤判為使用者腳本。
 * - `.apk` 是二進位檔，無法解析 metadata，version 一律為 null。
 *
 * 兩者都納入是必要的：`reconcile()` 的「manifest 有但磁碟無則略過」規則
 * 仰賴這份清單來判斷死連結，若不列出 APK，
 * manifest 中的 APK 條目（如 adskip-apk）會被整個丟棄而從網站消失。
 *
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
    const lower = fileName.toLowerCase();
    const isUserScript = lower.endsWith('.user.js');
    const isApk = lower.endsWith('.apk');

    if (!isUserScript && !isApk) continue;

    const filePath = path.join(dir, fileName);
    try {
      if (isApk) {
        scripts.push({ fileName, version: null });
        continue;
      }

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
