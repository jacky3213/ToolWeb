// src/fs-writer.js
//
// 寫盤與退回（File System Access API 優先，失敗/不支援時退回 Blob 下載）。
// 此模組只能於瀏覽器環境執行（依賴 window.showSaveFilePicker 等）；node 下無法實測。

const EXT_TO_MIME = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  m4a: 'audio/mp4',
};

// 瀏覽器是否支援 File System Access API。
export function supportsFsAccess() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

// 開啟輸出目標。
// 回傳 { kind:'fs'|'blob', writable, suggestedName, container }
//   - fs：使用者選擇檔案並建立 writable（使用者取消 → AbortError 直接往上拋；
//         其他錯誤 → 退回 blob）；writable 為 FileSystemWritableFileStream。
//   - blob：writable = null，由呼叫端改用 muxer.blobTarget()（BufferTarget）合併後存檔。
export async function openOutput(suggestedName, container) {
  if (supportsFsAccess()) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{
          description: `${container.toUpperCase()} 檔案`,
          accept: { [EXT_TO_MIME[container] || 'application/octet-stream']: [`.${container}`] },
        }],
      });
      const writable = await handle.createWritable();
      return { kind: 'fs', writable, suggestedName, container };
    } catch (err) {
      // 使用者明確取消 → 直接往上拋，由呼叫端決定是否中止整體下載。
      if (err && err.name === 'AbortError') throw err;
      // 其他錯誤（權限、安全限制等）→ 退回 Blob 下載。
      console.warn('[YT-DL] FS Access 失敗，退回 Blob 下載：', err);
    }
  }
  return { kind: 'blob', writable: null, suggestedName, container };
}

// Blob 退回的存檔：建立暫時 <a> + objectURL 觸發下載，下載後 revoke。
export function saveBlobAs(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 給一點時間讓下載開始後再回收 objectURL。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
