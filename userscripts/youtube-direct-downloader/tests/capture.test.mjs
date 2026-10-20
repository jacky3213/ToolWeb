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

// 建立 capture 的標準方式：注入 FakeMediaSource 與 FakeSourceBuffer。
function mkCapture() {
  return createCapture({
    getMediaSource: () => FakeMediaSource,
    getSourceBuffer: () => FakeSourceBuffer,
  });
}

// ---- 測試用的資料工廠 ----

function makeInit() {
  // 合法的 ftyp box：前 4 bytes 是 size(8)，第 5–8 bytes 是 'ftyp'
  return new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
}

// 建立一個帶 moov→trak→mdia→hdlr 的完整 init segment，供 detectTrackKind 解析。
// handlerType：'vide' 或 'soun'
function makeInitWithHandler(handlerType) {
  const hdlrHandler = handlerType === 'vide'
    ? [0x76, 0x69, 0x64, 0x65] // 'vide'
    : [0x73, 0x6f, 0x75, 0x6e]; // 'soun'

  // hdlr box: [size][type='hdlr'][version+flags 4B][pre_defined 4B][handler_type 4B][...]
  const hdlrPayload = [
    0x00, 0x00, 0x00, 0x00, // version + flags
    0x00, 0x00, 0x00, 0x00, // pre_defined
    ...hdlrHandler,          // handler_type
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // reserved + name
  ];
  const hdlrBox = buildBox('hdlr', new Uint8Array(hdlrPayload));

  // mdia box: [size]['mdia'][hdlr box]
  const mdiaBox = buildBox('mdia', hdlrBox);

  // trak box: [size]['trak'][mdia box]
  const trakBox = buildBox('trak', mdiaBox);

  // moov box: [size]['moov'][trak box]
  const moovBox = buildBox('moov', trakBox);

  // ftyp box + moov box
  const ftyp = makeInit();
  return concatBytes(ftyp, moovBox);
}

function buildBox(type, payload) {
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  return out;
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

test('isInitSegment：mp4(ftyp) 與 webm(EBML) 兩種 init 都要判斷', () => {
  assert.equal(isInitSegment(makeInit()), true, 'mp4 ftyp init');
  assert.equal(isInitSegment(makeInit().buffer), true, 'ArrayBuffer 輸入也應判斷');

  // webm/EBML：offset 0–3 = 0x1A 0x45 0xDF 0xA3
  const webmInit = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0x93, 0x42, 0x82, 0x88]);
  assert.equal(isInitSegment(webmInit), true, 'webm EBML init');

  // 非 init：前 4 bytes 是 size，第 5–8 不是 ftyp，也非 EBML
  const notInit = new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76]); // moov
  assert.equal(isInitSegment(notInit), false);

  assert.equal(isInitSegment(new Uint8Array([1, 2, 3, 4, 5, 6, 7])), false, '不足 4 bytes');
  assert.equal(isInitSegment(new Uint8Array(8)), false, '全 0 不是 init');
});

// ===========================================================================
// 2. video / audio 依 mime 分流
// ===========================================================================

test('video/audio 依 mime 正確分流', async () => {
  const capture = mkCapture();
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
  const capture = mkCapture();
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
  const capture = mkCapture();
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
  const capture = mkCapture();
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
  const capture = mkCapture();
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
  const capture = mkCapture();
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
  const capture = mkCapture();
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
  const capture = mkCapture();
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
  const capture = mkCapture();
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

test('stop 後 appendBuffer 不再被收集（hook 常駐但 recording 關閉）', async () => {
  const capture = mkCapture();
  capture.start();

  const ms = new FakeMediaSource();
  const v = ms.addSourceBuffer('video/mp4; codecs="av01"');
  v.appendBuffer(makeInit());

  capture.stop(); // recording 關閉，但 hook 常駐

  // stop 後同一 SourceBuffer 再 append 不應被收集（recording=false）
  v.appendBuffer(makeMedia(1));

  const r = capture.getResult();
  const got = await blobBytes(r.video);
  // 只包含 stop 前收集的 init，後來的 media 不應出現
  assert.deepEqual(got, concatBytes(makeInit()));
});

test('SourceBuffer 在 start 前建立，start 後 appendBuffer 仍能被攔到（核心修復）', async () => {
  // 模擬真實情境：影片已播放、SourceBuffer 早已建立，使用者才點下載。
  const capture = mkCapture();
  const ms = new FakeMediaSource();
  const v = ms.addSourceBuffer('video/mp4; codecs="av01"'); // start 前就建立

  capture.start(); // 此時才掛鉤

  const init = makeInitWithHandler('vide'); // 帶 moov/hdlr，供 detectTrackKind 判斷
  const m1 = makeMedia(1);
  v.appendBuffer(init); // 已存在的 SourceBuffer 也要能攔到
  v.appendBuffer(m1);

  const r = capture.stop();
  const got = await blobBytes(r.video);
  assert.deepEqual(got, concatBytes(init, m1), '已存在的 SourceBuffer 應被攔到');
});

test('start() 清空 media 但保留 init segment（moov），避免拼出無 moov 的 Blob', async () => {
  const capture = mkCapture();
  const ms = new FakeMediaSource();
  const v = ms.addSourceBuffer('video/mp4; codecs="av01"');

  // 第一次 start + 收集 init + 一些 media（模擬「點下載前」已播放）
  capture.start();
  const init = makeInitWithHandler('vide');
  v.appendBuffer(init);
  v.appendBuffer(makeMedia(1));
  v.appendBuffer(makeMedia(2));

  // 第二次 start（點下載）：應清空 media，但保留 init
  capture.start();

  // 重新 append 新的 media（模擬 16x 跟播）
  const m3 = makeMedia(3);
  v.appendBuffer(m3);

  const r = capture.stop();
  const got = await blobBytes(r.video);
  // 結果應是 init + m3，而不是 init + m1 + m2 + m3（舊 media 被清掉）
  assert.deepEqual(got, concatBytes(init, m3), 'init 應保留、舊 media 應清空');
});
