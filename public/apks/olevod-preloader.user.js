// ==UserScript==
// @name         Olevod 影片預載器 (Video Preloader)
// @namespace    https://github.com/jacky3213
// @version      1.3.0
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/jacky3213/ToolWeb/main/public/apks/olevod-preloader.user.js
// @downloadURL  https://raw.githubusercontent.com/jacky3213/ToolWeb/main/public/apks/olevod-preloader.user.js
// @description  在 Olevod / Gimy 劇迷（gimytw.cc 及分站）看片時提前預下載後續 HLS 分片（5/10/15/30 分鐘可選），支援智慧預下一集、即時速度/流量/命中率統計、暫停/清除快取、斷點恢復、自動收合、失敗退避重試；Gimy 站另支援多片源自動測速與一鍵切換最快線路。
// @author       Jacky
// @match        https://www.olevod.com/*
// @match        https://olevod.com/*
// @match        https://gimytv.io/*
// @match        https://gimytw.cc/*
// @match        https://gimy.tw/*
// @match        https://gimy.com/*
// @include      /^https?:\/\/([a-z0-9-]+\.)*gimy[a-z0-9-]*\.[a-z.]{2,7}\//
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 安裝方式：
 * 1. 開啟 Tampermonkey 管理面板 → 「+」新增腳本 → 貼上本檔全部內容 → 儲存 (Ctrl+S)
 * 2. 重新整理 Olevod / Gimy 影片頁，播放器右下角會出現「⚡ 預載」小面板
 *
 * v1.3.0 功能（Gimy 支援）：
 * - 支援 Gimy 劇迷家族（gimytv.io / gimytw.cc / gimy.tw / gimy.com 及 gimy* 分站）
 * - Gimy 的播放器位於同源 iframe（/_watch/<id>，內含 hls.js + DPlayer）：
 *   攔截層與預載引擎在 iframe 內運作，快取（Cache API）與頂層頁共用
 * - 頂層頁透過 postMessage 傳遞播放上下文（本集 / 下一集 / 當前線路），
 *   智慧預下一集會解析下一集頁面的「同一條線路」，線路標籤不符時依序退回同位置、第一條
 * - 片源自動測速（Gimy 頂層頁）：解析所有線路的 m3u8，
 *   測量 TTFB 與首片吞吐量，排名面板可一鍵切換線路，
 *   同劇結果快取 30 分鐘（各集線路共用同一上游），可選「自動選最快」
 *
 * v1.1.0 功能（Olevod）：
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
 * - 角色分工（v1.3.0）：
 *     main   = 頂層頁：Olevod 為完整功能；Gimy 為片源測速面板（預載在 iframe 內）
 *     player = Gimy 的 /_watch/ 播放器 iframe：攔截 + 預載 + 快取回放
 *     idle   = 其他框架（不動作，等效舊版 @noframes）
 */
