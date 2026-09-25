// ==UserScript==
// @name         Olevod 影片預載器 (Video Preloader)
// @namespace    https://github.com/jacky3213
// @version      1.2.3
// @license      MIT
// @description  在 Olevod 看片時提前預下載後續 HLS 分片（5/10/15/30 分鐘可選），支援智慧預下一集、即時速度/流量/命中率統計、暫停/清除快取、斷點恢復、自動收合、失敗退避重試。
// @author       Jacky
// @match        https://www.olevod.com/*
// @match        https://olevod.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * 安裝方式：
 * 1. 開啟 Tampermonkey 管理面板 → 「+」新增腳本 → 貼上本檔全部內容 → 儲存 (Ctrl+S)
 * 2. 重新整理 Olevod 影片頁，右下角會出現「⚡ Olevod 預載」小面板
 *
 * v1.1.0 功能：
 * - 預載時長 5/10/15/30 分鐘可選（自動記憶）
 * - 智慧預下一集：本集預載達標後，自動解析並預載下一集開頭
 * - 即時統計：下載速度 / 累計流量 / 快取命中率
 * - 面板控制：暫停預載、清除快取、快取佔用顯示
 * - 斷點恢復：重新整理後沿用先前快取，自動提示
 * - 自動收合：預載達標後面板縮為小圓點，滑鼠靠近展開
 * - 失敗退避：分片連續失敗時自動放慢並警示，成功後恢復
 *
 * 原理：
 * - document-start 階段包裝 XMLHttpRequest / fetch，比站點 bundle 先就位
 * - 偵測 .m3u8 播放清單（master + video/audio 軌）→ 解析出全部分片
 * - 預下載「目前播放位置之後 N 分鐘」的分片存入 Cache API
 * - hls.js 再請求分片時，攔截層直接從快取回傳位元組（近乎 0 延遲）
 */
