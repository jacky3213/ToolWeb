import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackDriver } from '../src/playback-driver.js';

// ---------------------------------------------------------------------------
// 自製 stub：FakeVideo
//
// 不引 jsdom。實作 playback-driver 需要的 <video> 介面：
//   屬性：muted / playbackRate / currentTime / duration
//   方法：play()（回傳可控制 resolve/reject 的 Promise）、pause()
//   addEventListener / removeEventListener：記錄監聽器
//   emit(event, ...args)：手動觸發事件，並提供 listenerCount() 查數量
// ---------------------------------------------------------------------------

class FakeVideo {
  constructor() {
    this.muted = false;
    this.playbackRate = 1;
    this.currentTime = 0;
    this.duration = 100; // 預設長度，供 onProgress 讀取

    this.playCalled = false;
    this.pauseCalled = false;

    this._playMode = 'resolve'; // 'resolve' | 'reject'
    this._playError = null;

    this._listeners = new Map(); // event -> Set<fn>
  }

  play() {
    this.playCalled = true;
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        if (this._playMode === 'reject') {
          reject(this._playError || new Error('play() rejected'));
        } else {
          resolve();
        }
      });
    });
  }

  pause() {
    this.pauseCalled = true;
  }

  addEventListener(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
  }

  removeEventListener(event, fn) {
    const set = this._listeners.get(event);
    if (set) set.delete(fn);
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) fn(...args);
  }

  listenerCount(event) {
    const set = this._listeners.get(event);
    return set ? set.size : 0;
  }
}

// 等待所有 microtask 排空（play() 的 reject/resolve 走 queueMicrotask）
function flush() {
  return new Promise((r) => queueMicrotask(r));
}

// ===========================================================================
// 1. start() 正確設定 muted / playbackRate / currentTime，並呼叫 play()
// ===========================================================================

test('start() 設定 muted=true、playbackRate=16、currentTime=0', async () => {
  const v = new FakeVideo();
  const driver = createPlaybackDriver({ findVideo: () => v });
  await driver.start();

  assert.equal(v.muted, true, '應靜音');
  assert.equal(v.playbackRate, 16, '播放速率應為 16x');
  assert.equal(v.currentTime, 0, '應從頭播放');
});

// ===========================================================================
// 2. play() 被呼叫（用 flag 驗證）
// ===========================================================================

test('start() 呼叫了 video.play()', async () => {
  const v = new FakeVideo();
  const driver = createPlaybackDriver({ findVideo: () => v });
  await driver.start();

  assert.equal(v.playCalled, true);
});

// ===========================================================================
// 3. ended 事件觸發 onComplete
// ===========================================================================

test('ended 事件觸發 onComplete', async () => {
  const v = new FakeVideo();
  let completed = false;
  const driver = createPlaybackDriver({
    findVideo: () => v,
    onComplete: () => { completed = true; },
  });
  await driver.start();

  v.emit('ended');
  assert.equal(completed, true);
});

// ===========================================================================
// 4. timeupdate 事件觸發 onProgress，參數含 currentTime / duration
// ===========================================================================

test('timeupdate 事件觸發 onProgress，參數含 currentTime/duration', async () => {
  const v = new FakeVideo();

  let captured = null;
  const driver = createPlaybackDriver({
    findVideo: () => v,
    onProgress: (p) => { captured = p; },
  });
  await driver.start();

  // start() 會把 currentTime 重設為 0，progress 應讀取播放過程中的當前值
  v.currentTime = 25.5;
  v.duration = 200;
  v.emit('timeupdate');
  assert.ok(captured, 'onProgress 應被呼叫');
  assert.equal(captured.currentTime, 25.5);
  assert.equal(captured.duration, 200);
});

// ===========================================================================
// 5. error 事件觸發 onError
// ===========================================================================

test('error 事件觸發 onError', async () => {
  const v = new FakeVideo();
  const errObj = new Error('media error');

  let got = null;
  const driver = createPlaybackDriver({
    findVideo: () => v,
    onError: (e) => { got = e; },
  });
  await driver.start();

  v.emit('error', errObj);
  assert.equal(got, errObj);
});

// ===========================================================================
// 6. play() reject 時觸發 onError
// ===========================================================================

test('play() reject 時觸發 onError', async () => {
  const v = new FakeVideo();
  v._playMode = 'reject';
  v._playError = new Error('autoplay blocked');

  let got = null;
  const driver = createPlaybackDriver({
    findVideo: () => v,
    onError: (e) => { got = e; },
  });
  await driver.start();
  await flush();

  assert.ok(got, 'play() 失敗應回報 onError');
  assert.equal(got.message, 'autoplay blocked');
});

// ===========================================================================
// 7. cancel() 還原 playbackRate=1、muted=false、pause()，並移除監聽器
// ===========================================================================

test('cancel() 還原速率/靜音、pause、移除監聽器', async () => {
  const v = new FakeVideo();
  const driver = createPlaybackDriver({ findVideo: () => v });
  await driver.start();

  assert.equal(v.listenerCount('ended'), 1);
  assert.equal(v.listenerCount('timeupdate'), 1);
  assert.equal(v.listenerCount('error'), 1);

  driver.cancel();

  assert.equal(v.playbackRate, 1, '速率還原為 1');
  assert.equal(v.muted, false, '取消靜音');
  assert.equal(v.pauseCalled, true, '應呼叫 pause()');

  assert.equal(v.listenerCount('ended'), 0, 'ended 監聽器已移除');
  assert.equal(v.listenerCount('timeupdate'), 0, 'timeupdate 監聽器已移除');
  assert.equal(v.listenerCount('error'), 0, 'error 監聽器已移除');
});

// ===========================================================================
// 8. 重複 start 不重複綁定（監聽器只綁一次）
// ===========================================================================

test('重複 start 不重複綁定（監聽器只綁一次）', async () => {
  const v = new FakeVideo();
  const driver = createPlaybackDriver({ findVideo: () => v });

  await driver.start();
  await driver.start(); // 第二次應為 no-op，不重複綁定
  await driver.start();

  assert.equal(v.listenerCount('ended'), 1);
  assert.equal(v.listenerCount('timeupdate'), 1);
  assert.equal(v.listenerCount('error'), 1);

  // 取消後再 start 仍能正常運作（重綁一次）
  driver.cancel();
  assert.equal(v.listenerCount('ended'), 0);

  await driver.start();
  assert.equal(v.listenerCount('ended'), 1, 'cancel 後再 start 應重新綁定');
  // play 仍只應被呼叫一次 per start（共用 instance，play 每次 start 都呼叫）
});

// ===========================================================================
// 9. 預防性：findVideo 取不到時回報錯誤（onError）
// ===========================================================================

test('findVideo 取不到時呼叫 onError 而非靜默', async () => {
  let got = null;
  const driver = createPlaybackDriver({
    findVideo: () => null,
    onError: (e) => { got = e; },
  });
  await driver.start();

  assert.ok(got, '找不到 video 應回報 onError');
  assert.match(got.message, /video/i);
});