(function () {
  'use strict';
  if (window.__olevodPreloaderActive) return;
  window.__olevodPreloaderActive = true;

  // 診斷日誌：在 Console 看到「injected」代表腳本已成功注入
  console.info('%c[Video Preloader] v1.3.0 injected @ ' + location.href, 'color:#38bdf8;font-weight:bold');

  /* ===================== 站點與角色偵測 ===================== */
  const HOST = location.hostname;
  // gimy 家族：任何一級標籤符合 gimy 前綴（gimytv.io / gimytw.cc / www.gimytv.io / 未來分站…）
  const IS_GIMY = HOST.split('.').some((l) => /^gimy[a-z0-9-]*$/.test(l));
  const IS_TOP = (() => {
    try { return window.top === window; } catch (e) { return false; }
  })();
  // gimy 播放器 iframe 固定位於 /_watch/ 路徑；其他同源框架（廣告框等）一律 idle
  const IS_WATCH = location.pathname.startsWith('/_watch');
  const ROLE = IS_TOP ? 'main' : (IS_GIMY && IS_WATCH ? 'player' : 'idle');
  // 需要安裝攔截層 / 預載引擎 / 預載面板的角色
  const PLAY_ROLE = (ROLE === 'main' && !IS_GIMY) || ROLE === 'player';
  const PANEL_TITLE = IS_GIMY ? '⚡ Gimy 預載' : '⚡ Olevod 預載';

  /* ===================== 常數與狀態 ===================== */
  const CACHE_BASE = 'olevod-preload-v1';
  const LS_MINUTES = 'olevodPreloadMinutes';
  const LS_PAUSED = 'olevodPreloadPaused';
  // localStorage 在隱私模式 / ITP 下可能拋 SecurityError，全部走安全包裝
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
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
  let paused = LS.get(LS_PAUSED, '0') === '1';

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
    const v = parseInt(LS.get(LS_MINUTES, '10'), 10);
    return [5, 10, 15, 30].includes(v) ? v : 10;
  }

  // 快取以「播放清單目錄（session key）」命名，各分頁 / 各劇互不干擾，
  // 避免週期清理刪掉其他分頁正在使用的分片
  function cacheNameFor(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) & 0x7fffffff;
    return CACHE_BASE + '-' + h.toString(36);
  }

  function getCache() {
    if (!cacheRef) {
      if (!session) return Promise.resolve(null);
      cacheRef = caches.open(cacheNameFor(session.key)).catch(() => null);
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

  // 換集：不整段清快取（由週期清理接管），重置會話狀態（並切換到該集專屬快取）
  function newSession(key) {
    gen++;
    session = { key, gen, playlists: new Map(), segSet: new Set(), consecFails: 0, totalFails: 0 };
    nextPrefetch = null;
    nextSet.clear();
    cacheRef = null; // 讓 getCache 重新打開新 key 對應的快取
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
    console.info('[Video Preloader] 偵測到播放清單:', url, '→', segs.length, '個分片,', Math.round(tl.total / 60), '分鐘');
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
    let r;
    try { r = await origFetch(url); } catch (e) { return false; }
    // Cache API 不接受 206 / opaque 回應，一律要求 200
    if (!r.ok || r.status !== 200) {
      try { if (r.body) r.body.cancel(); } catch (e) {}
      return false;
    }
    const size = parseInt(r.headers.get('content-length') || '0', 10);
    try {
      await cache.put(url, r);
    } catch (e) {
      try { if (r.body) r.body.cancel(); } catch (e2) {}
      return false;
    }
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

  if (PLAY_ROLE) setInterval(tick, TICK_MS);

  /* ===================== Gimy 播放上下文（postMessage） ===================== */

  // 頂層頁（gimy main）蒐集本集資訊傳給播放器 iframe；iframe 需要時也可主動請求
  let gimyCtx = null; // { epsUrl, nextEpsUrl, watchUrl, lineLabel, lineIndex }

  function requestCtx() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __opCtxReq: 1 }, location.origin);
      }
    } catch (e) {}
  }

  function collectGimyCtx() {
    try {
      if (!/^\/eps\//.test(location.pathname)) return null;
      const tabEls = Array.from(document.querySelectorAll('a.gico[href*="/_watch/"]'));
      if (!tabEls.length) return null;
      let active = document.querySelector('a.gico.active[href*="/_watch/"]');
      const frame = document.querySelector('iframe[name="p-frame"]');
      if (!active && frame) {
        const src = frame.getAttribute('src') || '';
        active = tabEls.find((t) => {
          const h = t.getAttribute('href') || '';
          return h && (src === h || src.endsWith(h));
        }) || null;
      }
      let nextEpsUrl = null;
      for (const a of document.querySelectorAll('a[href*="/eps/"]')) {
        const href = a.getAttribute('href') || '';
        const txt = (a.textContent || '').trim();
        if (/下一集/.test(txt) && href && !/javascript:/i.test(href)) {
          nextEpsUrl = resolveUrl(location.href, href);
          break;
        }
      }
      // 無法確定當前線路時如實回報 null / -1，不得謊報第一條
      const activeLabel = active ? (active.textContent || '').trim() : null;
      const activeIdx = active ? tabEls.indexOf(active) : -1;
      return {
        epsUrl: location.href,
        nextEpsUrl: nextEpsUrl,
        watchUrl: active ? resolveUrl(location.href, active.getAttribute('href') || '') : null,
        lineLabel: activeLabel,
        lineIndex: activeIdx
      };
    } catch (e) { return null; }
  }

  function sendCtxToFrame() {
    try {
      const ctx = collectGimyCtx();
      if (!ctx) return false;
      const frame = document.querySelector('iframe[name="p-frame"]');
      if (!frame || !frame.contentWindow) return false;
      frame.contentWindow.postMessage({ __opCtx: ctx }, location.origin);
      return true;
    } catch (e) { return false; }
  }

  window.addEventListener('message', (ev) => {
    try {
      if (ev.origin !== location.origin) return;
      const d = ev.data;
      if (!d || typeof d !== 'object') return;
      if (d.__opCtx && ROLE === 'player') {
        // 只接受真正的父頁
        if (ev.source !== window.parent) return;
        gimyCtx = d.__opCtx;
      } else if (d.__opCtxReq && ROLE === 'main' && IS_GIMY) {
        // 只回應目前掛載的播放器 iframe
        const frame = document.querySelector('iframe[name="p-frame"]');
        if (!frame || ev.source !== frame.contentWindow) return;
        sendCtxToFrame();
      }
    } catch (e) {}
  });

  if (ROLE === 'player' && IS_GIMY) {
    // 輪詢請求上下文，直到收到為止（最多 30 次，避免無限 postMessage）
    requestCtx();
    let ctxTries = 0;
    const ctxPoll = setInterval(() => {
      if (gimyCtx || ++ctxTries > 30) { clearInterval(ctxPoll); return; }
      requestCtx();
    }, 1000);
  }

  if (ROLE === 'main' && IS_GIMY) {
    let ctxArmed = false;
    // 持續重送（1 秒一次）直到頁面離開；內容有變時 player 會即時收到最新版
    const ctxMount = setInterval(() => {
      const frame = document.querySelector('iframe[name="p-frame"]');
      if (!frame) return;
      if (!ctxArmed) {
        frame.addEventListener('load', () => { setTimeout(() => sendCtxToFrame(), 300); });
        ctxArmed = true;
      }
      sendCtxToFrame();
    }, 1000);
    // 站方分頁（onclick="pp(this)"）切換線路時補送上下文
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('a.gico[href*="/_watch/"]')) {
        setTimeout(() => sendCtxToFrame(), 500);
      }
    }, true);
  }

  /* ===================== 智慧預下一集 ===================== */

  function getNextPageUrl() {
    const m = location.href.match(/^(.*\/[^\/]*?)-(\d+)(\.html)(\?.*)?$/);
    if (!m) return null;
    return m[1] + '-' + (parseInt(m[2], 10) + 1) + m[3] + (m[4] || '');
  }

  // gimy：優先用頂層頁傳來的 下一集連結，否則對 /eps/<id>-<數字>.html 做數字遞增
  function gimyNextEpsUrl() {
    if (gimyCtx && gimyCtx.nextEpsUrl) return gimyCtx.nextEpsUrl;
    const base = (gimyCtx && gimyCtx.epsUrl) || location.href;
    const m = base.match(/^(.*\/eps\/\d+)-(\d+)(\.html)(\?.*)?$/);
    if (!m) return null;
    return m[1] + '-' + (parseInt(m[2], 10) + 1) + m[3] + (m[4] || '');
  }

  // 從 eps 頁 HTML 解析所有 線路分頁（僅限 a.gico + /_watch/，與 DOM 端 currentTabs 一致，href 去重）
  function parseWatchTabsFromHtml(html) {
    const out = [];
    const seen = new Set();
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const attrs = m[1];
      const hrefM = attrs.match(/href="([^"]*)"/i) || attrs.match(/href='([^']*)'/i);
      if (!hrefM || !/_watch\//.test(hrefM[1])) continue;
      const clsM = attrs.match(/class="([^"]*)"/i) || attrs.match(/class='([^']*)'/i);
      if (!clsM || !/(^|\s)gico(\s|$)/.test(clsM[1])) continue;
      const href = hrefM[1];
      if (seen.has(href)) continue;
      seen.add(href);
      out.push({ href: href, label: m[2].replace(/<[^>]*>/g, '').trim() });
    }
    return out;
  }

  // 從 /_watch/ 播放頁 HTML 抽出 m3u8（gimy 用 var url='...'，失敗則退回通用搜尋）
  // 注意：var url 的值已是 JS 字串字面值，不做 decodeURIComponent 以免破壞 token 中的 %xx
  function extractM3u8FromWatchHtml(html) {
    const m = html.match(/var\s+url\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i);
    if (m) return m[1].replace(/\\\//g, '/');
    return findStreamUrlInHtml(html);
  }

  function findStreamUrlInHtml(html) {
    // 優先抓完整絕對網址（允許帶 query），避免 token 被截斷
    const abs = html.match(/(https?:\/\/[^\s"'<>\\]+?\.m3u8(?:\?[^\s"'<>\\]*)?)/i);
    if (abs) return abs[1].replace(/\\\//g, '/');
    // 相對路徑退回：舊式擷取
    let idx = html.indexOf('.m3u8');
    if (idx < 0) return null;
    const end = idx + '.m3u8'.length;
    const start = html.lastIndexOf('http', idx);
    if (start < 0) return null;
    let url = html.slice(start, end);
    url = url.split('"')[0].split("'")[0].split('\\')[0].split(' ')[0].split('<')[0];
    url = url.replace(/\\\//g, '/');
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
    if (nextPrefetch.status === 'failed') {
      nextPrefetch.note = '下一集分片解析失敗';
      nextPrefetch.failAt = Date.now(); // 60 秒後才重試，避免高頻打站
    }
  }

  async function advanceNextPrefetch() {
    if (!nextPrefetch || nextPrefetch.status !== 'ready' || paused) return;
    if (nextPrefetch.busy) return;
    const np = nextPrefetch;
    if (!Array.isArray(np.lists) || !np.lists.length) return; // 空 lists 不推進，避免誤判完成
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
      if (nextPrefetch === np && np.lists.length &&
          np.lists.every(l => l.next > lastIndexUpTo(l.starts, l.segs, target))) {
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
    let np = null;
    try {
      if (!session || !session.playlists.size || paused) return;
      if (nextPrefetch) {
        if (nextPrefetch.status === 'fetching') return; // 防重入
        if (nextPrefetch.status === 'ready') return await advanceNextPrefetch();
        if (nextPrefetch.status === 'failed' && Date.now() - (nextPrefetch.failAt || 0) > 60000) {
          nextPrefetch = null; // 失敗 60 秒後允許重試一次
        } else {
          return;
        }
      }
      if (!currentTargetFullyCached()) return;
      const pageUrl = IS_GIMY ? gimyNextEpsUrl() : getNextPageUrl();
      if (!pageUrl) {
        // 可重試狀態（ctx 可能尚未送達），不鎖死
        nextPrefetch = { status: 'failed', note: IS_GIMY ? '尚未取得下一集連結' : '無法推算下一集', failAt: IS_GIMY ? 0 : Date.now(), lists: [] };
        return;
      }
      np = { status: 'fetching', pageUrl, lists: [], note: '解析下一集…' };
      nextPrefetch = np;
      const resp = await origFetch(pageUrl, { credentials: 'same-origin' });
      if (nextPrefetch !== np) return;
      if (!resp.ok) {
        np.status = 'failed'; np.note = '下一集頁面不存在'; np.failAt = Date.now();
        return;
      }
      const html = await resp.text();
      let streamUrl = null;
      if (IS_GIMY) {
        // 找出下一集頁面中「同一條線路」的 /_watch/ 連結，再從其播放頁抽 m3u8
        const tabs = parseWatchTabsFromHtml(html);
        let pick = null;
        if (tabs.length) {
          if (gimyCtx && gimyCtx.lineLabel) pick = tabs.find((t) => t.label === gimyCtx.lineLabel);
          if (!pick && gimyCtx && typeof gimyCtx.lineIndex === 'number' && gimyCtx.lineIndex >= 0) {
            pick = tabs[gimyCtx.lineIndex] || null;
          }
          if (!pick) pick = tabs[0];
        }
        if (pick) {
          const watchAbs = resolveUrl(pageUrl, pick.href);
          const wresp = await origFetch(watchAbs, { credentials: 'same-origin' });
          if (nextPrefetch !== np) return;
          if (wresp.ok) {
            const whtml = await wresp.text();
            const found = extractM3u8FromWatchHtml(whtml);
            if (found) streamUrl = resolveUrl(watchAbs, found);
          }
        }
        if (!streamUrl) streamUrl = findStreamUrlInHtml(html); // 退回通用搜尋
      } else {
        streamUrl = findStreamUrlInHtml(html);
      }
      if (nextPrefetch !== np) return;
      if (!streamUrl) {
        np.status = 'failed'; np.note = '下一集影片連結未找到'; np.failAt = Date.now();
        return;
      }
      np.note = '下一集預載中…';
      await loadNextPlaylists(streamUrl);
      if (nextPrefetch === np && np.status === 'ready') await advanceNextPrefetch(); // 不等下個週期，立即開始
    } catch (e) {
      if (np && nextPrefetch === np) {
        np.status = 'failed';
        np.note = '下一集解析失敗';
        np.failAt = Date.now();
      }
    }
  }

  if (PLAY_ROLE) setInterval(() => { checkNextEpisode().catch(() => {}); }, NEXT_CHECK_MS);

  /* ===================== 週期清理 ===================== */

  // meta 時間標記的固定絕對網址（各快取共用此 key 存 ts）
  const META_URL = location.origin + '/__olevod_preload_meta__';

  if (PLAY_ROLE) setInterval(async () => {
    try {
      if (!session || !session.playlists.size) return;
      const cache = await getCache();
      if (!cache) return;
      const keep = new Set(session.segSet);
      for (const u of nextSet) keep.add(u);
      keep.add(META_URL);
      const keys = await cache.keys();
      for (const req of keys) {
        if (!keep.has(req.url)) {
          await cache.delete(req);
          sizes.delete(req.url);
        }
      }
      // 寫入時間標記，供舊劇快取回收掃描使用
      // 注意：__meta__ 必須用絕對 URL（origin 固定），否則相對路徑會隨當前頁面路徑解析，
      // 導致換集/跨分頁讀不到 meta，6 小時 TTL 失效並誤刪其他分頁的快取
      try { await cache.put(META_URL, new Response(JSON.stringify({ ts: Date.now() }))); } catch (e) {}
      await sweepStaleCaches();
    } catch (e) {}
  }, CLEANUP_MS);

  // 每集使用獨立快取（避免跨分頁互刪），久未更新的舊快取在此回收
  async function sweepStaleCaches() {
    try {
      const names = await caches.keys();
      const cur = session ? cacheNameFor(session.key) : null;
      for (const name of names) {
        if (name !== CACHE_BASE && !name.startsWith(CACHE_BASE + '-')) continue; // 不碰其他腳本的快取
        if (name === cur) continue;
        let stale = name === CACHE_BASE; // v1.2 以前的共用快取視為舊資料
        if (!stale) {
          try {
            const c = await caches.open(name);
            const meta = await c.match(META_URL);
            let ts = 0;
            if (meta) { try { ts = (await meta.json()).ts || 0; } catch (e2) {} }
            stale = Date.now() - ts > 6 * 3600 * 1000;
          } catch (e2) {}
        }
        if (stale) await caches.delete(name);
      }
    } catch (e) {}
  }

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
      console.warn('[Video Preloader] 快取回應失敗，改走網路請求:', e);
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

  if (PLAY_ROLE) {
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
            console.warn('[Video Preloader] 攔截層異常，放行原始請求:', e);
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
  }

  /* ===================== 懸浮 UI（預載面板，僅 PLAY_ROLE） ===================== */

  // 僅在需要預載的角色上建立 DOM；其他角色（idle / gimy 頂層頁）不產生任何面板
  let ui = null;
  let dot = null;
  if (PLAY_ROLE) {
    ui = document.createElement('div');
    ui.id = 'olevod-preload-ui';
    ui.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'background:rgba(20,24,32,.92)', 'color:#e8eaf0', 'border-radius:10px',
      'padding:10px 12px', 'font:12px/1.5 -apple-system,"Segoe UI","Microsoft JhengHei",sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,.35)', 'min-width:230px', 'user-select:none'
    ].join(';');
    ui.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;font-weight:600">
      <span>${PANEL_TITLE}</span>
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
      <button id="op-clear" style="all:unset;cursor:pointer;padding:2px 8px;border-radius:6px;background:#31394a;color:#f87171" title="清除本集預載快取">🗑 清除快取</button>
    </div>`;

    dot = document.createElement('div');
    dot.id = 'olevod-preload-dot';
    dot.title = PANEL_TITLE + '（點擊或滑過展開）';
    dot.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'width:30px', 'height:30px', 'border-radius:50%', 'display:none',
      'background:linear-gradient(135deg,#3b82f6,#22d3ee)', 'color:#fff',
      'font-size:14px', 'text-align:center', 'line-height:30px', 'cursor:pointer',
      'box-shadow:0 4px 12px rgba(0,0,0,.4)', 'user-select:none'
    ].join(';');
    dot.textContent = '⚡';
  }

  function $(id) { return ui ? ui.querySelector('#' + id) : null; }
  function refreshMinsLabel() { const el = $('op-mins'); if (el) el.textContent = preloadMinutes() + ' 分鐘'; }
  function refreshBtnHighlight() {
    if (!ui) return;
    ui.querySelectorAll('#op-btns button[data-min]').forEach(b => {
      b.style.background = (+b.dataset.min === preloadMinutes()) ? '#3b82f6' : '#31394a';
    });
  }
  function refreshPauseBtn() { const el = $('op-pause'); if (el) el.textContent = paused ? '▶' : '⏸'; }

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
  if (PLAY_ROLE) setInterval(refreshUI, 1000);

  /* ===================== 收合 / 展開 ===================== */

  function setCollapsed(c) {
    if (!ui || !dot) return;
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

  if (PLAY_ROLE) {
    dot.addEventListener('mouseenter', () => {
      if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
      setCollapsed(false);
    });
    dot.addEventListener('click', () => { // 觸控裝置沒有 hover，點擊也要能展開
      if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
      setCollapsed(false);
    });
    ui.addEventListener('mouseenter', () => {
      if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    });
    ui.addEventListener('mouseleave', () => scheduleAutoCollapse(10000));
  }

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
    // 下一集的計數器在 lists[].next 上，需一併重置並允許重新推進；
    // lists 為空（解析尚未成功）時直接丟棄，避免被誤升成 ready 後寫入假 done
    if (nextPrefetch) {
      if (Array.isArray(nextPrefetch.lists) && nextPrefetch.lists.length) {
        nextPrefetch.lists.forEach((l) => { l.next = 0; });
        if (nextPrefetch.status === 'done' || nextPrefetch.status === 'failed') {
          nextPrefetch.status = 'ready';
          nextPrefetch.note = '下一集重新預載…';
          nextPrefetch.failAt = 0;
        }
      } else if (nextPrefetch.status === 'done' || nextPrefetch.status === 'ready') {
        nextPrefetch = null; // 讓下一輪重新解析下一集
      }
    }
    showTransient('🗑 快取已清除，重新開始預載', 4000);
    refreshUI();
  }

  if (PLAY_ROLE) ui.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'op-pause') {
      paused = !paused;
      LS.set(LS_PAUSED, paused ? '1' : '0');
      refreshPauseBtn();
      if (!paused) tick();
    } else if (btn.id === 'op-clear') {
      clearAllCache();
    } else if (btn.id === 'op-hide') {
      setCollapsed(true);
    } else if (btn.dataset.min) {
      LS.set(LS_MINUTES, btn.dataset.min);
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
  if (PLAY_ROLE) {
    const mountTimer = setInterval(() => {
      mountUI();
      if (document.getElementById('olevod-preload-ui')) clearInterval(mountTimer);
    }, 500);
  }

  if (PLAY_ROLE) {
    refreshMinsLabel();
    refreshPauseBtn();
  }

  /* ===================== Gimy 片源測速（頂層頁面板） ===================== */
  // 僅在 gimy 頂層頁的 /eps/ 播放頁運作：
  // 1. 收集所有 a.gico 線路分頁（/_watch/<id>）
  // 2. 逐線路解析播放頁內的 m3u8 → 測 TTFB + 首片吞吐量（上限 768KB / 6 秒）
  // 3. 排名面板可一鍵切換線路；同劇結果以 sessionStorage 快取 30 分鐘
  const SPEED_TTL_MS = 30 * 60 * 1000;
  const SPEED_CAP_BYTES = 768 * 1024;
  const SPEED_CAP_MS = 6000;
  const SPEED_TIMEOUT_MS = 10000;
  const LS_AUTO_FAST = 'gimyPreloadAutoFast';
  let speedState = { running: false, rows: [], done: false };
  let speedPanelMounted = false;

  function vodIdOf() {
    const m = location.pathname.match(/^\/eps\/(\d+)-/); // 錨定開頭，取 vod id 而非集數 slug
    return m ? m[1] : location.pathname;
  }

  function speedCacheKey() { return 'opSpeed:' + vodIdOf(); }

  function loadSpeedCache() {
    try {
      const raw = sessionStorage.getItem(speedCacheKey());
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.rows) || !data.rows.length) return null;
      if (!Number.isFinite(data.ts) || Date.now() - data.ts > SPEED_TTL_MS) return null;
      return data.rows;
    } catch (e) { return null; }
  }

  function saveSpeedCache(rows) {
    try {
      // 全部失敗（網路抖動）時不寫快取，避免把使用者鎖在失敗畫面 30 分鐘
      if (!rows.some((r) => r.status === 'ok')) return;
      // 只保存與線路本身相關的欄位；href 每集都不同，切換時一律以標籤即時查表
      const slim = rows.map((r) => ({ label: r.label, host: r.host, status: r.status, mbps: r.mbps, ttfbMs: r.ttfbMs }));
      sessionStorage.setItem(speedCacheKey(), JSON.stringify({ ts: Date.now(), rows: slim }));
    } catch (e) {}
  }

  function currentTabs() {
    return Array.from(document.querySelectorAll('a.gico[href*="/_watch/"]'))
      .map((a) => ({ href: a.getAttribute('href') || '', label: (a.textContent || '').trim() }))
      .filter((t) => t.href);
  }

  function activeTabLabel() {
    try {
      const a = document.querySelector('a.gico.active[href*="/_watch/"]');
      if (a) return (a.textContent || '').trim();
      const frame = document.querySelector('iframe[name="p-frame"]');
      if (frame) {
        const src = frame.getAttribute('src') || '';
        const t = currentTabs().find((x) => src === x.href || src.endsWith(x.href));
        if (t) return t.label;
      }
    } catch (e) {}
    return null;
  }

  function switchToLabel(idxOrLabel) {
    try {
      const anchors = Array.from(document.querySelectorAll('a.gico[href*="/_watch/"]'));
      // 支援以索引（列與當前分頁順序一一對應，重複 label 也不會切錯）或 label 切換
      const tab = typeof idxOrLabel === 'number'
        ? anchors[idxOrLabel]
        : anchors.find((a) => (a.textContent || '').trim() === idxOrLabel);
      if (!tab) return false;
      const abs = resolveUrl(location.href, tab.getAttribute('href') || '');
      const frame = document.querySelector('iframe[name="p-frame"]');
      if (!frame) return false;
      const beforeSrc = frame.getAttribute('src') || '';
      // 優先走站方 pp(this)，保持站方內部狀態同步；600ms 後驗證真的有換，沒換才自癒
      try {
        if (typeof window.pp === 'function') window.pp.call(tab, tab);
      } catch (e) { /* 走退回路徑 */ }
      setTimeout(() => {
        try {
          const nowSrc = frame.getAttribute('src') || '';
          if (nowSrc === beforeSrc) {
            frame.src = abs; // pp 靜默失效，直接設 src
          }
          // 以元素物件為準同步 active 樣式（避免字串比對受 query/大小寫影響）
          Array.from(document.querySelectorAll('a.gico[href*="/_watch/"]')).forEach((a) => {
            a.classList.toggle('active', a === tab);
          });
          sendCtxToFrame();
          renderSpeedPanel();
        } catch (e) {}
      }, 600);
      renderSpeedPanel();
      return true;
    } catch (e) { return false; }
  }

  function maybeAutoSwitch() {
    try {
      if (LS.get(LS_AUTO_FAST, '0') !== '1') return;
      if (!speedState.done || speedState.running) return;
      const best = speedState.rows
        .filter((r) => r.status === 'ok' && typeof r.mbps === 'number')
        .sort((a, b) => b.mbps - a.mbps)[0];
      if (!best) return;
      if (activeTabLabel() !== best.label) switchToLabel(best.label);
    } catch (e) {}
  }

  async function testWatchLine(label, href) {
    const row = { label, host: null, status: 'fail', mbps: null, ttfbMs: null };
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const signal = ctrl ? ctrl.signal : undefined;
    // referrer 用 /_watch/ 頁面網址，與播放器 iframe 的請求環境一致（同源可指定）
    const referrer = resolveUrl(location.href, href);
    let reader = null;
    const timer = setTimeout(() => { try { if (ctrl) ctrl.abort(); } catch (e) {} }, SPEED_TIMEOUT_MS);
    try {
      const presp = await origFetch(href, { credentials: 'same-origin', signal: signal, referrer: referrer });
      if (!presp.ok) return row;
      const phtml = await presp.text();
      let m3u8 = extractM3u8FromWatchHtml(phtml);
      if (!m3u8) return row;
      m3u8 = resolveUrl(href, m3u8);
      try { row.host = new URL(m3u8).host; } catch (e) { return row; }

      const mresp = await origFetch(m3u8, { signal: signal, referrer: referrer });
      if (!mresp.ok) return row;
      const plText = await mresp.text();

      let mediaUrl = m3u8;
      let plMedia = plText;
      if (/EXT-X-STREAM-INF/.test(plText)) {
        // 取最高 BANDWIDTH 的變體，貼近播放器實際選擇的畫質
        let bestUrl = null;
        let bestBw = -1;
        const lines = plText.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i].trim();
          if (!l.startsWith('#EXT-X-STREAM-INF')) continue;
          const bw = parseInt((l.match(/BANDWIDTH=(\d+)/) || [])[1] || '0', 10);
          for (let j = i + 1; j < lines.length; j++) {
            const l2 = lines[j].trim();
            if (l2 && !l2.startsWith('#')) {
              if (bw >= bestBw) { bestBw = bw; bestUrl = resolveUrl(m3u8, l2); }
              break;
            }
          }
        }
        if (!bestUrl) bestUrl = parseMaster(plText, m3u8)[0];
        if (!bestUrl) return row;
        mediaUrl = bestUrl;
        const m2 = await origFetch(mediaUrl, { signal: signal, referrer: referrer });
        if (!m2.ok) return row;
        plMedia = await m2.text();
      }
      const segs = parseMedia(plMedia, mediaUrl);
      // fMP4/CMAF：segs[0] 可能是 EXT-X-MAP 的 init 段（僅數 KB），會讓 Mbps 嚴重高估，跳過
      const seg = segs.find((s) => s.dur > 0) || segs[0];
      if (!seg) return row;

      const t2 = performance.now();
      const sresp = await origFetch(seg.url, { signal: signal, referrer: referrer });
      if (!sresp.ok || !sresp.body) return row;
      row.ttfbMs = Math.round(performance.now() - t2); // 首片 TTFB（比 m3u8 TTFB 更貼近起播延遲）
      reader = sresp.body.getReader();
      let bytes = 0;
      while (bytes < SPEED_CAP_BYTES) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value ? chunk.value.length : 0;
        if (performance.now() - t2 > SPEED_CAP_MS) break;
      }
      const secs = (performance.now() - t2) / 1000;
      if (secs <= 0 || bytes <= 0) return row;
      row.mbps = Math.round((bytes * 8 / secs / 1e6) * 100) / 100;
      row.status = 'ok';
    } catch (e) { /* 失敗列保持 fail */ }
    finally {
      clearTimeout(timer);
      try { if (ctrl) ctrl.abort(); } catch (e2) {}   // 釋放未讀完的連線
      try { if (reader) reader.releaseLock(); } catch (e2) {}
    }
    return row;
  }

  async function runSpeedTest(tabs) {
    if (speedState.running) return; // 防止重複觸發造成狀態互蓋
    try {
      speedState = {
        running: true,
        done: false,
        rows: tabs.map((t) => ({ label: t.label, host: null, status: 'testing', mbps: null, ttfbMs: null }))
      };
      renderSpeedPanel();
      let p = 0;
      const worker = async () => {
        while (p < tabs.length) {
          const i = p++;
          try {
            const row = await testWatchLine(tabs[i].label, tabs[i].href);
            const cur = speedState.rows[i];
            // testWatchLine 只會回傳 'ok' | 'fail'
            if (cur) Object.assign(cur, row, { status: row.status });
          } catch (e) { /* 單線路失敗不影響其他線路 */ }
          renderSpeedPanel();
        }
      };
      await Promise.all([worker(), worker()]);
      speedState.rows.forEach((r) => { if (r.status === 'testing') r.status = 'fail'; });
      saveSpeedCache(speedState.rows);
    } finally {
      speedState.running = false;
      speedState.done = true;
      renderSpeedPanel();
      maybeAutoSwitch();
    }
  }

  function speedRowSort(a, b) {
    const rank = (r) => (r.status === 'testing' ? 1 : (r.status === 'ok' ? 0 : 2));
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (rank(a) === 0) return (b.mbps || 0) - (a.mbps || 0);
    return 0;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  let lastSpeedSig = '';

  function renderSpeedPanel() {
    try {
      const panel = document.getElementById('gimy-speed-panel');
      if (!panel) return;
      const listEl = panel.querySelector('#gs-list');
      if (!listEl) return;
      const activeLabel = activeTabLabel();
      const rows = speedState.rows
        .map((r, i) => ({ r: r, idx: i }))
        .sort((a, b) => speedRowSort(a.r, b.r));
      const bestLabel = (rows[0] && rows[0].r.status === 'ok') ? rows[0].r.label : null;
      // 簽章短路：內容未變不重寫 innerHTML，避免每秒重繪吞掉點擊（含 running 狀態，確保結束時 summary/↻ 更新）
      const sig = (speedState.running ? 'R|' : 'D|') + String(activeLabel) + '|' + rows.map((x) =>
        x.r.label + '~' + x.r.status + '~' + x.r.mbps + '~' + x.r.ttfbMs + '~' + x.r.host).join(';');
      if (sig === lastSpeedSig) return;
      lastSpeedSig = sig;
      listEl.innerHTML = rows.map((x) => {
        const r = x.r;
        const label = String(r.label || '');
        const isCur = label === activeLabel;
        const isBest = label === bestLabel;
        let badge = '…';
        let color = '#7d8597';
        if (r.status === 'ok') {
          badge = (r.mbps || 0).toFixed(2) + ' Mbps · TTFB ' + (r.ttfbMs != null ? r.ttfbMs + 'ms' : '--');
          color = isBest ? '#4ade80' : '#e8eaf0';
        } else if (r.status === 'fail') {
          badge = '✗ 連線失敗';
          color = '#f87171';
        } else if (r.status === 'testing') {
          badge = '測速中…';
          color = '#7fd1ff';
        }
        const bg = isCur ? 'rgba(59,130,246,.25)' : (isBest ? 'rgba(74,222,128,.10)' : 'transparent');
        const border = isCur ? '1px solid #3b82f6' : (isBest ? '1px solid rgba(74,222,128,.4)' : '1px solid transparent');
        return `<div class="gs-row" data-idx="${x.idx}" style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;background:${bg};border:${border};cursor:pointer">
          <span style="min-width:52px;font-weight:600;color:${isCur ? '#7fd1ff' : '#e8eaf0'}">${isCur ? '▶ ' : ''}${escapeHtml(label)}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#7d8597">${escapeHtml(r.host) || '--'}</span>
          <span style="color:${color}">${badge}</span>
        </div>`;
      }).join('');
      const summary = panel.querySelector('#gs-summary');
      if (summary) {
        summary.textContent = speedState.running
          ? `測速中…（${speedState.rows.filter((r) => r.status !== 'testing').length}/${speedState.rows.length}）`
          : `共 ${speedState.rows.length} 條線路 · 點擊切換 · 同劇快取 30 分鐘`;
      }
      const retestBtn = panel.querySelector('#gs-retest');
      if (retestBtn) {
        retestBtn.disabled = !!speedState.running;
        retestBtn.style.opacity = speedState.running ? '.45' : '1';
        retestBtn.style.cursor = speedState.running ? 'not-allowed' : 'pointer';
      }
    } catch (e) {}
  }

  function mountSpeedPanel() {
    try {
      if (document.getElementById('gimy-speed-panel')) { speedPanelMounted = true; return; }
      const tabs = currentTabs();
      if (!tabs.length) return;
      const anchor = tabs[0].closest && (tabs[0].closest('.details-play-title') || tabs[0].parentElement);
      const panel = document.createElement('div');
      panel.id = 'gimy-speed-panel';
      panel.style.cssText = [
        'margin:10px 0', 'padding:10px 12px', 'border-radius:10px',
        'background:rgba(20,24,32,.92)', 'color:#e8eaf0',
        'font:12px/1.6 -apple-system,"Segoe UI","Microsoft JhengHei",sans-serif',
        'box-shadow:0 4px 16px rgba(0,0,0,.25)', 'user-select:none'
      ].join(';');
      panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:4px">
          <span>🚀 片源測速</span>
          <span id="gs-summary" style="flex:1;font-weight:400;color:#9aa3b2"></span>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400;color:#9aa3b2;cursor:pointer">
            <input type="checkbox" id="gs-auto" ${LS.get(LS_AUTO_FAST, '0') === '1' ? 'checked' : ''}> 自動選最快
          </label>
          <button id="gs-retest" style="all:unset;cursor:pointer;padding:2px 8px;border-radius:6px;background:#31394a;color:#e8eaf0" title="重新測速">↻</button>
        </div>
        <div id="gs-list"></div>`;
      if (anchor && anchor.parentElement) {
        anchor.insertAdjacentElement('afterend', panel);
      } else {
        document.body.appendChild(panel);
      }
      panel.addEventListener('click', (e) => {
        if (e.target.id === 'gs-retest') {
          try { sessionStorage.removeItem(speedCacheKey()); } catch (err) {}
          runSpeedTest(currentTabs()).catch(() => {});
          return;
        }
        const row = e.target.closest && e.target.closest('.gs-row');
        if (row && row.dataset.idx != null) switchToLabel(parseInt(row.dataset.idx, 10));
      });
      panel.addEventListener('change', (e) => {
        if (e.target.id === 'gs-auto') {
          LS.set(LS_AUTO_FAST, e.target.checked ? '1' : '0');
          if (e.target.checked) maybeAutoSwitch();
        }
      });
      speedPanelMounted = true;
      lastSpeedSig = ''; // 重掛後強制重繪，避免簽章短路留下空白面板
      renderSpeedPanel();
    } catch (e) {}
  }

  if (ROLE === 'main' && IS_GIMY) {
    let speedBootstrapped = false;
    // 常駐守護：面板被站方重繪移除時自動重掛（沿用既有測速結果，不重測）
    const speedMount = setInterval(() => {
      try {
        if (!/^\/eps\//.test(location.pathname)) return;
        const tabs = currentTabs();
        if (!tabs.length) return;
      if (!document.getElementById('gimy-speed-panel')) {
        mountSpeedPanel();
        if (!speedPanelMounted) return;
      }
      // 面板重掛後 lastSpeedSig 可能殘留舊簽章，強制重繪一次內容
        if (!speedBootstrapped) {
          speedBootstrapped = true;
          const cached = loadSpeedCache();
          const curLabels = tabs.map((t) => t.label).slice().sort().join('|');
          if (cached && cached.map((r) => r.label).slice().sort().join('|') === curLabels) {
            // 依當前分頁順序還原快取列（重複 label 以「各取一條」方式對位，不互相覆蓋）
            const pool = cached.slice();
            speedState = {
              running: false,
              done: true,
              rows: tabs.map((t) => {
                const i = pool.findIndex((r) => r.label === t.label);
                const row = i >= 0 ? pool.splice(i, 1)[0] : { label: t.label, host: null, status: 'fail', mbps: null, ttfbMs: null };
                return row;
              })
            };
            renderSpeedPanel();
            // 還原快取路徑不觸發自動切換，避免每次換集中斷播放
          } else {
            runSpeedTest(tabs).catch(() => {});
          }
        } else {
          renderSpeedPanel(); // 維持當前線路高亮同步
        }
      } catch (e) {}
    }, 1000);
  }
})();