(function () {
  'use strict';
  if (window.__olevodPreloaderActive) return;
  window.__olevodPreloaderActive = true;

  // 診斷日誌：在 Console 看到「injected」代表腳本已成功注入
  console.info('%c[Olevod Preloader] v1.2.3 injected @ ' + location.href, 'color:#38bdf8;font-weight:bold');

  /* ===================== 常數與狀態 ===================== */
  const CACHE_NAME = 'olevod-preload-v1';
  const LS_MINUTES = 'olevodPreloadMinutes';
  const LS_PAUSED = 'olevodPreloadPaused';
  const M3U8_RE = /\.m3u8(\?|#|$)/i;
  const SEG_RE = /\.(ts|m4s|mp4|aac)(\?|#|$)/i;
  const TICK_MS = 2000;
  const WORKERS = 2;            // 當前集預下載並發數
  const NEXT_WORKERS = 1;       // 下一集預下載並發數（讓路給當前集）
  const EVICT_BEHIND_SEC = 180; // 播放位置之前超過此秒數的分片自動清除
  const CLEANUP_MS = 60000;     // 快取清理週期
  const NEXT_CHECK_MS = 10000;  // 下一集檢查週期

  const origFetch = window.fetch.bind(window);
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let session = null;      // { key, gen, playlists: Map<url, pl>, segSet: Set, consecFails, totalFails }
  let gen = 0;
  let busy = false;
  let cacheRef = null;
  let paused = localStorage.getItem(LS_PAUSED) === '1';

  // 統計
  const stats = { bytes: 0, hits: 0, misses: 0, totalFails: 0 };
  const speedSamples = []; // {t, b}
  const sizes = new Map(); // url -> bytes（本頁面生命週期內）
  let lastPct = 0;

  // 下一集預載狀態
  // null 或 { status: idle|fetching|ready|failed|done, pageUrl, segs, starts, next, note }
  let nextPrefetch = null;
  const nextSet = new Set();

  // 瞬時訊息（恢復提示等）
  let transientMsg = null;
  let transientUntil = 0;
  let restoredNoticed = false;

  // 面板收合
  let collapsed = false;
  let collapseTimer = null;

  function preloadMinutes() {
    const v = parseInt(localStorage.getItem(LS_MINUTES) || '10', 10);
    return [5, 10, 15, 30].includes(v) ? v : 10;
  }

  function getCache() {
    if (!cacheRef) {
      cacheRef = caches.open(CACHE_NAME).catch(() => null);
    }
    return cacheRef;
  }

  /* ===================== 播放清單解析 ===================== */

  function masterKeyOf(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/');
      parts.pop();
      return u.origin + parts.join('/');
    } catch (e) { return url; }
  }

  function resolveUrl(base, uri) {
    try { return new URL(uri, base).href; } catch (e) { return uri; }
  }

  function parseMaster(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        for (let j = i + 1; j < lines.length; j++) {
          const l2 = lines[j].trim();
          if (l2 && !l2.startsWith('#')) { out.push(resolveUrl(baseUrl, l2)); break; }
        }
      }
    }
    return out;
  }

  function parseMedia(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const segs = [];
    let pendingDur = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-MAP')) {
        const m = line.match(/URI="([^"]+)"/);
        if (m) segs.push({ url: resolveUrl(baseUrl, m[1]), dur: 0 });
      } else if (line.startsWith('#EXTINF')) {
        const d = parseFloat(line.slice(line.indexOf(':') + 1));
        pendingDur = isNaN(d) ? 0 : d;
      } else if (!line.startsWith('#')) {
        if (pendingDur !== null) {
          segs.push({ url: resolveUrl(baseUrl, line), dur: pendingDur });
          pendingDur = null;
        }
      }
    }
    return segs;
  }

  function buildTimeline(segs) {
    let t = 0;
    const starts = [];
    for (const s of segs) { starts.push(t); t += s.dur; }
    return { starts, total: t };
  }

  // 換集：不整段清快取（由週期清理接管），重置會話狀態
  function newSession(key) {
    gen++;
    session = { key, gen, playlists: new Map(), segSet: new Set(), consecFails: 0, totalFails: 0 };
    nextPrefetch = null;
    nextSet.clear();
  }

  async function noticeRestore(segs) {
    if (restoredNoticed) return;
    try {
      const cache = await getCache();
      if (!cache) return;
      const K = Math.min(6, segs.length);
      let c = 0;
      for (let i = 0; i < K; i++) {
        if (await cache.match(segs[i].url)) c++;
      }
      if (c >= 3) {
        restoredNoticed = true;
        showTransient('✓ 已從上次進度恢復（沿用先前快取）', 8000);
      }
    } catch (e) {}
  }

  function registerMediaPlaylist(url, text) {
    if (!session) newSession(masterKeyOf(url));
    const segs = parseMedia(text, url);
    if (!segs.length) return;
    const tl = buildTimeline(segs);
    session.playlists.set(url, { url, segs, starts: tl.starts, total: tl.total, next: 0 });
    for (const s of segs) session.segSet.add(s.url);
    console.info('[Olevod Preloader] 偵測到播放清單:', url, '→', segs.length, '個分片,', Math.round(tl.total / 60), '分鐘');
    noticeRestore(segs);
  }

  function handlePlaylist(url, text) {
    try {
      if (/EXT-X-STREAM-INF/.test(text)) {
        const key = masterKeyOf(url);
        if (!session || session.key !== key) newSession(key);
        const variants = parseMaster(text, url);
        for (const v of variants) fetchPlaylistQuietly(v);
      } else if (/EXTINF/.test(text)) {
        const key = masterKeyOf(url);
        if (!session || session.key !== key) newSession(key);
        registerMediaPlaylist(url, text);
      }
    } catch (e) { /* 解析失敗不影響頁面 */ }
  }

  function fetchPlaylistQuietly(url) {
    origFetch(url).then(r => r.ok ? r.text() : '')
      .then(t => { if (t) handlePlaylist(url, t); })
      .catch(() => {});
  }

  /* ===================== 下載與統計 ===================== */

  async function downloadSegment(url) {
    const cache = await getCache();
    if (!cache) return false;
    const r = await origFetch(url);
    if (!r.ok) return false;
    const size = parseInt(r.headers.get('content-length') || '0', 10);
    await cache.put(url, r);
    const real = size || 0;
    stats.bytes += real;
    sizes.set(url, real);
    const now = Date.now();
    speedSamples.push({ t: now, b: real });
    while (speedSamples.length && now - speedSamples[0].t > 10000) speedSamples.shift();
    return true;
  }

  function noteSuccess() {
    if (session) session.consecFails = 0;
  }

  function noteFailure() {
    if (!session) return;
    session.consecFails++;
    session.totalFails++;
    stats.totalFails++;
  }

  function lastIndexUpTo(starts, segs, target) {
    let idx = -1;
    const n = Math.min(starts.length, segs.length);
    for (let i = 0; i < n; i++) {
      if (starts[i] + segs[i].dur <= target) idx = i;
      else break;
    }
    return Math.min(idx, segs.length - 1);
  }

  async function tick() {
    if (!session || busy || paused) return;
    busy = true;
    const myGen = session.gen;
    try {
      const video = document.querySelector('video');
      const cur = video && isFinite(video.currentTime) ? video.currentTime : 0;
      const target = cur + preloadMinutes() * 60;

      const jobs = [];
      for (const pl of session.playlists.values()) {
        const endIdx = lastIndexUpTo(pl.starts, pl.segs, target);
        for (let i = pl.next; i <= endIdx; i++) {
          jobs.push({ pl, i, url: pl.segs[i].url });
        }
      }

      const cache = await getCache();
      let p = 0;
      const worker = async () => {
        while (p < jobs.length && session && session.gen === myGen && !paused) {
          // 失敗退避：連續失敗時放慢
          if (session.consecFails >= 3) {
            await sleep(Math.min(session.consecFails * 2000, 15000));
            if (!session || session.gen !== myGen || paused) return;
          }
          const j = jobs[p++];
          try {
            const hit = cache && await cache.match(j.url);
            if (session.gen !== myGen) return; // 換集後丟棄結果
            if (!hit) {
              if (await downloadSegment(j.url)) noteSuccess();
              else noteFailure();
            } else {
              noteSuccess();
            }
            j.pl.next = Math.max(j.pl.next, j.i + 1);
            refreshUI(); // 每完成一個分片立即刷新
          } catch (e) { noteFailure(); }
        }
      };
      await Promise.all(Array.from({ length: WORKERS }, worker));

      // 清除落後播放位置太遠的舊分片
      if (cache && video) {
        const cutoff = cur - EVICT_BEHIND_SEC;
        for (const pl of session.playlists.values()) {
          for (let i = 0; i < pl.starts.length; i++) {
            if (pl.starts[i] + pl.segs[i].dur < cutoff) {
              cache.delete(pl.segs[i].url).catch(() => {});
              sizes.delete(pl.segs[i].url);
            }
          }
        }
      }
      refreshUI();
    } catch (e) {
      /* 忽略 */
    } finally {
      busy = false;
    }
  }

  setInterval(tick, TICK_MS);

  /* ===================== 智慧預下一集 ===================== */

  function getNextPageUrl() {
    const m = location.href.match(/^(.*\/[^\/]*?)-(\d+)(\.html)(\?.*)?$/);
    if (!m) return null;
    return m[1] + '-' + (parseInt(m[2], 10) + 1) + m[3] + (m[4] || '');
  }

  function findStreamUrlInHtml(html) {
    let idx = html.indexOf('master.m3u8');
    if (idx < 0) idx = html.indexOf('.m3u8');
    if (idx < 0) return null;
    const isMaster = html.indexOf('master.m3u8') === idx;
    const end = idx + (isMaster ? 'master.m3u8' : '.m3u8').length;
    let start = html.lastIndexOf('http', idx);
    if (start < 0) return null;
    let url = html.slice(start, end);
    url = url.split('"')[0].split("'")[0].split('\\')[0].split(' ')[0].split('<')[0];
    url = url.replace(/\\\//g, '/');
    try { url = decodeURIComponent(url); } catch (e) {}
    if (!/\.m3u8$/.test(url)) return null;
    return url;
  }

  function currentTargetFullyCached() {
    try {
      const video = document.querySelector('video');
      const cur = video && isFinite(video.currentTime) ? video.currentTime : 0;
      const target = cur + preloadMinutes() * 60;
      for (const pl of session.playlists.values()) {
        if (pl.next <= lastIndexUpTo(pl.starts, pl.segs, target)) return false;
      }
      return session.playlists.size > 0;
    } catch (e) { return false; }
  }

  async function loadNextPlaylists(masterUrl) {
    const np = nextPrefetch;
    const pl0 = await (await origFetch(masterUrl)).text();
    if (nextPrefetch !== np) return; // 換集後丟棄
    let mediaUrls = [];
    if (/EXT-X-STREAM-INF/.test(pl0)) {
      mediaUrls = parseMaster(pl0, masterUrl);
    } else if (/EXTINF/.test(pl0)) {
      mediaUrls = [masterUrl];
    }
    // 每條子清單（視頻/音頻）各自持有分片清單、時間軸與 next 計數器
    np.lists = [];
    for (const mu of mediaUrls) {
      if (nextPrefetch !== np) return;
      const t = await (await origFetch(mu)).text();
      if (nextPrefetch !== np) return;
      const segs = parseMedia(t, mu);
      if (!segs.length) continue;
      const tl = buildTimeline(segs);
      np.lists.push({ segs, starts: tl.starts, total: tl.total, next: 0 });
      for (const s of segs) nextSet.add(s.url);
    }
    nextPrefetch.status = np.lists.length ? 'ready' : 'failed';
    if (nextPrefetch.status === 'failed') nextPrefetch.note = '下一集分片解析失敗';
  }

  async function advanceNextPrefetch() {
    if (!nextPrefetch || nextPrefetch.status !== 'ready' || paused) return;
    if (nextPrefetch.busy) return;
    const np = nextPrefetch;
    np.busy = true;
    try {
      const cache = await getCache();
      if (!cache) return;
      const target = preloadMinutes() * 60;
      // 每條子清單各自推進自己的 next 計數器，互不干擾
      let progressed = true;
      while (progressed && !paused && nextPrefetch === np) {
        progressed = false;
        for (const list of np.lists) {
          if (!nextPrefetch || nextPrefetch !== np || paused) break;
          const endIdx = lastIndexUpTo(list.starts, list.segs, target);
          const idx = list.next;
          if (idx > endIdx || idx >= list.segs.length) continue;
          const seg = list.segs[idx];
          try {
            const hit = await cache.match(seg.url);
            if (nextPrefetch !== np) return;
            if (!hit) {
              if (session && session.consecFails >= 3) await sleep(3000);
              if (nextPrefetch !== np) return;
              if (await downloadSegment(seg.url)) noteSuccess();
              else noteFailure();
              if (nextPrefetch !== np) return;
            }
            list.next = idx + 1;
            progressed = true;
            refreshUI();
          } catch (e) { noteFailure(); }
          if (paused) break;
        }
      }
      if (nextPrefetch === np && np.lists.every(l => l.next > lastIndexUpTo(l.starts, l.segs, target))) {
        nextPrefetch.status = 'done';
        nextPrefetch.note = '下一集預載完成 ✓';
      }
    } catch (e) {
      /* 忽略 */
    } finally {
      if (nextPrefetch === np) np.busy = false;
    }
  }

  async function checkNextEpisode() {
    try {
      if (!session || !session.playlists.size || paused) return;
      if (nextPrefetch) {
        if (nextPrefetch.status === 'ready') await advanceNextPrefetch();
        else if (nextPrefetch.status === 'failed' && Date.now() - (nextPrefetch.failAt || 0) > 60000) {
          nextPrefetch = null; // 失敗 60 秒後允許重試一次
        }
        return;
      }
      if (!currentTargetFullyCached()) return;
      const pageUrl = getNextPageUrl();
      if (!pageUrl) {
        nextPrefetch = { status: 'done', note: '無法推算下一集', lists: [] };
        return;
      }
      nextPrefetch = { status: 'fetching', pageUrl, lists: [], note: '解析下一集…' };
      const resp = await origFetch(pageUrl, { credentials: 'same-origin' });
      if (nextPrefetch && nextPrefetch.pageUrl !== pageUrl) return;
      if (!resp.ok) {
        nextPrefetch.status = 'failed'; nextPrefetch.note = '下一集頁面不存在'; nextPrefetch.failAt = Date.now();
        return;
      }
      const html = await resp.text();
      const streamUrl = findStreamUrlInHtml(html);
      if (!streamUrl) {
        nextPrefetch.status = 'failed'; nextPrefetch.note = '下一集影片連結未找到'; nextPrefetch.failAt = Date.now();
        return;
      }
      nextPrefetch.note = '下一集預載中…';
      await loadNextPlaylists(streamUrl);
      if (nextPrefetch && nextPrefetch.status === 'ready') await advanceNextPrefetch();
    } catch (e) {
      if (nextPrefetch && nextPrefetch.status === 'fetching') {
        nextPrefetch.status = 'failed';
        nextPrefetch.note = '下一集解析失敗';
        nextPrefetch.failAt = Date.now();
      }
    }
  }

  setInterval(() => { checkNextEpisode().catch(() => {}); }, NEXT_CHECK_MS);

  /* ===================== 週期清理 ===================== */

  setInterval(async () => {
    try {
      if (!session || !session.playlists.size) return;
      const cache = await getCache();
      if (!cache) return;
      const keep = new Set(session.segSet);
      for (const u of nextSet) keep.add(u);
      const keys = await cache.keys();
      for (const req of keys) {
        if (!keep.has(req.url)) {
          await cache.delete(req);
          sizes.delete(req.url);
        }
      }
    } catch (e) {}
  }, CLEANUP_MS);

  /* ===================== XHR / fetch 攔截 ===================== */

  function fakeXhrResponse(xhr, url, buf, contentType) {
    try {
      // 先把所有值算好，再一次性覆蓋實例屬性——避免中途拋錯留下半套假狀態
      const rt = xhr.responseType;
      let response, responseText;
      if (rt === 'arraybuffer' || rt === 'blob') {
        response = rt === 'blob' ? new Blob([buf], { type: contentType }) : buf;
      } else {
        responseText = new TextDecoder().decode(buf);
        response = responseText;
      }
      Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
      Object.defineProperty(xhr, 'status', { value: 200, configurable: true });
      Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true });
      Object.defineProperty(xhr, 'responseURL', { value: url, configurable: true });
      if (rt === 'arraybuffer' || rt === 'blob') {
        Object.defineProperty(xhr, 'response', { value: response, configurable: true });
      } else {
        Object.defineProperty(xhr, 'responseText', { value: responseText, configurable: true });
        Object.defineProperty(xhr, 'response', { value: response, configurable: true });
      }
      xhr.getResponseHeader = function (name) {
        const n = String(name).toLowerCase();
        if (n === 'content-type') return contentType;
        if (n === 'content-length') return String(buf.byteLength);
        return null;
      };
      xhr.getAllResponseHeaders = function () {
        return `content-type: ${contentType}\r\ncontent-length: ${buf.byteLength}\r\n`;
      };
      xhr.dispatchEvent(new Event('readystatechange'));
      xhr.dispatchEvent(new ProgressEvent('load'));
      xhr.dispatchEvent(new ProgressEvent('loadend'));
    } catch (e) {
      // 清掉已覆蓋的實例屬性，還原原型鏈後放行原始請求
      ['readyState', 'status', 'statusText', 'responseURL', 'response', 'responseText'].forEach(p => {
        try { delete xhr[p]; } catch (e2) {}
      });
      console.warn('[Olevod Preloader] 快取回應失敗，改走網路請求:', e);
      try { origSend.call(xhr); } catch (e2) {}
    }
  }

  async function serveXhrFromCache(url, xhr) {
    const cache = await getCache();
    let hit = null;
    try { hit = cache && await cache.match(url); } catch (e) {}
    if (!hit) {
      stats.misses++;
      try { origSend.call(xhr); } catch (e) {}
      return;
    }
    try {
      const buf = await hit.arrayBuffer();
      stats.hits++;
      fakeXhrResponse(xhr, url, buf, hit.headers.get('content-type') || 'video/MP2T');
    } catch (e) {
      stats.misses++;
      try { origSend.call(xhr); } catch (e2) {}
    }  }

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__olevodUrl = typeof url === 'string' ? url : String(url);
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const xhr = this;
    const url = xhr.__olevodUrl || '';
    try {
      if (M3U8_RE.test(url)) {
        xhr.addEventListener('load', () => {
          try {
            const text = xhr.responseType === '' || xhr.responseType === 'text'
              ? xhr.responseText : '';
            if (text) handlePlaylist(url, text);
          } catch (e) {}
        });
      } else if (session && (session.segSet.has(url) || SEG_RE.test(url))) {
        // 分片：先查快取，命中則本地回傳，未命中放行
        Promise.resolve(serveXhrFromCache(url, xhr)).catch((e) => {
          console.warn('[Olevod Preloader] 攔截層異常，放行原始請求:', e);
          try { origSend.call(xhr); } catch (e2) {}
        });
        return;
      }
    } catch (e) { /* 攔截層出錯一律放行 */ }
    return origSend.apply(this, args);
  };

  window.fetch = async function (input, init) {
    let url = '';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || '';
    } catch (e) {}
    try {
      if (url && session && (session.segSet.has(url) || SEG_RE.test(url))) {
        const cache = await getCache();
        const hit = cache && await cache.match(url);
        if (hit) { stats.hits++; return hit.clone(); }
        stats.misses++;
      }
    } catch (e) { /* 出錯走原始 fetch */ }
    const resp = await origFetch(input, init);
    try {
      if (url && M3U8_RE.test(url) && resp.ok) {
        const text = await resp.clone().text();
        if (text) handlePlaylist(url, text);
      }
    } catch (e) {}
    return resp;
  };

  /* ===================== 懸浮 UI ===================== */

  const ui = document.createElement('div');
  ui.id = 'olevod-preload-ui';
  ui.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
    'background:rgba(20,24,32,.92)', 'color:#e8eaf0', 'border-radius:10px',
    'padding:10px 12px', 'font:12px/1.5 -apple-system,"Segoe UI","Microsoft JhengHei",sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,.35)', 'min-width:230px', 'user-select:none'
  ].join(';');
  ui.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;font-weight:600">
      <span>⚡ Olevod 預載</span>
      <span id="op-mins" style="color:#7fd1ff"></span>
      <span style="flex:1"></span>
      <button id="op-pause" style="all:unset;cursor:pointer;color:#e8eaf0;padding:0 4px" title="暫停/恢復預載">⏸</button>
      <button id="op-hide" style="all:unset;cursor:pointer;color:#9aa3b2;padding:0 4px" title="收合為小圓點">—</button>
    </div>
    <div id="op-bar" style="margin:6px 0 4px;height:6px;border-radius:3px;background:#31394a;overflow:hidden">
      <div id="op-fill" style="height:100%;width:0%;background:linear-gradient(90deg,#3b82f6,#22d3ee);transition:width .4s"></div>
    </div>
    <div id="op-status" style="color:#9aa3b2">等待播放清單…</div>
    <div id="op-stats" style="color:#7d8597;margin-top:2px"></div>
    <div id="op-btns" style="display:flex;margin-top:6px;gap:4px;flex-wrap:wrap;align-items:center">
      ${[5, 10, 15, 30].map(m =>
        `<button data-min="${m}" style="all:unset;cursor:pointer;padding:2px 8px;border-radius:6px;background:#31394a;color:#e8eaf0">${m} 分</button>`
      ).join('')}
      <button id="op-clear" style="all:unset;cursor:pointer;padding:2px 8px;border-radius:6px;background:#31394a;color:#f87171" title="清除所有預載快取">🗑 清除快取</button>
    </div>`;

  const dot = document.createElement('div');
  dot.id = 'olevod-preload-dot';
  dot.title = 'Olevod 預載器（點擊或滑過展開）';
  dot.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
    'width:30px', 'height:30px', 'border-radius:50%', 'display:none',
    'background:linear-gradient(135deg,#3b82f6,#22d3ee)', 'color:#fff',
    'font-size:14px', 'text-align:center', 'line-height:30px', 'cursor:pointer',
    'box-shadow:0 4px 12px rgba(0,0,0,.4)', 'user-select:none'
  ].join(';');
  dot.textContent = '⚡';

  function $(id) { return ui.querySelector('#' + id); }
  function refreshMinsLabel() { $('op-mins').textContent = preloadMinutes() + ' 分鐘'; }
  function refreshBtnHighlight() {
    ui.querySelectorAll('#op-btns button[data-min]').forEach(b => {
      b.style.background = (+b.dataset.min === preloadMinutes()) ? '#3b82f6' : '#31394a';
    });
  }
  function refreshPauseBtn() { $('op-pause').textContent = paused ? '▶' : '⏸'; }

  function showTransient(msg, ms) {
    transientMsg = msg;
    transientUntil = Date.now() + (ms || 5000);
    updateStatusNow(msg);
  }

  function updateStatusNow(text) {
    const el = $('op-status');
    if (el) el.textContent = text;
  }

  function fmtBytes(b) {
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  }

  // 計算單條清單「預載領先播放位置」的秒數；next 越過結尾時用總長，避免 NaN
  function playlistAhead(pl, cur) {
    if (pl.next >= pl.segs.length) return Math.max(0, pl.total - cur);
    const st = pl.starts[pl.next] || 0;
    return Math.max(0, st - cur);
  }

  function composeBaseStatus(cur) {
    if (!session || !session.playlists.size) return '等待播放清單…';
    if (paused) return '⏸ 預載已暫停（點 ▶ 恢復）';
    let ahead = Infinity;
    for (const pl of session.playlists.values()) {
      ahead = Math.min(ahead, playlistAhead(pl, cur));
    }
    if (!isFinite(ahead)) ahead = 0;
    const goal = preloadMinutes() * 60;
    const m = Math.floor(ahead / 60), s = Math.round(ahead % 60);
    let txt;
    if (ahead >= goal) {
      txt = `✅ 本集已達標 (+${m} 分 ${s} 秒)`;
      if (nextPrefetch && (nextPrefetch.status === 'ready' || nextPrefetch.status === 'fetching')) {
        const l0 = nextPrefetch.lists && nextPrefetch.lists[0];
        if (l0 && l0.starts.length) {
          const na = l0.next >= l0.segs.length ? l0.total : (l0.starts[l0.next] || 0);
          txt += ` · 下一集 +${Math.floor(na / 60)} 分`;
        } else {
          txt += ` · ${nextPrefetch.note || '下一集準備中'}`;
        }
      } else if (nextPrefetch && nextPrefetch.note) {
        txt += ` · ${nextPrefetch.note}`;
      }
    } else {
      txt = `預載中：+${m} 分 ${s} 秒 / 目標 ${preloadMinutes()} 分鐘`;
    }
    if (session.consecFails >= 3) {
      txt += ` · ⚠ ${session.totalFails} 個分片失敗，已放慢重試`;
    }
    return txt;
  }

  let estCounter = 0;
  let lastEstimate = '';

  function updateUIProgress(cur) {
    try {
      if (!session || !session.playlists.size) return;
      let ahead = Infinity;
      for (const pl of session.playlists.values()) {
        ahead = Math.min(ahead, playlistAhead(pl, cur));
      }
      if (!isFinite(ahead)) ahead = 0;
      const goal = preloadMinutes() * 60;
      lastPct = Math.min(100, Math.round((ahead / goal) * 100));
      $('op-fill').style.width = lastPct + '%';

      const now = Date.now();
      if (transientMsg && now < transientUntil) {
        updateStatusNow(transientMsg);
      } else {
        if (transientMsg && now >= transientUntil) transientMsg = null;
        updateStatusNow(composeBaseStatus(cur));
      }

      // 統計行：速度 / 累計流量 / 命中率 / 快取佔用
      let speedBps = 0;
      for (const s of speedSamples) speedBps += s.b;
      const spd = speedBps > 0 ? fmtBytes(speedBps / 10) + '/s' : '--';
      const total = stats.hits + stats.misses;
      const hitTxt = total > 0 ? Math.round((stats.hits / total) * 100) + '%' : '--';
      let estTxt = lastEstimate;
      if (++estCounter >= 10) {
        estCounter = 0;
        if (navigator.storage && navigator.storage.estimate) {
          navigator.storage.estimate().then((e) => {
            lastEstimate = ' · 快取 ' + fmtBytes(e.usage || 0);
          }).catch(() => {});
        }
      }
      $('op-stats').textContent = `↓${spd} · 已下 ${fmtBytes(stats.bytes)} · 命中 ${hitTxt}${estTxt}`;

      // 自動收合：達標 5 秒後縮為小圓點
      if (lastPct >= 100 && !collapsed && !collapseTimer) {
        scheduleAutoCollapse(5000);
      } else if (lastPct < 100 && collapseTimer) {
        clearTimeout(collapseTimer);
        collapseTimer = null;
        if (collapsed) setCollapsed(false);
      }
    } catch (e) {}
  }

  function refreshUI() {
    try {
      const video = document.querySelector('video');
      const cur = video && isFinite(video.currentTime) ? video.currentTime : 0;
      updateUIProgress(cur);
    } catch (e) {}
  }
  setInterval(refreshUI, 1000);

  /* ===================== 收合 / 展開 ===================== */

  function setCollapsed(c) {
    collapsed = c;
    ui.style.display = c ? 'none' : 'block';
    dot.style.display = c ? 'block' : 'none';
  }

  function scheduleAutoCollapse(ms) {
    if (collapseTimer) clearTimeout(collapseTimer);
    if (lastPct >= 100) {
      collapseTimer = setTimeout(() => { collapseTimer = null; setCollapsed(true); }, ms);
    }
  }

  dot.addEventListener('mouseenter', () => {
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    setCollapsed(false);
  });
  ui.addEventListener('mouseenter', () => {
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  });
  ui.addEventListener('mouseleave', () => scheduleAutoCollapse(10000));

  /* ===================== 控制按鈕 ===================== */

  async function clearAllCache() {
    try {
      const c = await getCache();
      if (c) {
        const keys = await c.keys();
        await Promise.all(keys.map(k => c.delete(k)));
      }
    } catch (e) {}
    sizes.clear();
    stats.bytes = 0;
    speedSamples.length = 0;
    lastEstimate = '';
    if (session) for (const pl of session.playlists.values()) pl.next = 0;
    if (nextPrefetch) nextPrefetch.next = 0;
    showTransient('🗑 快取已清除，重新開始預載', 4000);
    refreshUI();
  }

  ui.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'op-pause') {
      paused = !paused;
      localStorage.setItem(LS_PAUSED, paused ? '1' : '0');
      refreshPauseBtn();
      if (!paused) tick();
    } else if (btn.id === 'op-clear') {
      clearAllCache();
    } else if (btn.id === 'op-hide') {
      setCollapsed(true);
    } else if (btn.dataset.min) {
      localStorage.setItem(LS_MINUTES, btn.dataset.min);
      refreshMinsLabel();
      refreshBtnHighlight();
      showTransient(`已切換預載時長：${btn.dataset.min} 分鐘`, 3000);
      tick(); // 立即按新目標推進
    }
  });

  /* ===================== 掛載 ===================== */

  function mountUI() {
    if (document.body && !document.getElementById('olevod-preload-ui')) {
      document.body.appendChild(ui);
      document.body.appendChild(dot);
      refreshMinsLabel();
      refreshBtnHighlight();
      refreshPauseBtn();
    }
  }
  const mountTimer = setInterval(mountUI, 500);

  refreshMinsLabel();
  refreshPauseBtn();
})();
