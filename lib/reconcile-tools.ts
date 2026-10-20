export interface ManifestEntry {
  id: string;
  scriptFileName: string;
  version: string;
}

export interface DiskScript {
  fileName: string;
  version: string | null;
}

export interface ReconciledScript extends ManifestEntry {
  scriptFileName: string;
  version: string | null;
}

/** 由檔名推導工具 id：去除 .user.js / .js 後綴，並轉為小寫 */
function idFromFileName(fileName: string): string {
  return fileName
    .replace(/\.user\.js$/i, '')
    .replace(/\.js$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
}

/**
 * 合併 manifest 與磁碟上的腳本清單。
 *
 * 規則：
 * 1. manifest 與磁碟皆存在 → 以 manifest 為準（顯示資料可人工潤飾）
 * 2. 僅磁碟存在 → 自動建立條目（「push 到 GitHub 即生效」的核心）
 * 3. 僅 manifest 存在 → 略過，避免顯示會 404 的死連結
 */
export function reconcile(
  manifest: ManifestEntry[],
  disk: DiskScript[]
): ReconciledScript[] {
  const diskByFile = new Map(disk.map(d => [d.fileName, d]));
  const result: ReconciledScript[] = [];
  const consumed = new Set<string>();

  for (const entry of manifest) {
    if (!diskByFile.has(entry.scriptFileName)) continue;
    consumed.add(entry.scriptFileName);
    result.push({ ...entry, scriptFileName: entry.scriptFileName });
  }

  for (const script of disk) {
    if (consumed.has(script.fileName)) continue;
    result.push({
      id: idFromFileName(script.fileName),
      scriptFileName: script.fileName,
      version: script.version,
    } as ReconciledScript);
  }

  return result;
}
