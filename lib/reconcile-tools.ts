export interface ManifestEntry {
  id: string;
  /** Tampermonkey 腳本檔名。腳本條目用它指向檔案。 */
  scriptFileName?: string;
  /** Android APK 檔名。二進位條目用它指向檔案。 */
  apkFileName?: string;
  version: string;
  // 注意：此介面刻意不宣告索引簽章。
  // manifest 條目還帶有 name / summary / icon / changelog / installGuide 等大量顯示欄位，
  // 它們在執行期透過 spread 原樣保留，只是不做靜態型別化。
  // 加了 `[key: string]: unknown` 會讓此型別無法接受結構較窄的物件，
  // 導致呼叫端（測試、loadManifest）必須額外轉型才能通過型別檢查。
}

export interface DiskScript {
  fileName: string;
  version: string | null;
}

/**
 * 合併結果。
 *
 * 索引簽章放在**回傳型別**而非參數型別，是刻意的取捨：
 * - 參數型別帶索引簽章會讓呼叫端（測試、loadManifest 的窄物件）無法通過型別檢查
 * - 回傳型別帶索引簽章則允許存取 manifest 條目攜帶的顯示欄位（name / summary / icon…），
 *   這些欄位在執行期透過 spread 原樣保留
 */
export type ReconciledScript = Omit<ManifestEntry, 'version'> & {
  version: string | null;
  [key: string]: unknown;
};

/** 由檔名推導工具 id：去除 .user.js / .js / .apk 後綴，並轉為小寫 */
function idFromFileName(fileName: string): string {
  return fileName
    .replace(/\.user\.js$/i, '')
    .replace(/\.js$/i, '')
    .replace(/\.apk$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
}

/**
 * manifest 條目指向的實際檔名。
 *
 * 腳本條目用 `scriptFileName`（如 `olevod-preloader.user.js`），
 * APK 條目用 `apkFileName`（如 `adskip.apk`）——兩者欄位不同，
 * 比對磁碟清單時必須都能辨識，否則 APK 條目會被誤判為死連結而丟棄。
 */
function fileOf(entry: ManifestEntry): string | undefined {
  return entry.scriptFileName || entry.apkFileName;
}

/** 依副檔名決定自動建立的條目該用哪個欄位指向檔案 */
function fileFieldFor(fileName: string): { scriptFileName?: string; apkFileName?: string } {
  return fileName.toLowerCase().endsWith('.apk')
    ? { apkFileName: fileName }
    : { scriptFileName: fileName };
}

/**
 * 合併 manifest 與磁碟上的可發布檔案清單（使用者腳本與 APK）。
 *
 * 規則：
 * 1. manifest 有、磁碟也有 → 以 manifest 為準（顯示資料可人工潤飾）
 * 2. 只有磁碟有         → 自動建立條目（「push 到 GitHub 即生效」的核心）
 * 3. 只有 manifest 有   → 略過，避免顯示會 404 的死連結
 */
export function reconcile(
  manifest: ManifestEntry[],
  disk: DiskScript[]
): ReconciledScript[] {
  const diskByFile = new Map(disk.map(d => [d.fileName, d]));
  const result: ReconciledScript[] = [];
  const consumed = new Set<string>();

  for (const entry of manifest) {
    const file = fileOf(entry);
    if (!file) continue;
    if (!diskByFile.has(file)) continue;

    consumed.add(file);
    result.push({ ...entry } as ReconciledScript);
  }

  for (const script of disk) {
    if (consumed.has(script.fileName)) continue;
    result.push({
      id: idFromFileName(script.fileName),
      ...fileFieldFor(script.fileName),
      version: script.version,
    } as ReconciledScript);
  }

  return result;
}