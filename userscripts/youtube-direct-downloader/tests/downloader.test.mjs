import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createDownloadTask } from '../src/downloader.js';

// 起一個 local server：512 bytes 遞增內容，正確處理 Range（206）/ 全量（200）
function startServer({ failFirstRange = false, delayMs = 0 } = {}) {
  const content = new Uint8Array(512);
  for (let i = 0; i < content.length; i++) content[i] = i % 256;

  let rangeReqCount = 0;

  const server = http.createServer((req, res) => {
    const range = req.headers['range'];
    if (range) {
      rangeReqCount++;
      // 故意對「第一個」Range 請求回 500 一次（之後正常）
      if (failFirstRange && rangeReqCount === 1) {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(m[1]);
      const end = Number(m[2]);
      const chunk = content.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${content.length}`,
        'Content-Length': String(chunk.length),
        'Content-Type': 'application/octet-stream',
      });
      if (delayMs > 0) {
        setTimeout(() => res.end(Buffer.from(chunk)), delayMs);
      } else {
        res.end(Buffer.from(chunk));
      }
    } else {
      res.writeHead(200, {
        'Content-Length': String(content.length),
        'Content-Type': 'application/octet-stream',
      });
      res.end(Buffer.from(content));
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        content,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('完整重組：totalSize=512, chunkSize=128, concurrency=4', async () => {
  const { url, content, close } = await startServer();
  try {
    const task = createDownloadTask({
      url,
      totalSize: 512,
      fetchImpl: globalThis.fetch,
      concurrency: 4,
      chunkSize: 128,
    });
    const { buffer, blob } = await task.start();
    assert.equal(buffer.length, 512);
    assert.ok(buffer.every((b, i) => b === content[i]));
    // blob 長度也應為 512
    const b = blob();
    assert.equal(b.size, 512);
  } finally {
    await close();
  }
});

test('totalSize=0：不拋錯，回傳長度 0 的空 buffer', async () => {
  const { url, close } = await startServer();
  try {
    const task = createDownloadTask({
      url,
      totalSize: 0,
      fetchImpl: globalThis.fetch,
      concurrency: 4,
      chunkSize: 128,
    });
    const { buffer, blob } = await task.start();
    assert.equal(buffer.length, 0);
    assert.equal(blob().size, 0);
  } finally {
    await close();
  }
});

test('首片 500 一次後重試仍得到完整正確內容', async () => {
  const { url, content, close } = await startServer({ failFirstRange: true });
  try {
    const task = createDownloadTask({
      url,
      totalSize: 512,
      fetchImpl: globalThis.fetch,
      concurrency: 4,
      chunkSize: 128,
    });
    const { buffer } = await task.start();
    assert.equal(buffer.length, 512);
    assert.ok(buffer.every((b, i) => b === content[i]));
  } finally {
    await close();
  }
});

test('cancel() 後 start() 拋 AbortError', async () => {
  const { url, close } = await startServer({ delayMs: 50 });
  try {
    const task = createDownloadTask({
      url,
      totalSize: 512,
      fetchImpl: globalThis.fetch,
      concurrency: 4,
      chunkSize: 128,
    });
    const p = task.start();
    task.cancel();
    await assert.rejects(p, (err) => err.name === 'AbortError');
  } finally {
    await close();
  }
});
