export interface UserScriptMetadata {
  name: string | null;
  version: string | null;
  description: string | null;
  namespace: string | null;
}

/**
 * 解析 Tampermonkey 使用者腳本。
 *
 * - `name` / `description` / `namespace` 僅在腳本含有完整
 *   `// ==UserScript==` ... `// ==/UserScript==` 區塊時才視為有效，
 *   避免把任意 .js 檔誤判為使用者腳本（見測試：無區塊時 name 為 null）。
 * - `version` 則從整份內容擷取並一律正規化為帶 v 前綴，
 *   以便即使只看單行 `@version` 片段也能正確辨識。
 */
export function parseUserScriptMetadata(scriptText: string): UserScriptMetadata {
  const metaStart = scriptText.indexOf('// ==UserScript==');
  const metaEnd = scriptText.indexOf('// ==/UserScript==');
  const hasBlock = metaStart !== -1 && metaEnd !== -1 && metaEnd > metaStart;

  const header = hasBlock ? scriptText.substring(metaStart, metaEnd) : '';

  const blockMatch = (key: string): string | null => {
    if (!header) return null;
    const m = header.match(new RegExp(`@${key}\\s+(.+)`));
    return m ? m[1].trim() : null;
  };

  const rawVersionMatch = scriptText.match(/@version\s+(.+)/);
  const rawVersion = rawVersionMatch ? rawVersionMatch[1].trim() : null;
  const version = rawVersion
    ? (rawVersion.startsWith('v') ? rawVersion : `v${rawVersion}`)
    : null;

  return {
    name: blockMatch('name'),
    version,
    description: blockMatch('description'),
    namespace: blockMatch('namespace'),
  };
}
