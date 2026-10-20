import fs from 'node:fs';
import path from 'node:path';
import { parseUserScriptMetadata } from './userscript-metadata.ts';
import type { DiskScript } from './reconcile-tools.ts';

/**
 * 列出目錄下所有有效的 Tampermonkey 腳本。
 *
 * 只接受 `.user.js`（而非 `.js`），且內容必須能被
 * parseUserScriptMetadata 解析出名稱，避免把普通 JavaScript 檔誤判為使用者腳本。
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
