const GOOGLEVIDEO_HOST = /^([a-z0-9-]+\.)*googlevideo\.com$/i;

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
