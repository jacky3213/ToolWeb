/**
 * 前端設定集中區。
 *
 * 受限工具（manifest 標記 `locked: true`）的密碼**不在前端**——
 * 它由後端 `process.env.ADMIN_PASSCODE`（AI Studio Secrets 面板注入）持有。
 * 前端只負責呼叫 `/api/unlock` 換取 token，並於後續 `/api/tools` 請求帶上。
 */

/** localStorage key：記住後端簽發的解鎖 token。 */
export const UNLOCK_TOKEN_KEY = 'toolweb.unlockToken';

/** 後端解鎖端點。 */
export const UNLOCK_API_PATH = '/api/unlock';
