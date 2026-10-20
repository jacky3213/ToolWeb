const GOOGLEVIDEO_HOST = /^([a-z0-9-]+\.)*googlevideo\.com$/i;

/**
 * 把 format 的 lastModified 正規化成 SABR proto 要的 uint64 微秒字串。
 *
 * ⚠️ youtubei.js 的 `Format.last_modified` 是 **Date 物件**
 * （Format.js:81 把原始微秒除以 1000 後 new Date），原始微秒字串保留在
 * `last_modified_ms`（命名容易誤解，它其實是微秒）。若把 Date 直接丟進
 * SabrFormat，protobuf 寫 uint64 時會執行
 * `BigInt("Sat Mar 29 2025 17:56:54 GMT+0800 (中國標準時間)")`，
 * 拋出 `SyntaxError: Cannot convert ... to a BigInt`，整個下載失敗。
 *
 * @param {object} f youtubei.js Format（或原始 camelCase format）
 * @returns {string} 純數字字串（微秒）；取不到時回 '0'
 */
export function toLastModified(f) {
  const raw = f?.last_modified_ms ?? f?.lastModified;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
    const parsed = Date.parse(trimmed);
    // 無法解析的字串不可原樣傳下去，否則又會變成 BigInt 錯誤
    if (!Number.isNaN(parsed)) return String(parsed * 1000);
  } else if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(Math.trunc(raw));
  } else if (raw instanceof Date) {
    return String(raw.getTime() * 1000);
  }

  // 退回路徑：只剩 Date 欄位可用
  const date = f?.last_modified;
  if (date instanceof Date && !Number.isNaN(date.getTime())) {
    return String(date.getTime() * 1000);
  }
  return '0';
}

export function isGoogleVideoUrl(rawUrl) {
  try { return GOOGLEVIDEO_HOST.test(new URL(rawUrl).hostname); }
  catch { return false; }
}

export function stripRangeParams(rawUrl) {
  const u = new URL(rawUrl);
  for (const p of ['range', 'rn', 'rbuf']) u.searchParams.delete(p);
  return u.toString();
}

export function containerOf(mimeType) {
  return String(mimeType).split('/')[1].split(';')[0].trim();
}

function pickAudioTrackImpl(audios) {
  return [...audios].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? null;
}

export function pickAudioTrack(audioFormats, preferredLang) {
  if (!audioFormats?.length) return null;
  if (preferredLang) {
    const exact = audioFormats.filter(f => f.language === preferredLang);
    if (exact.length) return pickAudioTrackImpl(exact);
  }
  const original = audioFormats.filter(f => f.is_original || !f.language);
  if (original.length) return pickAudioTrackImpl(original);
  return pickAudioTrackImpl(audioFormats);
}

export function pairVideoAudio(videoFormats, audioFormats) {
  const byContainer = new Map();
  for (const a of audioFormats) {
    const c = containerOf(a.mime_type);
    if (!byContainer.has(c)) byContainer.set(c, []);
    byContainer.get(c).push(a);
  }
  return videoFormats.map(v => ({
    video: v,
    audio: pickAudioTrackImpl(byContainer.get(containerOf(v.mime_type)) ?? audioFormats) ?? null,
  }));
}

export function buildQualityList(formats, { audioLanguage }) {
  const videoOnly = formats.filter(f => f.has_video && !f.has_audio);
  const audioOnly = formats.filter(f => f.has_audio && !f.has_video);
  const progressive = formats.filter(f => f.has_video && f.has_audio);
  const chosenAudio = audioLanguage != null
    ? pickAudioTrack(audioOnly, audioLanguage)
    : pickAudioTrackImpl(audioOnly);

  const entries = [];
  for (const p of progressive) {
    entries.push({
      label: p.quality_label ?? `${p.height ?? '?'}p`,
      isProgressive: true, videoFormat: p, audioFormat: null,
      container: containerOf(p.mime_type),
      sizeBytes: p.content_length ?? null,
      height: p.height ?? 0, fps: p.fps ?? 0,
    });
  }
  for (const { video, audio } of pairVideoAudio(videoOnly, chosenAudio ? [chosenAudio] : audioOnly)) {
    entries.push({
      label: (video.quality_label ?? `${video.height ?? '?'}p`) + (video.fps && video.fps !== 30 ? String(video.fps) : ''),
      isProgressive: false, videoFormat: video, audioFormat: audio,
      container: containerOf(video.mime_type),
      sizeBytes: (video.content_length ?? 0) + (audio?.content_length ?? 0) || null,
      height: video.height ?? 0, fps: video.fps ?? 0,
    });
  }
  entries.sort((a, b) => (b.height - a.height) || (b.fps - a.fps) || (a.isProgressive ? 1 : -1));
  const seen = new Set();
  return entries.filter(e => (seen.has(e.label) ? false : seen.add(e.label)));
}
