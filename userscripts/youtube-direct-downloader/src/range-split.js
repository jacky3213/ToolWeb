export function splitRanges(totalSize, chunkSize) {
  if (!Number.isFinite(totalSize) || totalSize <= 0 || !Number.isFinite(chunkSize) || chunkSize <= 0) return [];
  const ranges = [];
  for (let start = 0; start < totalSize; start += chunkSize) {
    ranges.push({ start, end: Math.min(start + chunkSize, totalSize) - 1 });
  }
  return ranges;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(2)} ${units[i]}`;
}
