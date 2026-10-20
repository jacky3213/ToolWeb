// src/settings.js
//
// 透過 Tampermonkey 的 GM_setValue / GM_getValue 做輕量設定持久化。
// 所有鍵值統一加 `ytdl:` 前綴，避免與其他腳本衝突。

const KEY_PREFIX = 'ytdl:';

export const getSetting = (key, fallback) => {
  const v = GM_getValue(KEY_PREFIX + key, undefined);
  return v === undefined ? fallback : v;
};

export const setSetting = (key, value) => {
  GM_setValue(KEY_PREFIX + key, value);
};
