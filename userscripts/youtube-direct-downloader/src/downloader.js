import { splitRanges } from './range-split.js';

const DEFAULT_CHUNK = 8 * 1024 * 1024;
const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abortError(message) {
  return new DOMException(message || 'Download cancelled', 'AbortError');
}

export function createDownloadTask({
  url,
  totalSize,
  fetchImpl,
  concurrency = 4,
  chunkSize = DEFAULT_CHUNK,
  onProgress,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl is required');
  }

  const controller = new AbortController();
  // 共享 gate：每個 worker 在抓取下一個分片前都 await 它；pause 時為 pending，resume 時 resolve
  let gate = Promise.resolve();
  let gateResolve = null;
  let paused = false;
  let done = 0;

  function checkAborted() {
    if (controller.signal.aborted) throw abortError();
  }

  function pause() {
    if (paused) return;
    paused = true;
    gate = new Promise((resolve) => {
      gateResolve = resolve;
    });
  }

  function resume() {
    if (!paused) return;
    paused = false;
    if (gateResolve) {
      const resolve = gateResolve;
      gateResolve = null;
      resolve();
    }
  }

  function cancel() {
    controller.abort();
    // 解開 pause gate，讓卡住的 worker 能走到 checkAborted 後退出
    if (gateResolve) {
      const resolve = gateResolve;
      gateResolve = null;
      resolve();
    }
  }

  // 單一片請求：帶 Range，接受 200/206，長度不符視為失敗
  async function fetchSlice(range) {
    const { start, end } = range;
    const expectedLen = end - start + 1;
    const res = await fetchImpl(url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: controller.signal,
    });
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`Unexpected status ${res.status} for range ${start}-${end}`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length !== expectedLen) {
      throw new Error(
        `Length mismatch for range ${start}-${end}: expected ${expectedLen}, got ${data.length}`
      );
    }
    return data;
  }

  // 失敗自動重試 + 指數退避（1s / 2s / 4s），最多重試 3 次；取消時直接拋 AbortError
  async function fetchWithRetry(range, attempt = 0) {
    try {
      return await fetchSlice(range);
    } catch (err) {
      if (controller.signal.aborted) throw abortError(err && err.message);
      if (attempt < MAX_RETRIES) {
        await sleep(2 ** attempt * 1000);
        checkAborted();
        return fetchWithRetry(range, attempt + 1);
      }
      throw err;
    }
  }

  function emitProgress() {
    if (typeof onProgress === 'function') {
      onProgress({ loaded: done, total: totalSize });
    }
  }

  async function start() {
    // totalSize <= 0：直接回傳空 buffer，不發任何請求
    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      const buffer = new Uint8Array(0);
      done = 0;
      emitProgress();
      return {
        buffer,
        blob: () => new Blob([buffer]),
      };
    }

    const buffer = new Uint8Array(totalSize);
    const ranges = splitRanges(totalSize, chunkSize);
    let idx = 0;
    let fatalError = null;

    async function worker() {
      while (true) {
        if (fatalError) return;
        await gate; // 若暫停，停在此處直到 resume
        if (controller.signal.aborted) return; // 取消：安靜退出（由 start() 統一拋 AbortError）
        const i = idx++;
        if (i >= ranges.length) return;
        const range = ranges[i];
        try {
          const slice = await fetchWithRetry(range); // 已送出請求不受 pause 影響
          buffer.set(slice, range.start);
          done += slice.length;
          emitProgress();
        } catch (err) {
          if (err && err.name === 'AbortError') return; // 取消
          fatalError = err;
          controller.abort(); // 通知其它 worker 停止
          return;
        }
      }
    }

    const n = Math.max(1, Math.min(concurrency, ranges.length));
    const workers = [];
    for (let k = 0; k < n; k++) workers.push(worker());
    await Promise.all(workers);

    if (fatalError) throw fatalError;
    if (controller.signal.aborted) throw abortError();

    return {
      buffer,
      blob: () => new Blob([buffer]),
    };
  }

  return {
    start,
    pause,
    resume,
    cancel,
    get progress() {
      return { loaded: done, total: totalSize };
    },
  };
}
