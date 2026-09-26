// ==UserScript==
// @name         UU看書自動預讀 10 章 (完備版)
// @namespace    https://github.com/jacky3213
// @version      2.3
// @updateURL    https://raw.githubusercontent.com/jacky3213/ToolWeb/main/public/apks/UU-preloader.user.js
// @downloadURL  https://raw.githubusercontent.com/jacky3213/ToolWeb/main/public/apks/UU-preloader.user.js
// @description  預讀10章、閱讀進度智慧跳轉、右側導航面板、防重複/節流/重試/中斷保護（支援 uukanshu.cc 與 twkan.com）
// @author       K7
// @match        https://uukanshu.cc/book/*/*
// @match        https://twkan.com/txt/*/*
// @match        https://www.twkan.com/txt/*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      uukanshu.cc
// @connect      twkan.com
// @connect      www.twkan.com
// @run-at       document-end
// @noframes
// ==/UserScript==
(function() {
    'use strict';

    const MAX_NEXT = 10;
    const CHAPTER_DELAY = 1000;
    const MAX_RETRY = 3;
    const VISIT_WINDOW = 48 * 60 * 60 * 1000; // 「看過」紀錄保留 48 小時

    /* ===== 站點配置：uukanshu.cc 與 twkan.com（69shu 家族模板） ===== */
    const SITES = {
        'uukanshu.cc': {
            bookIdRe: /^\/book\/([^/]+)/,
            bookPrefix: '/book/',
            contentSelector: '.readcotent.bbb.font-normal',
            titleSelector: 'h1',
            nextLinkSelector: '#linkNext',
            nextByText: true,                // [MINOR-F] 選擇器優先，落空時有文字後備
        },
        'twkan.com': {
            bookIdRe: /^\/txt\/([^/]+)/,
            bookPrefix: '/txt/',
            contentSelector: '#txtcontent0, #txtcontent',
            titleSelector: '.txtnav h1, #container .txtnav h1, h1',
            nextLinkSelector: null,          // 無固定 id → 以連結文字辨識
            nextByText: true,
        },
    };
    const SITE = SITES[location.hostname.replace(/^www\./, '')];
    if (!SITE) return;                       // 未列入配置的站點不執行
    const SITE_HOST = location.hostname.replace(/^www\./, '');

    // 取得「下一章」連結：選擇器站直接回傳；nextByText 站選擇器落空時，以 rel/class 為主、連結文字為輔
    function findNextLink(rootDoc) {
        const doc = rootDoc || document;
        if (SITE.nextLinkSelector) {
            const el = doc.querySelector(SITE.nextLinkSelector);
            if (el || !SITE.nextByText) return el;
        }
        const cands = [...doc.querySelectorAll('a[href]')].filter(a => {
            const h = a.getAttribute('href') || '';
            return !!h && h !== '#' && !/^javascript:/i.test(h);
        });
        // 1) 語意化優先：rel="next" 或 class 含 next
        const byRel = cands.find(a =>
            /(^|\s)next(\s|$)/i.test(a.getAttribute('rel') || '') ||
            /(^|\s)(next|nextchapter|next-chapter)(\s|$)/i.test(a.className || ''));
        if (byRel) return byRel;
        // 2) 後備：連結文字比對（去空白，避免「下 一章」或 <span> 分隔漏判）
        return cands.find(a => /下一[章頁页节]/.test((a.textContent || '').replace(/\s+/g, ''))) || null;
    }

    /* ===== [修#2] 全腳本唯一的 URL 規範化（base 可指定被抓取頁的 URL） ===== */
    const norm = (u, base) => {
        try { return new URL(u, base || location.href).href.split('#')[0]; }
        catch (e) { return String(u || '').split('#')[0]; }
    };
    const here = norm(location.href);
    const bookId = (location.pathname.match(SITE.bookIdRe) || [])[1];
    if (!bookId) return;
    // 儲存鍵以站點為命名空間，避免兩站相同數字 bookId 互相覆蓋進度
    const bookKey = location.hostname.replace(/^www\./, '') + ':' + bookId;
    const sameBook = (u) => {
        try {
            // 必須是「同站的同書章節頁」：host 相符、前綴符合、且 id 後有非空章節段（排除目錄頁）
            const x = new URL(u, location.href);
            if (x.hostname.replace(/^www\./, '') !== SITE_HOST) return false;   // [m-7]
            const p = x.pathname;
            const prefix = SITE.bookPrefix + bookId + '/';
            if (!p.startsWith(prefix)) return false;
            return p.slice(prefix.length).replace(/\/+$/, '').length > 0;
        } catch (e) { return false; }
    };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    try {
        const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        if (w.self !== w.top) return;
    } catch (e) {}

    /* ===== 儲存結構
       uuVisited  {url: ts}                     → 實際看過的章節（IO 偵測，完整 URL 為鍵）
       uuProgress {host:bookId: {last,next,ts}} → 閱讀進度（站點命名空間，跨站不互覆）
       uuNextMap  {host:bookId: {from,to,ts}}   → 本頁「下一章」點擊跳轉目標 ===== */
    const getMap = (k) => { try { return GM_getValue(k, {}) || {}; } catch (e) { return {}; } };
    const putMap = (k, v) => { try { GM_setValue(k, v); } catch (e) {} };
    // [m-3 遷移] 舊版以裸 bookId 為鍵，升級後遷移到 host:bookId 命名空間（一次性、只在有舊鍵時寫入）
    (function migrateStore() {
        for (const k of ['uuProgress', 'uuNextMap']) {
            const m = getMap(k);
            if (!(bookId in m)) continue;
            if (!m[bookKey]) m[bookKey] = m[bookId];
            delete m[bookId];
            putMap(k, m);
        }
    })();
    // [m-7] host 無關比較（twkan.com ↔ www.twkan.com 重定向不破壞連環跳保護）
    const hostAgnostic = (u) => {
        try { const x = new URL(u, location.href); return x.hostname.replace(/^www\./, '') + x.pathname; }
        catch (e) { return String(u || ''); }
    };
    function trimVisited(m) {
        const keys = Object.keys(m);
        if (keys.length <= 300) return m;
        keys.sort((a, b) => m[a] - m[b]);
        for (const k of keys.slice(0, keys.length - 300)) delete m[k];
        return m;
    }

    /* ===== [修#1/#3] 落地跳轉：只跳「看過」的章節，回到上次進度 =====
       回傳 true 表示已發起跳轉，主流程應中止後續初始化 */
    const jumped = (function landingJump() {
        let jumpedTo = null;
        try { jumpedTo = sessionStorage.getItem('uuJumpedTo'); } catch (e) {}
        if (jumpedTo && hostAgnostic(jumpedTo) === hostAgnostic(here)) {  // 剛跳來的 → 不再連環跳
            try { sessionStorage.removeItem('uuJumpedTo'); } catch (e) {}
            return false;
        }
        const visited = getMap('uuVisited');
        if (!visited[here] || Date.now() - visited[here] > VISIT_WINDOW) return false;
        const prog = getMap('uuProgress')[bookKey];
        if (!prog || !prog.last || !prog.next) return false;
        // [MINOR-B] 只在「來源正是上次讀到的那一章」時視為回讀不跳（上一章導覽）；
        // 從目錄頁點已讀章節仍會正常跳回進度點，主功能不受影響
        try { if (document.referrer && hostAgnostic(document.referrer) === hostAgnostic(prog.last)) return false; } catch (e) {}
        if (hostAgnostic(prog.last) === hostAgnostic(here)) return false;   // 這章正是你讀到最後的地方 → 直接讀
        const to = norm(prog.next);
        if (to === here || !sameBook(to)) return false;   // [修#1] 同書校驗
        if (Date.now() - (prog.ts || 0) > VISIT_WINDOW) return false;
        try { sessionStorage.setItem('uuJumpedTo', to); } catch (e) {}
        console.log('⏭️ 此章之前已看過，跳回上次進度:', to);
        location.replace(to);
        return true;
    })();
    if (jumped) return;                        // 已跳轉 → 不建面板、不觸發預讀

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
        if (toggleBtn.contains(e.target)) return;
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
                p[bookKey] = { last: url, next: norm(next), ts: Date.now() };
                putMap('uuProgress', p);
            }
        }
    }, { threshold: 0 });

    /* ===== [修#6] 先查後插，以規範化 URL 為唯一身分 ===== */
    const insertedKeys = new Set();
    // [m-5] 注入前清洗遠端 HTML：移除危險節點、on* 內聯事件與重複 id（避免干擾站方 JS 與本腳本查詢）
    function sanitizeContent(el) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('script, style, link, iframe, object, embed, form, meta').forEach(n => n.remove());
        clone.querySelectorAll('*').forEach(n => {
            [...n.attributes].forEach(attr => {
                const name = attr.name.toLowerCase();
                if (name.startsWith('on') || name === 'srcdoc') { n.removeAttribute(attr.name); return; }
                if (name === 'href' || name === 'src' || name === 'xlink:href') {
                    // [MINOR-D] 先去除 tab/換行（可繞過 scheme 檢查），僅擋腳本類與 data:text/html，保留 base64 圖片
                    const v = String(attr.value || '').replace(/[\t\n\r]/g, '');
                    if (/^\s*(javascript|vbscript):/i.test(v) || /^\s*data:text\/html/i.test(v)) n.removeAttribute(attr.name);
                }
            });
            if (n.hasAttribute('id')) n.removeAttribute('id');
        });
        return clone.innerHTML;
    }
    function appendChapter(url, title, innerHTML, nextUrl) {
        const container = document.querySelector(SITE.contentSelector);
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
        m[bookKey] = { from: here, to: norm(to), ts: Date.now() };
        putMap('uuNextMap', m);
    }
    function clickJumpTarget() {
        const rec = getMap('uuNextMap')[bookKey];
        if (!rec || !rec.to) return '';
        if (Date.now() - (rec.ts || 0) > VISIT_WINDOW) return '';  // [m-2] 過期紀錄不採用
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
        let reachedEnd = false;

        for (let i = 0; i < count; i++) {
            if (aborted) return;                   // [修#7]
            if (currentUrl === here || appended.has(currentUrl)) break;
            if (i > 0) await sleep(CHAPTER_DELAY);

            const html = await getPage(currentUrl);
            if (aborted) return;
            if (!html) break;                      // currentUrl 未載入 → 不在 appended

            const doc = new DOMParser().parseFromString(html, 'text/html');
            const content = doc.querySelector(SITE.contentSelector);
            const titleEl = doc.querySelector(SITE.titleSelector);
            const title = (titleEl ? (titleEl.textContent || '') : '').trim()
                || (doc.title || '').trim();
            if (!content || !title) { console.warn('⚠️ 找不到內容或標題，停止'); break; }

            const next = findNextLink(doc);
            const href = next && next.getAttribute('href');
            let nextUrl = '';
            if (href && href !== '#' && !/^javascript/i.test(href)) {
                const nu = norm(href, currentUrl);                  // 以被抓取頁為 base 解析相對路徑
                if (nu !== currentUrl && nu !== here && sameBook(nu)) nextUrl = nu;  // 自指/回指/跨書防護
            }
            appendChapter(currentUrl, title, sanitizeContent(content), nextUrl);
            appended.add(currentUrl);
            console.log('📖 已載入:', title);

            if (!nextUrl) { console.log('🚫 沒有更多章節'); reachedEnd = true; nextAfterUrl = null; break; }
            nextAfterUrl = nextUrl;
            currentUrl = nextUrl;
        }
        if (aborted) return;
        if (nextAfterUrl && !appended.has(nextAfterUrl)) {
            publishNext(nextAfterUrl);
            continueUrl = nextAfterUrl;
            setNextBatchItem(nextAfterUrl);
        } else if (reachedEnd) {
            // [MINOR-A] 正常讀到書末：清掉續讀點，避免「再預讀」重抓同一批
            continueUrl = null;
            setNextBatchItem(null);
            console.log('✅ 已到書末');
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
    function isNextLinkClick(e) {
        // 修飾鍵點擊（新分頁/新視窗）不攔截，只處理普通左鍵
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
        const t = e.target instanceof Element ? e.target : null;
        if (!t) return false;
        const a = t.closest('a[href]');
        if (!a) return false;
        const live = findNextLink(document);
        if (!live) return false;
        if (live === a || live.contains(a)) return true;
        // [MAJOR-1] 解析後 href 相同也視為下一章——twkan 等站有上下兩組導航列指向同一目標，
        // 只按節點身分攔截會漏掉另一組；比對 href 則兩組都攔，且不會誤攔目錄分頁等其他連結
        const lh = live.getAttribute('href');
        const ah = a.getAttribute('href');
        return !!lh && !!ah && norm(lh) === norm(ah);
    }
    document.addEventListener('click', (e) => {
        if (!isNextLinkClick(e)) return;
        const jump = clickJumpTarget();
        if (jump) {
            e.preventDefault();
            e.stopImmediatePropagation();
            location.href = jump;
        }
    }, true);

    function start() {
        const titleEl = document.querySelector(SITE.titleSelector);
        const nextLink = findNextLink(document);
        const href = nextLink && nextLink.getAttribute('href');
        if (titleEl) addNavItem((titleEl.textContent || '').trim(), titleEl);

        if (!href || href === '#' || /^javascript/i.test(href)) {
            console.warn('❌ 下一章連結無效'); return;
        }
        // 本頁自身章節納入進度偵測（seq = 0）
        const container = document.querySelector(SITE.contentSelector);
        if (container) {
            container.dataset.uuUrl = here;
            container.dataset.uuNext = norm(href);
            container.dataset.uuSeq = '0';
            io.observe(container);
        }
        // [m-1] 書末章的「下一章」常指向目錄頁 → 不設續讀點，避免首輪去抓目錄
        const cu = norm(href);
        if (!sameBook(cu)) { console.log('🚫 下一章連結非同書章節（可能已是最後一章）'); return; }
        continueUrl = cu;                          // [修#5] 先初始化：首輪失敗仍可重試
        setNextBatchItem(continueUrl);
        runPreload(continueUrl, MAX_NEXT);
    }
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
})();
