// =============================================================================
// playback-driver.js —— 播放控制器（攔截式下載的「被動」跟播驅動）
//
// 攔截式下載是「被動」的：播放器播到哪，就攔到哪。因此本模組負責把 YouTube
// 播放器以 playbackRate = 16、muted 加速靜音跟播，從頭播到尾，邊播邊攔。
//
// 介面：
//   createPlaybackDriver({ findVideo, onComplete, onProgress, onError })
//     -> { start, cancel }
// =============================================================================

export function createPlaybackDriver({
  findVideo,
  onComplete,
  onProgress,
  onError,
} = {}) {
  const getVideo = findVideo || (() => document.querySelector('video'));

  let video = null;
  let bound = false;

  // 固定的監聽器引用，確保 removeEventListener 能精準移除同一個函式。
  const onEnded = () => {
    if (onComplete) onComplete();
  };
  const onTimeUpdate = () => {
    if (onProgress) onProgress({ currentTime: video.currentTime, duration: video.duration });
  };
  const onErrorEvent = (err) => {
    reportError(err);
  };

  function reportError(err) {
    if (onError) {
      onError(err);
    } else {
      throw err;
    }
  }

  function bind() {
    if (bound || !video) return;
    video.addEventListener('ended', onEnded);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('error', onErrorEvent);
    bound = true;
  }

  function unbind() {
    if (!bound || !video) return;
    video.removeEventListener('ended', onEnded);
    video.removeEventListener('timeupdate', onTimeUpdate);
    video.removeEventListener('error', onErrorEvent);
    bound = false;
  }

  // --------------------------------------------------------------------------
  // start()：取得 video → 設定靜音/16x/從頭 → 綁事件 → play()
  // --------------------------------------------------------------------------
  async function start() {
    video = getVideo();
    if (!video) {
      reportError(new Error('video element not found'));
      return;
    }

    video.muted = true;
    video.playbackRate = 16;
    video.currentTime = 0;

    bind();

    try {
      await video.play();
    } catch (err) {
      reportError(err);
    }
  }

  // --------------------------------------------------------------------------
  // cancel()：還原速率/靜音 → pause() → 移除監聽器
  // --------------------------------------------------------------------------
  function cancel() {
    if (!video) return;

    video.playbackRate = 1;
    video.muted = false;
    video.pause();

    unbind();
  }

  return { start, cancel };
}
