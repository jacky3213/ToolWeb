import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapture, isInitSegment } from '../src/capture.js';

// ---------------------------------------------------------------------------
// 自製 stub：FakeMediaSource / FakeSourceBuffer
//
// 不引 jsdom。FakeMediaSource.prototype.addSourceBuffer 可被掛鉤；
// FakeSourceBuffer.appendBuffer(data) 記錄被餵入的 data，並實作 mime 屬性。
// ---------------------------------------------------------------------------

class FakeSourceBuffer {
  constructor(mime) {
    this.mime = mime;
    this.appended = []; // 記錄每次 appendBuffer 收到的原始 data
  }
  appendBuffer(data) {
    this.appended.push(data);
  }
}

class FakeMediaSource {
  addSourceBuffer(mime) {
    return new FakeSourceBuffer(mime);
  }
}

// ---- 測試用的資料工廠 ----

function makeInit() {
  // 前 4 bytes 為 'ftyp' (0x66 0x74 0x79 0x70)
  return new Uint8Array([0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
}

function makeMedia(tag) {
  // 8 bytes 的識別內容，絕不以 ftyp 開頭
  const u = new Uint8Array(8);
  for (let i = 0; i < 8; i++) u[i] = ('m' + tag).charCodeAt(i % 2) ^ (i + tag);
  u[0] = 0x00; // 確保不是 ftyp
  return u;
}

function concatBytes(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// 收集某 track 當前 Blob 的實際 bytes
async function blobBytes(blob) {
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

// ===========================================================================
// 1. isInitSegment 判斷 ftyp
// ===========================================================================

test('isInitSegment：ftyp 開頭為 true，其他為 false', () => {
  assert.equal(isInitSegment(makeInit()), true);
  assert.equal(isInitSegment(makeInit().buffer), true, 'ArrayBuffer 輸入也應判斷');

  const notInit = new Uint8Array([0x00, 0x00, 0x00, 0x08, 0x6d, 0x6f, 0x6f, 0x76]); // moov
  assert.equal(isInitSegment(notInit), false);

  assert.equal(isInitSegment(new Uint8Array([1, 2, 3])), false, '不足 4 bytes');
  assert.equal(isInitSegment(new Uint8Array(4)), false, '全 0 不是 ftyp');
});

// ===========================================================================
// 2. video / audio 依 mime 分流
// ===========================================================================

test('video/audio 依 mime 正確分流', async () => {
  const capture = createCapture({ getMediaSource: () => FakeMediaSource });
  capture.start();

  const ms = new FakeMediaSource();
  const v = ms.addSourceBuffer('video/mp4; codecs="av01.0.08m.08"');
  const a = ms.addSourceBuffer('audio/webm; codecs="opus"');
  const other = ms.addSourceBuffer('text/vtt'); // 應被忽略

  v.appendBuffer(makeInit());
  a.appendBuffer(makeInit());
  other.appendBuffer(makeInit());

  const r = capture.getResult();
  assert.ok(r.video, 'video Blob 應存在');
  assert.ok(r.audio, 'audio Blob 應存在');
  assert.equal(r.video.type, 'video/mp4; codecs="av01.0.08m.08"');
  assert.equal(r.audio.type, 'audio/webm; codecs="opus"');

  capture.stop();
});

// ===========================================================================
// 3. init segment 在最前、media segments 依序
// ===========================================================================

test('init segment 在最前，media segments 依序（正常順序）', async () => {
  const capture = createCapture({ getMediaSource: () => FakeMediaSource });
  capture.start();

  const ms = new FakeMediaSource();
  const v = ms.addSourceBuffer('video/mp4; codecs="av01"');
  const init = makeInit();
  const m1 = makeMedia(1);
  const m2 = makeMedia(2);
  v.appendBuffer(init);
  v.appendBuffer(m1);
  v.appendBuffer(m2);

  const r = capture.stop();
  const got = await blobBytes(r.video);
  assert.deepEqual(got, concatBytes(init, m1, m2));
});

test('init segment 在最前：即便 init 晚於 media 抵達也要置前', async () => {
  const capture = createCapture({ getMediaSource: () => FakeMediaSource });
  capture.start();

  const ms = new FakeMediaSource();
  const v = ms.addSourceBuffer('video/mp4; codecs="av01"');
  const init = makeInit();
  const m1 = makeMedia(1);
  const m2 = makeMedia(2);
  v.appendBuffer(m1); // media 先到
  v.appendBuffer(init); // init 後到，仍須置前
  v.appendBuffer(m2);

  const r = capture.stop();
  const got = await blobBytes(r.video);
  assert.deepEqual(got, concatBytes(init, m1, m2));
});

// ===========================================================================
// 4. ArrayBuffer 與 Uint8Array 兩種 data 都能正規化
// ===========================================================================

test('ArrayBuffer 與 Uint8Array 兩種 data 都能正規化收集', async () => {
  const capture = createCapture({ getMediaSource: () => FakeMediaSource });
  capture.start();

  const ms = new FakeMediaSource();
  const v = ms.addSourceBuffer('video/mp4; codecs="av01"');
  const init = makeInit();
  const m1 = makeMedia(1);
  const m2 = makeMedia(2);
  // init 以 ArrayBuffer 傳入，media 以 Uint8Array 傳入
  v.appendBuffer(init.buffer);
  v.appendBuffer(m1);
  v.appendBuffer(m2.buffer);

  const r = capture.stop();
  const got = await blobBytes(r.video);
  assert.deepEqual(got, concatBytes(init, m1, m2));
});

// ===========================================================================
// 5. stop() 回傳正確的 { video, audio } Blob，可用 arrayBuffer() 驗證
// ===========================================================================

test('stop() 回傳正確的 { video, audio } Blob 且內容正確', async () => {
  const capture = createCapture({ getMediaSource: () => FakeMediaSource });
  capture.start();

  const ms = new FakeMediaSource();
  const v = ms.addSourceBuffer('video/mp4; codecs="av01"');
  const a = ms.addSourceBuffer('audio/webm; codecs="opus"');
  const vInit = makeInit();
  const vM = makeMedia(1);
  const aInit = makeInit();
  const aM = makeMedia(2);
  v.appendBuffer(vInit);
  v.appendBuffer(vM);
  a.appendBuffer(aInit);
  a.appendBuffer(aM);

  const r = capture.stop();
  assert.ok(r.video instanceof Blob);
  assert.ok(r.audio instanceof Blob);

  const vGot = await blobBytes(r.video);
  const aGot = await blobBytes(r.audio);
  assert.deepEqual(vGot, concatBytes(vInit, vM));
  assert.deepEqual(aGot, concatBytes(aInit, aM));

  // meta 供偵錯
  assert.equal(r.meta.videoMime, 'video/mp4; codecs="av01"');
  assert.equal(r.meta.audioMime, 'audio/webm; codecs="opus"');
  assert.equal(r.meta.videoBytes, vInit.length + vM.length);
  assert.equal(r.meta.audioBytes, aInit.length + aM.length);
});

test('getResult() 不卸鉤，可即時回傳當前收集', async () => {
  const capture = createCapture({ getMediaSource: () => FakeMediaSource });
  capture.start();

  const ms = new FakeMediaSource();
  const v = ms.addSourceBuffer('video/mp4; codecs="av01"');
  v.appendBuffer(makeInit());
  v.appendBuffer(makeMedia(1));

  const mid = capture.getResult();
  assert.ok(mid.video, 'getResult 應已收集到 video');
  const midGot = await blobBytes(mid.video);
  assert.deepEqual(midGot, concatBytes(makeInit(), makeMedia(1)));

  // getResult 後仍可繼續收集
  v.appendBuffer(makeMedia(2));
  const final = capture.stop();
  const finalGot = await blobBytes(final.video);
  assert.deepEqual(finalGot, concatBytes(makeInit(), makeMedia(1), makeMedia(2)));
});

test('沒有 append 任何資料的 track 回傳 null', () => {
  const capture = createCapture({ getMediaSource: () => FakeMediaSource });
  capture.start();
  const ms = new FakeMediaSource();
  ms.addSourceBuffer('video/mp4; codecs="av01"'); // 建立 track 但沒 append
  const r = capture.stop();
  assert.equal(r.video, null);
  assert.equal(r.audio, null);
});

// ===========================================================================
// 6. 掛鉤不影響原 appendBuffer（原方法仍被呼叫）
// ===========================================================================

test('掛鉤不影響原 appendBuffer：原始方法仍被呼叫', () => {
  const capture = createCapture({ getMediaSource: () => FakeMediaSource });
  capture.start();

  const ms = new FakeMediaSource();
  const v = ms.addSourceBuffer('video/mp4; codecs="av01"');
  const data = makeInit();
  v.appendBuffer(data);

  // FakeSourceBuffer.appendBuffer 應被呼叫並記錄原始 data
  assert.equal(v.appended.length, 1);
  assert.ok(v.appended[0] === data || v.appended[0].byteLength === data.byteLength);

  capture.stop();
});

// ===========================================================================
// 7. 冪等：重複 start 不重複掛
// ===========================================================================

test('重複 start 不重複掛（append 一次只收集一份）', async () => {
  const capture = createCapture({ getMediaSource: () => FakeMediaSource });
  capture.start();
  capture.start(); // 第二次應為 no-op，不會嵌套掛鉤

  const ms = new FakeMediaSource();
  const v = ms.addSourceBuffer('video/mp4; codecs="av01"');
  const init = makeInit();
  v.appendBuffer(init); // 只 append 一次

  const r = capture.stop();
  const got = await blobBytes(r.video);
  // 若重複掛鉤，會被收集兩次 → blob 長度翻倍。這裡應恰好一份。
  assert.deepEqual(got, concatBytes(init));
});

test('stop 卸鉤後 appendBuffer 不再被收集', async () => {
  const capture = createCapture({ getMediaSource: () => FakeMediaSource });
  capture.start();

  const ms = new FakeMediaSource();
  const v = ms.addSourceBuffer('video/mp4; codecs="av01"');
  v.appendBuffer(makeInit());

  capture.stop(); // 卸鉤，還原 addSourceBuffer

  // stop 後新建的 SourceBuffer 不應被包裝（append 不被收集）
  const v2 = ms.addSourceBuffer('video/mp4; codecs="av01"');
  assert.equal(v2.appended.length, 0, 'stop 後的新 sb 未被包裝前 appended 為空');
  v2.appendBuffer(makeMedia(1));

  const r = capture.getResult();
  const got = await blobBytes(r.video);
  // 只包含 stop 前收集的 init，後來的 media 不應出現
  assert.deepEqual(got, concatBytes(makeInit()));
});
