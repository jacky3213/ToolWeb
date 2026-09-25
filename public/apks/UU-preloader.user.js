// ==UserScript==
// @name         UU看書自動預讀 10 章 (完備版)
// @namespace    https://github.com/jacky3213
// @version      2.0
// @updateURL    https://raw.githubusercontent.com/jacky3213/ToolWeb/main/public/apks/UU-preloader.user.js
// @downloadURL  https://raw.githubusercontent.com/jacky3213/ToolWeb/main/public/apks/UU-preloader.user.js
// @description  預讀10章、閱讀進度智慧跳轉、右側導航面板、防重複/節流/重試/中斷保護
// @author       K7
// @match        https://uukanshu.cc/book/*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      uukanshu.cc
// @run-at       document-end
// @noframes
// ==/UserScript==
(function() {
    'use strict';

    const MAX_NEXT = 10;
    const CHAPTER_DELAY = 1000;
    const MAX_RETRY = 3;
    const VISIT_WINDOW = 48 * 60 * 60 * 1000; // 「看過」紀錄保留 48 小時
    const contentSelector = '.readcotent.bbb.font-normal';
    const nextLinkSelector = '#linkNext';

    /* ===== [修#2] 全腳本唯一的 URL 規範化 ===== */
    const norm = (u) => {
        try { return new URL(u, location.href).href.split('#')[0]; }
        catch (e) { return String(u || '').split('#')[0]; }
    };
    const here = norm(location.href);
    const bookId = (location.pathname.match(/^\/book\/([^/]+)/) || [])[1];
    if (!bookId) return;
    const sameBook = (u) => {
        try { return new URL(u, location.href).pathname.startsWith('/book/' + bookId + '/'); }
        catch (e) { return false; }
    };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    try {
        const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        if (w.self !== w.top) return;
    } catch (e) {}

    /* ===== 儲存結構
       uuVisited  {url: ts}                → 實際看過的章節（IO 偵測）
       uuProgress {bookId: {last,next,ts}} → 閱讀進度
       uuNextMap  {bookId: {from,to,ts}}   → 本頁「下一章」點擊跳轉目標 ===== */
    const getMap = (k) => { try { return GM_getValue(k, {}) || {}; } catch (e) { return {}; } };
    const putMap = (k, v) => { try { GM_setValue(k, v); } catch (e) {} };
    function trimVisited(m) {
        const keys = Object.keys(m);
        if (keys.length <= 300) return m;
        keys.sort((a, b) => m[a] - m[b]);
        for (const k of keys.slice(0, keys.length - 300)) delete m[k];
        return m;
    }

    /* ===== [修#1/#3] 落地跳轉：只跳「看過」的章節，回到上次進度 ===== */
    (function landingJump() {
        let jumpedTo = null;
        try { jumpedTo = sessionStorage.getItem('uuJumpedTo'); } catch (e) {}
        if (jumpedTo === here) {                    // 剛跳來的 → 不再連環跳
            try { sessionStorage.removeItem('uuJumpedTo'); } catch (e) {}
            return;
        }
        const visited = getMap('uuVisited');
        if (!visited[here] || Date.now() - visited[here] > VISIT_WINDOW) return;
        const prog = getMap('uuProgress')[bookId];
        if (!prog || !prog.last || !prog.next) return;
        if (norm(prog.last) === here) return;       // 這章正是你讀到最後的地方 → 直接讀
        const to = norm(prog.next);
        if (to === here || !sameBook(to)) return;   // [修#1] 同書校驗
        if (Date.now() - (prog.ts || 0) > VISIT_WINDOW) return;
        try { sessionStorage.setItem('uuJumpedTo', to); } catch (e) {}
        console.log('⏭️ 此章之前已看過，跳回上次進度:', to);
        location.replace(to);
    })();

    /* ===== 執行鎖 ===== */
    if (document.documentElement.hasAttribute('data-uu-preload')) return;
    document.documentElement.setAttribute('data-uu-preload', '1');

    /* ===== [修#7] 離開頁面時中止未完成請求 ===== */
    let aborted = false;
    const inflight = new Set();
    window.addEventListener('pagehide', () => {
        aborted = true;
        inflight.forEach(r => { try { r.abort && r.abort(); } catch (e) {} });
    });

    let continueUrl = null;
    let loading = false;

    /* ===== 導航面板 ===== */
    const style = document.createElement('style');
    style.textContent = `
      #uu-nav-panel{position:fixed;top:120px;right:16px;width:240px;max-height:70vh;
        background:rgba(28,28,34,.93);color:#eee;border-radius:8px;z-index:999999;
        box-shadow:0 2px 12px rgba(0,0,0,.45);font-size:13px;line-height:1.4;
        display:flex;flex-direction:column;overflow:hidden;font-family:sans-serif}
      #uu-nav-header{padding:8px 10px;cursor:move;background:rgba(62,62,74,.97);
        font-weight:bold;user-select:none;display:flex;justify-content:space-between}
      #uu-nav-toggle{cursor:pointer;padding:0 5px;font-weight:normal}
      #uu-nav-panel.collapsed #uu-nav-list,#uu-nav-panel.collapsed #uu-nav-more{display:none}
      #uu-nav-list{overflow-y:auto;margin:0;padding:4px 0;list-style:none;flex:1}
      #uu-nav-list::-webkit-scrollbar{width:6px}
      #uu-nav-list::-webkit-scrollbar-thumb{background:#555;border-radius:3px}
      #uu-nav-list li{padding:5px 10px;cursor:pointer;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis;color:#ccc}
      #uu-nav-list li:hover{background:rgba(255,255,255,.13);color:#fff}
      #uu-nav-list li.active{background:#4a6da7;color:#fff}
      #uu-nav-list li.next-batch{color:#7ec97e;border-top:1px dashed #666;margin-top:4px}
      #uu-nav-more{padding:7px 10px;text-align:center;cursor:pointer;
        background:rgba(62,62,74,.97);color:#9fd49f}
      #uu-nav-more:hover{background:rgba(85,85,100,1)}
      #uu-nav-more.busy{opacity:.5;cursor:wait}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'uu-nav-panel';
    panel.innerHTML = `
      <div id="uu-nav-header"><span>章節目錄</span><span id="uu-nav-toggle">–</span></div>
      <ul id="uu-nav-list"></ul>
      <div id="uu-nav-more">＋ 再預讀 10 章</div>`;
    document.body.appendChild(panel);

    const header = panel.querySelector('#uu-nav-header');
    const list = panel.querySelector('#uu-nav-list');
    const moreBtn = panel.querySelector('#uu-nav-more');
    const toggleBtn = panel.querySelector('#uu-nav-toggle');

    const savedPos = GM_getValue('uuPanelPos', null);
    if (savedPos && isFinite(savedPos.left) && isFinite(savedPos.top)) {
        panel.style.left = savedPos.left + 'px';
        panel.style.top = savedPos.top + 'px';
        panel.style.right = 'auto';
    }
    header.addEventListener('pointerdown', (e) => {
        if (e.target === toggleBtn) return;
        const rect = panel.getBoundingClientRect();
        const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
        const move = (ev) => {
            const left = Math.min(Math.max(ev.clientX - dx, 0), innerWidth - panel.offsetWidth);
            const top = Math.min(Math.max(ev.clientY - dy, 0), innerHeight - 80);
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
            panel.style.right = 'auto';
        };
        const up = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            GM_setValue('uuPanelPos', {
                left: parseInt(panel.style.left) || 0,
                top: parseInt(panel.style.top) || 0
            });
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        e.preventDefault();
    });
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.classList.toggle('collapsed');
        toggleBtn.textContent = panel.classList.contains('collapsed') ? '+' : '–';
    });

    const navItems = [];
    let nextBatchLi = null;
    function addNavItem(title, el) {
        const li = document.createElement('li');
        li.textContent = title;
        li.title = title;
        li.addEventListener('click', () => {
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        list.appendChild(li);
        navItems.push({ el, li });
    }
    function setNextBatchItem(url) {
        if (nextBatchLi) nextBatchLi.remove();
        if (!url) { nextBatchLi = null; return; }
        nextBatchLi = document.createElement('li');
        nextBatchLi.className = 'next-batch';
        nextBatchLi.textContent = '⏭ 下一批未讀章節';
        nextBatchLi.addEventListener('click', () => { location.href = url; });
        list.appendChild(nextBatchLi);
    }
    let ticking = false;
    function updateActive() {
        ticking = false;
        let active = null;
        for (const it of navItems) {
            if (it.el && it.el.getBoundingClientRect().top <= 150) active = it;
        }
        for (const it of navItems) it.li.classList.toggle('active', it === active);
    }
    window.addEventListener('scroll', () => {
        if (!ticking) { ticking = true; requestAnimationFrame(updateActive); }
    });

    /* ===== [修#3] 閱讀進度偵測：看過才算讀 ===== */
    let lastSeq = -1;
    let seqCounter = 0;
    const io = new IntersectionObserver((entries) => {
        for (const en of entries) {
            if (!en.isIntersecting) continue;
            const el = en.target;
            const url = el.dataset.uuUrl;
            if (!url) continue;
            const v = getMap('uuVisited');
            v[url] = Date.now();
            putMap('uuVisited', trimVisited(v));
            const next = el.dataset.uuNext;
            const seq = +(el.dataset.uuSeq || 0);
            if (next && seq > lastSeq) {           // 進度只前進不倒退
                lastSeq = seq;
                const p = getMap('uuProgress');
                p[bookId] = { last: url, next: norm(next), ts: Date.now() };
                putMap('uuProgress', p);
            }
        }
    }, { threshold: 0 });

    /* ===== [修#6] 先查後插，以規範化 URL 為唯一身分 ===== */
    const insertedKeys = new Set();
    function appendChapter(url, title, innerHTML, nextUrl) {
        const container = document.querySelector(contentSelector);
        if (!container) return false;
        const key = norm(url);
        if (key === here || insertedKeys.has(key)) return true;
        const div = document.createElement('div');
        div.className = 'uu-preload';
        div.dataset.key = key;
        div.dataset.uuUrl = key;
        div.dataset.uuNext = nextUrl ? norm(nextUrl) : '';
        div.dataset.uuSeq = String(++seqCounter);
        div.style.borderTop = '2px dashed #aaa';
        div.style.marginTop = '2em';
        div.innerHTML = '<h2></h2>' + innerHTML;
        div.querySelector('h2').textContent = title;
        container.appendChild(div);
        insertedKeys.add(key);
        io.observe(div);
        addNavItem(title, div);
        return true;
    }

    /* ===== [修#1] 每本書獨立跳轉紀錄 + from/to 校驗 ===== */
    function publishNext(to) {
        const m = getMap('uuNextMap');
        m[bookId] = { from: here, to: norm(to), ts: Date.now() };
        putMap('uuNextMap', m);
    }
    function clickJumpTarget() {
        const rec = getMap('uuNextMap')[bookId];
        if (!rec || !rec.to) return '';
        if (norm(rec.from) !== here) return '';    // 只信任本頁算出的值
        const to = norm(rec.to);
        if (to === here || !sameBook(to)) return '';
        return to;
    }

    /* ===== 抓取（含重試、節流、inflight 管理） ===== */
    function fetchOnce(url) {
        return new Promise((resolve) => {
            const req = GM_xmlhttpRequest({
                method: "GET", url: url,
                headers: { "Referer": location.href },
                timeout: 15000,
                onload: (r) => { inflight.delete(req); resolve(r); },
                onerror: () => { inflight.delete(req); resolve({ status: -1, responseText: null }); },
                ontimeout: () => { inflight.delete(req); resolve({ status: -2, responseText: null }); }
            });
            if (req) inflight.add(req);
        });
    }
    async function getPage(url) {
        for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
            const r = await fetchOnce(url);
            if (r.status === 200 && r.responseText) {
                if (/Just a moment|cf-browser-verification|Enable JavaScript/i.test(r.responseText)) {
                    console.warn(`🔒 第 ${attempt} 次收到 Cloudflare 驗證頁，等待重試...`);
                } else return r.responseText;
            } else {
                console.warn(`⚠️ 請求失敗 (HTTP ${r.status})，第 ${attempt}/${MAX_RETRY} 次重試:`, url);
            }
            if (attempt < MAX_RETRY) await sleep(attempt * 2000);
        }
        return null;
    }

    /* ===== [修#4] 以「已插入頁面」為準的終態發布 ===== */
    async function fetchNextChapters(startUrl, count) {
        const appended = new Set();
        let currentUrl = norm(startUrl);
        let nextAfterUrl = null;

        for (let i = 0; i < count; i++) {
            if (aborted) return;                   // [修#7]
            if (currentUrl === here || appended.has(currentUrl)) break;
            if (i > 0) await sleep(CHAPTER_DELAY);

            const html = await getPage(currentUrl);
            if (aborted) return;
            if (!html) break;                      // currentUrl 未載入 → 不在 appended

            const doc = new DOMParser().parseFromString(html, 'text/html');
            const content = doc.querySelector(contentSelector);
            const titleEl = doc.querySelector('h1');
            if (!content || !titleEl) { console.warn('⚠️ 找不到內容或標題，停止'); break; }

            const next = doc.querySelector(nextLinkSelector);
            const href = next && next.getAttribute('href');
            let nextUrl = '';
            if (href && href !== '#' && !/^javascript/i.test(href)) {
                const nu = norm(href);
                if (nu !== currentUrl && nu !== here) nextUrl = nu;  // 自指/回指防護
            }
            appendChapter(currentUrl, titleEl.innerText.trim(), content.innerHTML, nextUrl);
            appended.add(currentUrl);
            console.log('📖 已載入:', titleEl.innerText.trim());

            if (!nextUrl) { console.log('🚫 沒有更多章節'); break; }
            nextAfterUrl = nextUrl;
            currentUrl = nextUrl;
        }
        if (aborted) return;
        if (nextAfterUrl && !appended.has(nextAfterUrl)) {
            publishNext(nextAfterUrl);
            continueUrl = nextAfterUrl;
            setNextBatchItem(nextAfterUrl);
        } else {
            console.warn('⚠️ 預讀未完整結束，續讀點維持原值（可再按「再預讀」重試）');
        }
    }

    /* ===== [修#5 + 互斥鎖] 唯一的預讀入口：try/finally 保護 ===== */
    function setBusy(b) {
        moreBtn.classList.toggle('busy', b);
        moreBtn.textContent = b ? '⏳ 載入中...' : '＋ 再預讀 10 章';
    }
    async function runPreload(url, count) {
        if (loading || !url) return;
        loading = true;
        setBusy(true);
        try { await fetchNextChapters(url, count); }
        catch (err) { console.error('❌ 預讀流程異常:', err); }
        finally { loading = false; setBusy(false); updateActive(); }
    }
    moreBtn.addEventListener('click', () => runPreload(continueUrl, MAX_NEXT));

    /* ===== 攔截「下一章」點擊（只在有效目標時攔截） ===== */
    document.addEventListener('click', (e) => {
        const a = e.target.closest(nextLinkSelector);
        if (!a) return;
        const jump = clickJumpTarget();
        if (jump) {
            e.preventDefault();
            e.stopImmediatePropagation();
            location.href = jump;
        }
    }, true);

    function start() {
        const h1 = document.querySelector('h1');
        const nextLink = document.querySelector(nextLinkSelector);
        const href = nextLink && nextLink.getAttribute('href');
        if (h1) addNavItem(h1.innerText.trim(), h1);

        if (!href || href === '#' || /^javascript/i.test(href)) {
            console.warn('❌ 下一章連結無效'); return;
        }
        // 本頁自身章節納入進度偵測（seq = 0）
        const container = document.querySelector(contentSelector);
        if (container) {
            container.dataset.uuUrl = here;
            container.dataset.uuNext = norm(href);
            container.dataset.uuSeq = '0';
            io.observe(container);
        }
        continueUrl = norm(href);                  // [修#5] 先初始化：首輪失敗仍可重試
        setNextBatchItem(continueUrl);
        runPreload(continueUrl, MAX_NEXT);
    }
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
})();
