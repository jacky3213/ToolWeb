// ==UserScript==
// @name         小說預讀器 (Novel Preloader)
// @namespace    https://github.com/jacky3213
// @version      3.6
// @updateURL    https://raw.githubusercontent.com/jacky3213/ToolWeb/main/public/apks/UU-preloader.user.js
// @downloadURL  https://raw.githubusercontent.com/jacky3213/ToolWeb/main/public/apks/UU-preloader.user.js
// @description  預讀章數可調（5–30）、無縫滾動連載、閱讀模式（夜間/字級/行距）、鍵盤快捷鍵（←/→/P）、進度智慧跳轉、右側導航面板（支援 uukanshu.cc、twkan.com 及 69shu 家族鏡像站自動偵測；@connect * 僅用於同站章節抓取）
// @author       K7
// @match        https://uukanshu.cc/book/*/*
// @match        https://twkan.com/txt/*/*
// @match        https://www.twkan.com/txt/*/*
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      uukanshu.cc
// @connect      twkan.com
// @connect      www.twkan.com
// @connect      *
// @run-at       document-end
// @noframes
// ==/UserScript==
(function() {
    'use strict';

    const CHAPTER_DELAY = 1000;
    const MAX_RETRY = 3;
    const VISIT_WINDOW = 48 * 60 * 60 * 1000; // 「看過」紀錄保留 48 小時
    // [#1 m-2] preloadCount 區塊移至 SITE 判定之後：非小說頁 early-exit 前不做任何 GM 存取

    /* ===== 站點配置：uukanshu.cc 與 twkan.com（69shu 家族模板） ===== */
    const SITES = {
        'uukanshu.cc': {
            bookIdRe: /^\/book\/(\d+)/,      // [#6 m-1] 收緊為數字：/book/search 等非章節路徑不再被當成書
            bookPrefix: '/book/',
            contentSelector: '.readcotent.bbb.font-normal',
            titleSelector: 'h1',
            nextLinkSelector: '#linkNext',
            nextByText: true,                // [MINOR-F] 選擇器優先，落空時有文字後備
        },
        'twkan.com': {
            bookIdRe: /^\/txt\/(\d+)/,       // [#6 m-1] 同上
            bookPrefix: '/txt/',
            contentSelector: '#txtcontent0, #txtcontent',
            titleSelector: '.txtnav h1, #container .txtnav h1, h1',
            nextLinkSelector: null,          // 無固定 id → 以連結文字辨識
            nextByText: true,
        },
    };
    /* ===== [#6] 泛模板支援：69shu 家族特徵選擇器 =====
       這些選擇器（.readcotent*、#txtcontent*、#linkNext、.txtnav）具高獨特性，
       配合章節頁 URL 型態（/:prefix/:數字書id/:數字章id）雙重驗證，不會誤中一般網站。
       [S2] 由 SITES 派生，站點配置更新時自動同步，不會脫節 */
    const pickCfg = (c) => ({ contentSelector: c.contentSelector, titleSelector: c.titleSelector, nextLinkSelector: c.nextLinkSelector, nextByText: c.nextByText });
    const TEMPLATES = [
        { name: '69shu-A(uukanshu)', ...pickCfg(SITES['uukanshu.cc']) },
        { name: '69shu-B(twkan)', ...pickCfg(SITES['twkan.com']) },
    ];
    const hostname = location.hostname.replace(/^www\./, '');
    let SITE = SITES[hostname] || null;
    if (!SITE) {
        // [#6 m-8] 先驗 URL 型態（純字串，零 DOM 成本），再探測 DOM 特徵
        // [整合 M6] 前綴放寬為 [a-z0-9_-]（涵蓋 /69shu/、/1_1234/ 等 69shu 家族常見前綴）
        const m = location.pathname.match(/^\/([a-z0-9_-]{2,20})\/(\d+)\/(\d+)(?:\.html?)?\/?$/i);
        if (m) {
            // [#6 M2/m9] 探測加可讀性門檻：逗號列表逐個驗證；排除空殼/模板節點與隱藏容器
            const probe = (sel) => {
                for (const s of sel.split(',')) {
                    const el = document.querySelector(s.trim());
                    if (!el) continue;
                    if ((el.textContent || '').replace(/\s+/g, '').length < 200) continue;
                    const r = el.getBoundingClientRect();
                    if (!r.width || !r.height) continue;
                    if (el.checkVisibility && !el.checkVisibility()) continue;   // [#6 m-3] 涵蓋 visibility/opacity/離屏
                    return el;
                }
                return null;
            };
            const tpl = TEMPLATES.find(t => probe(t.contentSelector));
            if (tpl) {
                SITE = {
                    bookIdRe: /^\/[a-z0-9_-]{2,20}\/(\d+)\//i,   // [m-3] 靜態正則，bookId 為捕獲組 1，無執行期拼接
                    bookPrefix: '/' + m[1] + '/',
                    contentSelector: tpl.contentSelector,
                    titleSelector: tpl.titleSelector,
                    nextLinkSelector: tpl.nextLinkSelector,
                    nextByText: tpl.nextByText,
                };
                console.log('🔎 [小說預讀器] 偵測到 ' + tpl.name + ' 家族模板，啟用於 ' + hostname);
            }
        }
    }
    if (!SITE) return;                       // 非已知站點且特徵不符 → 完全不介入
    const SITE_HOST = hostname;

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
        // [v3.4] 放寬手機站常見變體：下章/下頁、英文 Next / Next Chapter/Page
        const txt = (a) => (a.textContent || '').replace(/\s+/g, '');
        return cands.find(a => /下一[章頁页节]/.test(txt(a)))
            || cands.find(a => /^下[章页頁]$/.test(txt(a)))
            || cands.find(a => /^next(\s*(chapter|page|→|»))?$/i.test(txt(a)))
            || null;
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
            if (x.protocol !== location.protocol || (x.port || '') !== (location.port || '')) return false;   // [#6 m-2] 縱深防禦：協議/埠也須一致
            const p = x.pathname;
            const prefix = SITE.bookPrefix + bookId + '/';
            if (!p.toLowerCase().startsWith(prefix.toLowerCase())) return false;   // [#6 m-4] 前綴比較大小寫無關（/i 正則可捕獲 /TXT/）
            return p.slice(prefix.length).replace(/\/+$/, '').length > 0;
        } catch (e) { return false; }
    };

    /* ===== [#1] 預讀章數可調（5–30），GM 持久化（[#6 m-2/m-1] 移至 SITE 判定後：非小說頁零 GM 存取） ===== */
    const MIN_PRELOAD = 5;
    const MAX_PRELOAD = 30;
    const DEFAULT_PRELOAD = 10;
    let preloadCount = (() => {
        try {
            const n = parseInt(GM_getValue('uuPreloadCount', DEFAULT_PRELOAD), 10);
            if (!Number.isFinite(n)) return DEFAULT_PRELOAD;
            const clamped = Math.min(MAX_PRELOAD, Math.max(MIN_PRELOAD, n));
            if (clamped !== n) { try { GM_setValue('uuPreloadCount', clamped); } catch (e) {} }   // [s-3] 歷史異常值一次性歸一
            return clamped;
        } catch (e) { return DEFAULT_PRELOAD; }                                                   // [M-1] GM 異常不滅頂
    })();
    const setPreloadCount = (n) => {
        preloadCount = Math.min(MAX_PRELOAD, Math.max(MIN_PRELOAD, n | 0));
        try { GM_setValue('uuPreloadCount', preloadCount); } catch (e) { console.warn('⚠️ 預讀章數無法持久化:', e); }   // [s-2]
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
            if (!Object.prototype.hasOwnProperty.call(m, bookId)) continue;   // [#6 m-7] 不走原型鏈（__proto__ 等鍵）
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
        // [整合 M2] 瀏覽器返回（back_forward）＝使用者明確回讀，一律不彈回進度點
        try {
            const nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')) || [];
            if (nav[0] && nav[0].type === 'back_forward') return false;
        } catch (e) {}
        // [v3.3] 站內刻意導航（← 上一章／頁面「上一章」連結）一律不彈回進度點。
        // 舊規則只比對 referrer === prog.last，但 ← 導航的 referrer 是「當前章」，
        // 且部分小說站設 no-referrer 時 referrer 為空，導致回讀被彈回最新預讀章。
        try {
            const bn = sessionStorage.getItem('uuBackNav');
            if (bn && hostAgnostic(bn) === hostAgnostic(here)) { sessionStorage.removeItem('uuBackNav'); return false; }
        } catch (e) {}
        try { if (document.referrer && sameBook(document.referrer)) return false; } catch (e) {}
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
    // [#2 m-3] pagehide/pageshow 註冊移至 io2 定義之後，避免 const TDZ 風險

    let continueUrl = null;
    let loading = false;
    let bookEnded = false;                     // [#1 m-3] 書末狀態：moreBtn 顯示終態而非再預讀
    let lastBatchAppended = 0;                 // [#2 M-1] 上批實際插入章數（0 = 無進度，不自動接力）
    let lastBatchFailed = false;               // [整合 m4] 上批失敗旗標：失敗提示不被 renderCount 覆寫
    let blockReason = '';                      // [v3.4] 無法預讀的原因（面板可見；手機看不到 console）
    let lastFetchNote = '';                    // [v3.5] 上批抓取失敗的具體原因（顯示在重試按鈕上）

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
      #uu-nav-panel.collapsed #uu-nav-list,#uu-nav-panel.collapsed #uu-nav-more,#uu-nav-panel.collapsed #uu-nav-count{display:none}
      #uu-nav-list{overflow-y:auto;margin:0;padding:4px 0;list-style:none;flex:1}
      #uu-nav-list::-webkit-scrollbar{width:6px}
      #uu-nav-list::-webkit-scrollbar-thumb{background:#555;border-radius:3px}
      #uu-nav-list li{padding:5px 10px;cursor:pointer;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis;color:#ccc}
      #uu-nav-list li:hover{background:rgba(255,255,255,.13);color:#fff}
      #uu-nav-list li.active{background:#4a6da7;color:#fff}
      #uu-nav-list li.next-batch{color:#7ec97e;border-top:1px dashed #666;margin-top:4px}
      #uu-nav-more{display:block;width:100%;border:0;font:inherit;padding:7px 10px;
        text-align:center;cursor:pointer;background:rgba(62,62,74,.97);color:#9fd49f}
      #uu-nav-more:hover{background:rgba(85,85,100,1)}
      #uu-nav-more:disabled{pointer-events:none;opacity:.6}   /* [MAJOR-1] div→button 後 disabled 真正生效 */
      /* [#1] 預讀章數控制列 */
      #uu-nav-count{display:flex;align-items:center;justify-content:center;gap:14px;
        padding:5px 10px;background:rgba(45,45,55,.97);font-size:12px;color:#bbb}
      #uu-nav-count button{background:none;border:1px solid #666;border-radius:4px;
        color:#ddd;width:22px;height:22px;line-height:1;cursor:pointer;font-size:14px;
        display:inline-flex;align-items:center;justify-content:center;padding:0}
      #uu-nav-count button:hover{background:rgba(255,255,255,.15);color:#fff}
      #uu-nav-count button:disabled{opacity:.35;cursor:not-allowed}
      #uu-count-val{min-width:56px;text-align:center;user-select:none}
      /* [#7] 閱讀模式控制列 */
      #uu-nav-reading{display:flex;align-items:center;justify-content:center;gap:8px;
        padding:5px 10px;background:rgba(40,40,50,.97);font-size:12px;color:#bbb}
      #uu-nav-reading button{background:none;border:1px solid #666;border-radius:4px;
        color:#ddd;height:22px;line-height:1;cursor:pointer;font-size:12px;
        display:inline-flex;align-items:center;justify-content:center;padding:0 8px}
      #uu-nav-reading button:hover:not(.on){background:rgba(255,255,255,.15);color:#fff}   /* [#7 m5] 開啟態 hover 仍有回饋 */
      #uu-nav-reading button.on{background:#4a6da7;border-color:#4a6da7;color:#fff}
      #uu-nav-panel.collapsed #uu-nav-reading{display:none}
      /* [#7] 夜間模式：僅作用於正文容器與 .uu-preload 注入段。
         [C1] contentSelector 可能含逗號（#txtcontent0, #txtcontent），逗號是最低優先運算符，
         必須逐段補 html.uu-night 前綴，否則右半邊會變成無條件的全域規則（日間也生效） */
      html.uu-night body{background:#16161c !important;color:#c9c9d4 !important}
      html.uu-night ${SITE.contentSelector.split(',').map(s => 'html.uu-night ' + s.trim()).join(',')}{background:#16161c !important;color:#c9c9d4 !important}
      /* [v3.1] 站方常把白底設在正文外層的包裝容器上（#chaptercontent/.container 等），
         只調 body 會變成「外面黑、正文區塊仍白」。applyReading() 會把正文祖先鏈標記
         .uu-night-anc，這裡用 background 簡寫（連背景圖/漸層一併覆蓋）調黑整條鏈 */
      html.uu-night .uu-night-anc{background:#16161c !important;color:#c9c9d4 !important;border-color:#2a2a33 !important}
      html.uu-night ${SITE.contentSelector.split(',').map(s => 'html.uu-night ' + s.trim()).join(',')} *:not(img):not(video):not(a):not(a *){color:#c9c9d4 !important;background-color:transparent !important;border-color:#2a2a33 !important;box-shadow:none !important;text-shadow:none !important}   /* [M2/MAJOR-1] a 及其後代自 * 規則豁免，連結色才會生效 */
      html.uu-night ${SITE.contentSelector.split(',').map(s => 'html.uu-night ' + s.trim()).join(',')} a{color:#7fb3ff !important}   /* [M2] 連結色 */
      html.uu-night ${SITE.contentSelector.split(',').map(s => 'html.uu-night ' + s.trim()).join(',')} .uu-preload{border-top-color:#555 !important}          /* [M5] inline 邊框被 * 規則蓋掉，補回章節分隔線（含 nightSel 提升特異度） */
      html.uu-night ${SITE.contentSelector.split(',').map(s => 'html.uu-night ' + s.trim()).join(',')} .uu-preload h2{color:#eaeaf2 !important}               /* [M5] 預讀章標題與正文區隔 */
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'uu-nav-panel';
    panel.innerHTML = `
      <div id="uu-nav-header"><span>章節目錄</span><span id="uu-nav-toggle">–</span></div>
      <div id="uu-nav-reading">
        <button id="uu-read-night" title="夜間模式">🌙</button>
        <button id="uu-read-fz-dec" title="縮小字級">A−</button>
        <button id="uu-read-fz-inc" title="放大字級">A＋</button>
        <button id="uu-read-lh" title="切換行距（依網站 → 1.6 → 1.9 → 2.2 循環）">行距</button>
      </div>
      <div id="uu-nav-count">
        <button id="uu-count-dec" title="減少預讀章數">−</button>
        <span id="uu-count-val"></span>
        <button id="uu-count-inc" title="增加預讀章數">＋</button>
      </div>
      <ul id="uu-nav-list"></ul>
      <button id="uu-nav-more"></button>`;
    document.body.appendChild(panel);

    const header = panel.querySelector('#uu-nav-header');
    const list = panel.querySelector('#uu-nav-list');
    const moreBtn = panel.querySelector('#uu-nav-more');
    const toggleBtn = panel.querySelector('#uu-nav-toggle');
    const countDecBtn = panel.querySelector('#uu-count-dec');
    const countIncBtn = panel.querySelector('#uu-count-inc');
    const countVal = panel.querySelector('#uu-count-val');
    const nightBtn = panel.querySelector('#uu-read-night');      // [#7]
    const fzDecBtn = panel.querySelector('#uu-read-fz-dec');     // [#7]
    const fzIncBtn = panel.querySelector('#uu-read-fz-inc');     // [#7]
    const lhBtn = panel.querySelector('#uu-read-lh');            // [#7]

    /* ===== [整合 MAJOR-2] moreBtn 渲染權威集中在 renderCount：
       disabled/文案由 continueUrl、bookEnded、loading、lastBatchFailed 四態唯一決定，
       杜絕「可點但無反應」的死按鈕與多處寫入互相覆蓋 ===== */
    function setBusy(b) { renderCount(); }
    function renderCount() {
        if (!countVal || !countDecBtn || !countIncBtn || !moreBtn) return;   // [m-3b] 完整空引用守衛
        countVal.textContent = preloadCount + ' 章';
        countDecBtn.disabled = loading || preloadCount <= MIN_PRELOAD;   // [s-1] 載入中鎖定，避免「數字變了但本批不變」誤導
        countIncBtn.disabled = loading || preloadCount >= MAX_PRELOAD;
        const canMore = !!continueUrl && !bookEnded;
        moreBtn.disabled = loading || !canMore;
        moreBtn.textContent = loading ? '⏳ 載入中...'
            : bookEnded ? '✅ 已到書末'
            : blockReason ? blockReason
            : !continueUrl ? '— 無更多章節'
            : (lastBatchFailed ? ('⚠️ 預讀失敗' + (lastFetchNote ? '：' + lastFetchNote : '') + '，點此重試') : '＋ 再預讀 ' + preloadCount + ' 章');
    }
    countDecBtn.addEventListener('click', () => { setPreloadCount(preloadCount - 1); renderCount(); });
    countIncBtn.addEventListener('click', () => { setPreloadCount(preloadCount + 1); renderCount(); });
    renderCount();

    /* ===== [#7] 閱讀模式：夜間 / 字級 / 行距（GM 持久化） ===== */
    const FZ_MIN = 14, FZ_MAX = 26;
    const LH_CYCLE = [0, 1.6, 1.9, 2.2];       // 0 = 跟隨網站
    // [M4] 載入路徑與點擊路徑同一套淨化：型別污染/越界值一律歸位（"false" 真值陷阱、9999px、"1.6" 行距截斷等）
    const readCfg = (() => {
        const d = { night: false, fz: 0, lh: 0 };
        try { Object.assign(d, GM_getValue('uuReading', {}) || {}); } catch (e) {}
        const numOr = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
        d.night = d.night === true || d.night === 'true';
        d.fz = Math.min(FZ_MAX, Math.max(0, Math.round(numOr(d.fz, 0))));
        const lh = numOr(d.lh, 0);
        d.lh = LH_CYCLE.includes(lh) ? lh : 0;
        return d;
    })();
    const readingStyle = document.createElement('style');
    document.head.appendChild(readingStyle);
    function applyReading() {
        document.documentElement.classList.toggle('uu-night', !!readCfg.night);
        // [v3.1] 夜間模式：把正文元素的祖先鏈（到 body 為止）標記 .uu-night-anc，
        // 讓包裝容器（#chaptercontent/.container 等）也一併調黑；關閉時移除所有標記。
        // 每次切換都重算，避免 SPA 重建 DOM 後標記殘留或失效。
        document.querySelectorAll('.uu-night-anc').forEach(el => el.classList.remove('uu-night-anc'));
        if (readCfg.night) {
            let el = null;
            try { el = document.querySelector(SITE.contentSelector); } catch (e) {}
            while (el && el !== document.body) {
                el.classList.add('uu-night-anc');
                el = el.parentElement;
            }
        }
        let css = '';
        if (readCfg.fz > 0) css += SITE.contentSelector + '{font-size:' + readCfg.fz + 'px !important;}';
        if (readCfg.lh > 0) css += SITE.contentSelector + '{line-height:' + readCfg.lh + ' !important;}';
        readingStyle.textContent = css;
        // [m1] 按鈕引用可能為 null（面板 DOM 變動時不拖垮預讀主流程）
        if (nightBtn) nightBtn.classList.toggle('on', !!readCfg.night);
        if (lhBtn) {
            lhBtn.textContent = readCfg.lh > 0 ? '行距 ' + readCfg.lh : '行距 跟隨';   // [m6]
            lhBtn.classList.toggle('on', readCfg.lh > 0);
        }
        const fzLabel = readCfg.fz > 0 ? readCfg.fz + 'px' : '跟隨網站';
        if (fzDecBtn) fzDecBtn.title = '縮小字級（目前 ' + fzLabel + '；最小時再按一次回到跟隨網站）';   // [m4]
        if (fzIncBtn) fzIncBtn.title = '放大字級（目前 ' + fzLabel + '）';
    }
    function saveReading() { try { GM_setValue('uuReading', readCfg); } catch (e) { console.warn('⚠️ 閱讀模式設定無法持久化:', e); } }
    function baseFontSize() {
        const el = document.querySelector(SITE.contentSelector);
        const px = el ? parseFloat(getComputedStyle(el).fontSize) : NaN;
        return Number.isFinite(px) ? Math.round(px) : 18;   // [MINOR-1] 回傳未夾限原值，方向反轉由呼叫端處理
    }
    // [m1] 面板按鈕引用不齊全時跳過事件綁定（applyReading 仍執行，夜間/字級設定照常生效）
    if (nightBtn && fzDecBtn && fzIncBtn && lhBtn) {
        nightBtn.addEventListener('click', () => { readCfg.night = !readCfg.night; saveReading(); applyReading(); });
        fzDecBtn.addEventListener('click', () => {
            if (readCfg.fz > 0) readCfg.fz = readCfg.fz <= FZ_MIN ? 0 : readCfg.fz - 1;   // [m4] 最小值再按一次＝回到跟隨網站
            else { const raw = baseFontSize(); if (raw > FZ_MIN) readCfg.fz = Math.max(FZ_MIN, raw - 1); }   // [MINOR-1/2] 站方已 ≤ 下限：no-op 不反轉
            saveReading(); applyReading();
        });
        fzIncBtn.addEventListener('click', () => {
            if (readCfg.fz > 0) readCfg.fz = Math.min(FZ_MAX, readCfg.fz + 1);
            else { const raw = baseFontSize(); if (raw < FZ_MAX) readCfg.fz = Math.min(FZ_MAX, raw + 1); }   // [MINOR-1] 站方已 ≥ 上限：no-op 不反轉
            saveReading(); applyReading();
        });
        lhBtn.addEventListener('click', () => {
            const i = LH_CYCLE.indexOf(readCfg.lh);
            readCfg.lh = LH_CYCLE[(i + 1) % LH_CYCLE.length];
            saveReading(); applyReading();
        });
    }
    applyReading();

    const savedPos = (() => { try { return GM_getValue('uuPanelPos', null); } catch (e) { return null; } })();   // [#2 m-3] 包 try 與其他 GM 存取一致
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
            try { GM_setValue('uuPanelPos', {                      // [MINOR-4] 與其他 GM 寫入一致包 try
                left: parseInt(panel.style.left) || 0,
                top: parseInt(panel.style.top) || 0
            }); } catch (e) {}
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
    // [整合 M5] 事件委派：面板 li 不再各自掛監聽器（數百章時監聽器數量失控）
    list.addEventListener('click', (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        const it = navItems.find(n => n.li === li);
        if (it && it.el) { kbdArm(it.el); it.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }   // [v3.3] 目錄點擊同樣鎖幾何回寫
    });
    function addNavItem(title, el) {
        const li = document.createElement('li');
        li.textContent = title;
        li.title = title;
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
    let activeIdx = -1;                        // [#4] 目前閱讀位置在 navItems 中的索引
    let kbdScrollLock = 0;                     // [#4 M-1] 程式發起平滑捲動期間，updateActive 不覆寫 activeIdx
    let kbdTargetTop = null;                   // [v3.3] 本次程式捲動的目標 Y 座標
    // [v3.3] 舊版固定鎖 900ms：長距離平滑捲動常超過 900ms，鎖過期後 updateActive 依當前幾何重算，
    // 捲動初期命中「已滾到底＝視為末章」規則，activeIdx 被彈回最新預讀章 → 連按 ← 永遠爬不上去。
    // 改為：未抵達目標（誤差 >60px）前持續鎖定（上限 2s 後備），抵達即解鎖正常計算。
    function kbdArm(el) {
        try { kbdTargetTop = el.getBoundingClientRect().top + window.scrollY; }
        catch (e) { kbdTargetTop = null; }
        kbdScrollLock = Date.now() + 2000;
    }
    function kbdLocked() {
        if (Date.now() >= kbdScrollLock) { kbdTargetTop = null; return false; }
        if (kbdTargetTop !== null && Math.abs(window.scrollY - kbdTargetTop) < 60) {
            kbdScrollLock = 0; kbdTargetTop = null; return false;   // 已抵達 → 解鎖，讓幾何計算接手
        }
        return true;
    }
    function updateActive() {
        ticking = false;
        if (kbdLocked()) return;               // [#4 M-1] 捲動動畫進行中：保留鍵盤導航的樂觀值，避免每幀被幾何計算改回舊值
        let active = null;
        let idx = -1;
        for (let i = 0; i < navItems.length; i++) {
            const it = navItems[i];
            if (it.el && it.el.getBoundingClientRect().top <= 150) { active = it; idx = i; }
        }
        // [#4 M-1b] 頁面已滾到底：末章可能因頁尾/剩餘高度不足而永遠無法置頂，視為位於最後一項
        if (navItems.length > 0 && (innerHeight + scrollY) >= document.documentElement.scrollHeight - 80) {
            idx = navItems.length - 1;
            active = navItems[idx];
        }
        for (const it of navItems) it.li.classList.toggle('active', it === active);
        activeIdx = idx;
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
    // 回傳 'inserted'（新插入）| 'exists'（已存在）| 'fail'（容器不存在）—— [#2 MINOR-4] 三態區分
    function appendChapter(url, title, innerHTML, nextUrl) {
        const container = document.querySelector(SITE.contentSelector);
        if (!container) return 'fail';
        const key = norm(url);
        if (key === here || insertedKeys.has(key)) return 'exists';   // insertedKeys 只增不刪，回收段亦涵蓋 [MINOR-1]
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
        trimPreloaded();                       // [整合 M5] 控制注入段落總量
        return 'inserted';
    }

    /* ===== [整合 M5] 預讀段落硬上限：超量回收最舊段落（IO/nav/DOM 同步清理） =====
       手動「再預讀」無批次上限，千章長篇若不回收會把整本書堆進同一個 DOM */
    const MAX_PRELOADED_SECTIONS = 60;
    function trimPreloaded() {
        if (activeIdx < 0) return;             // [MINOR-2] 未定位時不回收，避免抽走視窗下方未讀段落造成靜默跳章
        let excess = document.querySelectorAll('div.uu-preload').length - MAX_PRELOADED_SECTIONS;
        if (excess <= 0) return;
        // [整合 M1] 只回收 activeIdx 之前的段落——正在讀/未讀的段落不抽走
        for (let i = 0; i < navItems.length && excess > 0;) {
            const it = navItems[i];
            const isPreload = it.el && it.el.classList && it.el.classList.contains('uu-preload');
            if (!isPreload || i >= activeIdx) { i++; continue; }
            const el = it.el;
            io.unobserve(el);
            el.remove();
            it.li.remove();
            navItems.splice(i, 1);
            if (activeIdx > 0) activeIdx--;     // [整合 M1] 回收段在當前位置之前 → 索引左移同步
            excess--;
            // 不 i++：splice 後同一索引即為下一項
        }
        if (excess > 0) console.log('ℹ️ 尚有 ' + excess + ' 段接近閱讀位置，暫緩回收');
    }

    /* ===== [修#1] 每本書獨立跳轉紀錄 + from/to 校驗 ===== */
    function clearNextMap() {                  // [MINOR-2] 失效鍵盤 → 兜底目標（書末/成環共用）
        try {
            const nm = getMap('uuNextMap');
            if (nm[bookKey]) { delete nm[bookKey]; putMap('uuNextMap', nm); }
        } catch (e) {}
    }
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
    // [v3.6] 抓取一律為同站請求 → 優先用頁面原生 fetch（帶完整 cookie/UA/Sec-Fetch，
    // 與真人翻頁幾乎同特徵，可通過多數針對 GM_xmlhttpRequest 的 403 反爬）；
    // 失敗（CSP 阻擋/403/401/429）再退回 GM_xmlhttpRequest。
    async function fetchOnce(url) {
        // [#6 S1] 防禦性同站同書斷言：@connect * 全開下，任何未來新增的呼叫點都無法外洩任意 URL
        if (norm(url) !== here && !sameBook(url)) return { status: -3, responseText: null };
        // [v3.6] 原生 fetch 路徑（15s 逾時，同站帶憑證）
        if (typeof fetch === 'function' && typeof AbortController === 'function') {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 15000);
            try {
                const resp = await fetch(url, { credentials: 'same-origin', redirect: 'follow', signal: ac.signal });
                if (resp.ok) { clearTimeout(timer); return { status: 200, responseText: await resp.text() }; }
                const st = resp.status;
                clearTimeout(timer);
                // 403/401/429 可能只針對非 GM 特徵的請求？相反情境也可能——退回 GM 試一次；其餘狀態碼直接回報
                if (st !== 403 && st !== 401 && st !== 429) return { status: st, responseText: null };
            } catch (e) { /* CSP/網路層阻擋或逾時 → 落到 GM */ }
        }
        // [v3.4] 部分手機瀏覽器的腳本環境可能未提供 GM_xmlhttpRequest：明確回報而非拋未處理例外
        if (typeof GM_xmlhttpRequest !== 'function') {
            blockReason = '❌ 此環境無 GM_xmlhttpRequest，無法預讀';
            renderCount();
            return { status: -4, responseText: null };
        }
        return new Promise((resolve) => {
            const req = GM_xmlhttpRequest({
                method: "GET", url: url,
                headers: { "Referer": location.origin + location.pathname },   // [#6 S3] 不送出帶 query 的完整 URL
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
            if (r.status === -4) { lastFetchNote = '環境不支援 GM_xmlhttpRequest'; return null; }   // [v3.4/v3.5]
            if (r.status === 200 && r.responseText) {
                if (/Just a moment|cf-browser-verification|Enable JavaScript/i.test(r.responseText)) {
                    lastFetchNote = '被 Cloudflare 驗證擋下';   // [v3.5]
                    console.warn(`🔒 第 ${attempt} 次收到 Cloudflare 驗證頁，等待重試...`);
                } else return r.responseText;
            } else {
                // [v3.5] 具體狀態上面板：403/404=反爬或連結失效、-1=連線失敗、-2=逾時
                lastFetchNote = r.status === -1 ? '連線失敗（可能被攔截）'
                    : r.status === -2 ? '請求逾時'
                    : ('HTTP ' + r.status);
                console.warn(`⚠️ 請求失敗 (HTTP ${r.status})，第 ${attempt}/${MAX_RETRY} 次重試:`, url);
            }
            if (attempt < MAX_RETRY) await sleep(attempt * 2000);
        }
        return null;
    }

    /* ===== [修#4] 以「已插入頁面」為準的終態發布 ===== */
    async function fetchNextChapters(startUrl, count) {
        const appended = new Set();
        let newCount = 0;                      // [#2 MINOR-4] 只統計「新插入」，已存在不算進度
        let currentUrl = norm(startUrl);
        let nextAfterUrl = null;
        let reachedEnd = false;

        for (let i = 0; i < count; i++) {
            if (aborted) return newCount;          // [修#7] 回傳實際進度供 #2 接力判斷
            if (currentUrl === here || appended.has(currentUrl)) break;
            // [M-2] 批次越大節流越長：>10 章時每章額外 +200ms，降低風控/封禁風險
            if (i > 0) {
                await sleep(CHAPTER_DELAY + Math.max(0, count - 10) * 200);
                if (aborted) return newCount;      // [m-4b] sleep 期間可能已 pagehide，不補發請求
            }

            const html = await getPage(currentUrl);
            if (aborted) return newCount;
            if (!html) break;                      // currentUrl 未載入 → 不在 appended（原因已寫入 lastFetchNote）

            const doc = new DOMParser().parseFromString(html, 'text/html');
            const content = doc.querySelector(SITE.contentSelector);
            const titleEl = doc.querySelector(SITE.titleSelector);
            const title = (titleEl ? (titleEl.textContent || '') : '').trim()
                || (doc.title || '').trim();
            if (!content || !title) {
                // [v3.5] 手機版常見：正文由 JS 動態渲染，原始 HTML 裡是空的
                lastFetchNote = content ? '抓到頁面但無標題' : '抓到頁面但解析不到正文（可能 JS 動態渲染）';
                console.warn('⚠️ 找不到內容或標題，停止'); break;
            }

            const next = findNextLink(doc);
            const href = next && next.getAttribute('href');
            let nextUrl = '';
            if (href && href !== '#' && !/^javascript/i.test(href)) {
                const nu = norm(href, currentUrl);                  // 以被抓取頁為 base 解析相對路徑
                if (nu !== currentUrl && nu !== here && sameBook(nu)) nextUrl = nu;  // 自指/回指/跨書防護
            }
            const st = appendChapter(currentUrl, title, sanitizeContent(content), nextUrl);
            if (st === 'fail') { console.warn('⚠️ 容器不存在，中止本批以免跳章'); break; }   // [m-2] 失敗不計入 appended，續讀點指向此章待重試
            if (st === 'exists') { console.log('↩️ 章節已插入（next 鏈可能成環），停止本批'); break; }   // [MINOR-4] 環形鏈不空轉
            appended.add(currentUrl);
            newCount++;
            console.log('📖 已載入:', title);

            if (!nextUrl) { console.log('🚫 沒有更多章節'); reachedEnd = true; nextAfterUrl = null; break; }
            nextAfterUrl = nextUrl;
            currentUrl = nextUrl;
        }
        if (aborted) return newCount;
        if (nextAfterUrl && !appended.has(nextAfterUrl) && !insertedKeys.has(nextAfterUrl)) {
            publishNext(nextAfterUrl);
            continueUrl = nextAfterUrl;
            setNextBatchItem(nextAfterUrl);
        } else if (nextAfterUrl && insertedKeys.has(nextAfterUrl)) {
            // [整合 M4] 續讀點指向已插入章節（next 鏈成環）→ 清空，避免「再預讀」永久卡死
            continueUrl = null;
            setNextBatchItem(null);
            clearNextMap();                        // [MINOR-2] 與書末分支一致：失效鍵盤 → 兜底目標
            console.log('↩️ next 鏈成環，已停止預讀');
        } else if (reachedEnd) {
            // [MINOR-A] 正常讀到書末：清掉續讀點，避免「再預讀」重抓同一批
            continueUrl = null;
            setNextBatchItem(null);
            bookEnded = true;                      // [m-3c] 終態由 setBusy 統一渲染
            clearNextMap();                        // [整合 M1] 失效 uuNextMap，避免鍵盤 → 兜底跳回已插入章
            console.log('✅ 已到書末');
        } else {
            console.warn('⚠️ 預讀未完整結束，續讀點維持原值（可再按「再預讀」重試）');
        }
        return newCount;                           // [#2 M-1] 供 runPreload 判斷零進度
    }

    /* ===== [修#5 + 互斥鎖] 唯一的預讀入口：try/finally 保護 ===== */
    // [整合 MAJOR-2] setBusy 已於 renderCount 區統一定義（渲染權威集中），此處僅呼叫
    async function runPreload(url, count) {
        if (loading || !url) return 0;             // [#2 M-1] 回傳實際插入數（0 = 無進度）
        loading = true;
        setBusy(true);
        try {
            const n = await fetchNextChapters(url, count);
            lastBatchAppended = n;                 // [#2 M-1] 供 armAutoPreload 判斷是否接力
            if (n > 0) lastFetchNote = '';         // [v3.5] 成功即清除失敗註記
            lastBatchFailed = n === 0 && !bookEnded && !aborted;   // [整合 m4/MINOR-4]
            return n;
        }
        catch (err) { console.error('❌ 預讀流程異常:', err); lastBatchAppended = 0; lastBatchFailed = !aborted; return 0; }
        finally {
            loading = false; setBusy(false); updateActive(); armAutoPreload();   // [#2] 批次結束重新佈防
        }
    }
    moreBtn.addEventListener('click', () => {
        if (loading || bookEnded || !continueUrl) return;   // [MAJOR-1] 雙保險：disabled 之外 handler 也擋
        autoBatches = 0;                                    // [S-2] 手動點擊重置自動配額
        runPreload(continueUrl, preloadCount);
    });

    /* ===== [#2] 無縫滾動：最後一段章節接近可視區時自動預讀下一批 ===== */
    let autoBatches = 0;                       // 每次頁面載入的自動批次上限（防止掛機抓整本書）
    let userScrolled = false;                  // [S-1] 需先有使用者滾動才啟用自動接力
    const AUTO_BATCH_LIMIT = 4;
    const io2 = new IntersectionObserver((entries) => {
        for (const en of entries) {
            if (!en.isIntersecting) continue;
            if (loading || aborted || bookEnded || !continueUrl) continue;
            if (!userScrolled || document.hidden) continue;   // [S-1] 無滾動意圖／分頁在背景不自動抓
            if (autoBatches >= AUTO_BATCH_LIMIT) {
                console.log('ℹ️ 自動預讀已達本頁上限（' + AUTO_BATCH_LIMIT + ' 批），可手動點「再預讀」');
                continue;
            }
            autoBatches++;
            runPreload(continueUrl, preloadCount).then((n) => {
                if (!n) autoBatches--;         // [m-1] 零進度批次退還配額
            });                                 // 完成後 runPreload 的 finally 會重新 arm
        }
    }, { rootMargin: '1200px 0px' });          // 提前 1200px 觸發，滾動到時內容多半已就位
    window.addEventListener('scroll', () => {  // [S-1] 首次滾動：啟用閘門並開始佈防
        if (!userScrolled) { userScrolled = true; armAutoPreload(); return; }
        // [m-2] 節流重佈防：零進度失敗後，網路恢復時滾動可自然恢復自動接力
        if (!scrollArmTimer) {
            scrollArmTimer = setTimeout(() => { scrollArmTimer = null; armAutoPreload(); }, 800);
        }
    }, { passive: true });
    let scrollArmTimer = null;
    function armAutoPreload() {
        io2.disconnect();
        if (aborted || bookEnded || !continueUrl || autoBatches >= AUTO_BATCH_LIMIT) return;   // [m-4]
        if (lastBatchAppended === 0) return;   // [M-1] 上批零進度（抓取失敗）→ 不自動接力，交還使用者
        // [M-2] 只觀察已插入的最後一章；無插入章節時不佈防（觀察正文容器會立即誤觸發）
        const secs = document.querySelectorAll('div.uu-preload');
        if (!secs.length) return;
        io2.observe(secs[secs.length - 1]);
    }

    /* ===== [修#7] 離開頁面時中止未完成請求（[#2 m-3] 移至 io2 之後註冊，避免 TDZ） ===== */
    window.addEventListener('pagehide', (e) => {
        if (e.persisted) return;               // [#2 M-3] 進 bfcache：不中止，返回後繼續讀
        aborted = true;
        inflight.forEach(r => { try { r.abort && r.abort(); } catch (e) {} });
        io2.disconnect();                      // [#2 m-4] 卸載時不再佈防
    });
    window.addEventListener('pageshow', (e) => {   // [#2 M-3] bfcache 還原：復位並重新佈防
        if (!e.persisted) return;
        aborted = false;
        loading = false;                           // [整合 M3] 凍結期間 in-flight 請求可能已死，解除互斥鎖
        inflight.clear();
        setBusy(false);
        armAutoPreload();
    });

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

    /* ===== [#4] 鍵盤快捷鍵：→ 下一章、← 上一章、P 跳回上次進度 ===== */
    // 優先在已預讀章節間平滑滾動（免重載、進度持續被 io 偵測）；無預讀內容時才真實導航
    function isTypingTarget(t) {
        if (!(t instanceof Element)) return false;
        if (t.closest('#uu-nav-panel')) return true;    // [N5] 焦點在面板內不攔，避免按鍵行為割裂
        const tag = t.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
    }
    function goNextChapter() {
        if (bookEnded) { console.log('✅ 已到書末'); return false; }   // [整合 M1] 書末不再硬導航回舊續讀點
        // [M1] activeIdx=-1（尚未滾動/標題被頂出 150px 線）視為「從本頁開始」→ 目標 navItems[0]
        if (navItems.length > 1) {
            const target = activeIdx < 0 ? 0 : activeIdx + 1;
            if (target <= navItems.length - 1) {
                const it = navItems[target];
                if (it && it.el) {
                    kbdArm(it.el);                       // [v3.3] 抵達導向鎖定（原 900ms 固定鎖）
                    it.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    activeIdx = target;                  // [N1] 樂觀更新：連按不被 rAF 節流卡住
                    return true;
                }
            }
        }
        // [C1/M2] 兜底與點擊攔截同源（uuNextMap → continueUrl），不用 findNextLink——
        // 它指向「本頁的下一章」（即第一個已預讀章），硬導航會重載已讀內容；也可能誤取翻頁/目錄連結
        const t = clickJumpTarget() || (continueUrl && sameBook(continueUrl) ? continueUrl : '');
        if (t) { location.href = t; return true; }
        console.log('🚫 沒有下一章');
        return false;
    }
    function goPrevChapter() {
        // [S1/M-2] activeIdx>=1 才在段落間回滾（1 = 滾回本頁開頭）；0 直接走真實「上一章」
        if (activeIdx >= 1) {
            const it = navItems[activeIdx - 1];
            if (it && it.el) {
                kbdArm(it.el);                           // [v3.3] 抵達導向鎖定（原 900ms 固定鎖）
                it.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                activeIdx = activeIdx - 1;               // [N1] 樂觀更新
                return true;
            }
        }
        // 頁面自身的「上一章」連結（rel=prev 優先、文字比對後備），排除注入內容內的錨點 [N4]
        const prevA = [...document.querySelectorAll('a[href]')].find(a =>
            !a.closest('div.uu-preload') && (
                /(^|\s)prev(ious)?(\s|$)/i.test(a.getAttribute('rel') || '') ||
                /上一[章頁页]/.test((a.textContent || '').replace(/\s+/g, ''))));
        if (prevA) {
            const h = prevA.getAttribute('href');
            if (h && h !== '#' && !/^javascript/i.test(h)) {
                try { sessionStorage.setItem('uuBackNav', norm(h)); } catch (e) {}   // [v3.3] 標記回讀導航，落地時 landingJump 不彈回
                location.href = norm(h); return true;
            }
        }
        // 退回 uuProgress.last：僅當本頁正是 last 的「下一章」（前進後的頁），避免誤跳
        const prog = getMap('uuProgress')[bookKey];
        if (prog && prog.last && hostAgnostic(prog.next) === hostAgnostic(here) && sameBook(prog.last)) {
            try { sessionStorage.setItem('uuBackNav', norm(prog.last)); } catch (e) {}   // [v3.3]
            location.href = prog.last; return true;
        }
        console.log('🚫 沒有上一章');
        return false;
    }
    function jumpToProgress() {
        const prog = getMap('uuProgress')[bookKey];
        if (!prog || !prog.next) { console.log('ℹ️ 尚無閱讀進度'); return false; }
        const to = norm(prog.next);
        if (hostAgnostic(to) === hostAgnostic(here)) { console.log('ℹ️ 已在最新進度'); return false; }
        if (sameBook(to)) { location.href = to; return true; }
        console.log('🚫 進度點非同書章節，已忽略');
        return false;
    }
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;   // 不搶瀏覽器/系統快捷鍵
        if (e.isComposing || e.keyCode === 229) return;                 // [N3] 輸入法合成中不攔
        if (isTypingTarget(e.target)) return;                           // 輸入框中不攔
        // [M-1c] 統一 !e.repeat：單擊單章；僅在有實際動作時才吞事件，無事可做時保留原生捲動
        let handled = false;
        if (e.key === 'ArrowRight' && !e.repeat) handled = goNextChapter();
        else if (e.key === 'ArrowLeft' && !e.repeat) handled = goPrevChapter();
        else if (e.key === 'p' || e.key === 'P') handled = jumpToProgress();
        if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, { capture: true });                                               // [N2] capture 搶在站方 bubble handler 前

    function start() {
        const titleEl = document.querySelector(SITE.titleSelector);
        const nextLink = findNextLink(document);
        const href = nextLink && nextLink.getAttribute('href');
        if (titleEl) addNavItem((titleEl.textContent || '').trim(), titleEl);
        updateActive();                            // [M3] 初始高亮 + activeIdx 就緒（含 start 提前 return 的路徑）

        if (!href || href === '#' || /^javascript/i.test(href)) {
            // [v3.4] 失敗原因上面板（手機無 console 可看）
            blockReason = '⚠️ 未偵測到「下一章」連結';
            console.warn('❌ 下一章連結無效'); renderCount(); return;
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
        if (!sameBook(cu)) {
            blockReason = '🚫 下一章非同書連結，無法預讀';
            console.log('🚫 下一章連結非同書章節（可能已是最後一章）'); renderCount(); return;
        }
        continueUrl = cu;                          // [修#5] 先初始化：首輪失敗仍可重試
        setNextBatchItem(continueUrl);
        runPreload(continueUrl, preloadCount);
    }
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
})();
