// ==UserScript==
// @name         小說傳書 (Novel → Readmoo)
// @namespace    https://github.com/jacky3213
// @version      0.1.0
// @updateURL     https://raw.githubusercontent.com/jacky3213/ToolWeb/main/public/apks/readmo-novel.user.js
// @downloadURL   https://raw.githubusercontent.com/jacky3213/ToolWeb/main/public/apks/readmo-novel.user.js
// @description  一鍵抓取整本小說 → 打包 EPUB → 自動上傳到 Readmoo (mooInk) 書櫃。全程在你的瀏覽器執行，繞過 Cloudflare / Cognito WAF 對伺服器 IP 的封鎖。
// @author       Jacky
// @match        https://uukanshu.cc/book/*/*
// @match        https://twkan.com/txt/*/*
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /* ============================ 站點偵測（沿用預讀器） ============================ */
    const SITES = {
        'uukanshu.cc': {
            bookIdRe: /^\/book\/(\d+)/,
            bookPrefix: '/book/',
            contentSelector: '.readcotent.bbb.font-normal, .readcotent, #content, #BookText',
            titleSelector: 'h1, .title h1',
            nextLinkSelector: '#linkNext',
        },
        'twkan.com': {
            bookIdRe: /^\/txt\/(\d+)/,
            bookPrefix: '/txt/',
            contentSelector: '#txtcontent0, #txtcontent, .readcotent, #content',
            titleSelector: '.txtnav h1, #container h1, h1',
            nextLinkSelector: null,
        },
    };
    const TEMPLATES = [
        { name: '69shu-A(uukanshu)', ...SITES['uukanshu.cc'] },
        { name: '69shu-B(twkan)', ...SITES['twkan.com'] },
    ];
    const hostname = location.hostname.replace(/^www\./, '');
    let SITE = SITES[hostname] || null;
    if (!SITE) {
        const m = location.pathname.match(/^\/([a-z0-9_-]{2,20})\/(\d+)\/(\d+)(?:\.html?)?\/?$/i);
        if (m) {
            const probe = (sel) => {
                for (const s of sel.split(',')) {
                    const el = document.querySelector(s.trim());
                    if (!el) continue;
                    if ((el.textContent || '').replace(/\s+/g, '').length < 100) continue;
                    if (el.checkVisibility && !el.checkVisibility()) continue;
                    return el;
                }
                return null;
            };
            const tpl = TEMPLATES.find(t => probe(t.contentSelector));
            if (tpl) {
                SITE = {
                    bookIdRe: /^\/[a-z0-9_-]{2,20}\/(\d+)\//i,
                    bookPrefix: '/' + m[1] + '/',
                    contentSelector: tpl.contentSelector,
                    titleSelector: tpl.titleSelector,
                    nextLinkSelector: tpl.nextLinkSelector,
                };
            }
        }
    }
    if (!SITE) return;

    const norm = (u, base) => { try { return new URL(u, base || location.href).href.split('#')[0]; } catch (e) { return String(u || '').split('#')[0]; } };
    const bookId = (location.pathname.match(SITE.bookIdRe) || [])[1];
    if (!bookId) return;
    const bookPrefix = SITE.bookPrefix + bookId + '/';
    const sameBook = (u) => {
        try {
            const x = new URL(u, location.href);
            if (x.hostname.replace(/^www\./, '') !== hostname) return false;
            return x.pathname.toLowerCase().startsWith(bookPrefix.toLowerCase()) &&
                x.pathname.slice(bookPrefix.length).replace(/\/+$/, '').length > 0;
        } catch (e) { return false; }
    };

    /* ============================ 工具 ============================ */
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const _crypto = (typeof crypto !== 'undefined') ? crypto : (typeof window !== 'undefined' && window.crypto) ? window.crypto : null;
    const _uuid = () => {
        if (_crypto && _crypto.randomUUID) return _crypto.randomUUID();
        return 'xxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)) + Date.now().toString(36);
    };

    // 同源章節頁：優先頁面原生 fetch（帶完整 cookie 與瀏覽器特徵，反 403）
    async function fetchPage(url) {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = await res.arrayBuffer();
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        let text;
        try {
            text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
            if (ct.includes('gbk') || ct.includes('gb2312') || /[\ufffd]{3,}/.test(text)) {
                text = new TextDecoder('gbk', { fatal: false }).decode(buf);
            }
        } catch (e) {
            text = new TextDecoder('utf-8').decode(buf);
        }
        return { text, url: res.url };
    }

    // 跨域（Cognito / api.readmoo.com / S3）用 GM_xmlhttpRequest
    function gmRequest(opt) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: opt.method || 'GET',
                url: opt.url,
                headers: opt.headers || {},
                data: opt.data,
                binary: !!opt.binary,
                timeout: opt.timeout || 60000,
                onload: (r) => resolve({ status: r.status, text: r.responseText, raw: r.response }),
                onerror: (e) => reject(new Error('GM 請求失敗')),
                ontimeout: () => reject(new Error('逾時')),
            });
        });
    }

    /* ============================ SRP-6a + Cognito 登入 ============================ */
    const SRP_N_HEX = 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';
    const SRP_g = 2n;
    const SRP_N = BigInt('0x' + SRP_N_HEX);
    const POOL_ID = 'ap-northeast-1_EH9vxBYqK';
    const CLIENT_ID = '1vo6drk6c6ma7htam496pnrkdr';
    const COGNITO_URL = 'https://cognito-idp.ap-northeast-1.amazonaws.com/';

    const sha256Hex = (s) => CryptoJS.SHA256(s).toString(CryptoJS.enc.Hex);
    const hexBigInt = (h) => BigInt('0x' + h);
    const padHex = (h) => h.padStart(768, '0');

    function modPow(base, exp, mod) {
        let r = 1n, b = ((base % mod) + mod) % mod, e = exp;
        while (e > 0n) { if (e & 1n) r = (r * b) % mod; b = (b * b) % mod; e >>= 1n; }
        return r;
    }
    function randomBigInt(bytes) {
        const buf = new Uint8Array(bytes);
        _crypto.getRandomValues(buf);
        let h = '';
        for (const b of buf) h += b.toString(16).padStart(2, '0');
        return BigInt('0x' + h);
    }

    function computeHkdf(Ahex, Shex) {
        const keyWA = CryptoJS.enc.Hex.parse(padHex(Ahex));
        const ikmWA = CryptoJS.enc.Hex.parse(padHex(Shex));
        const prk = CryptoJS.HmacSHA256(ikmWA, keyWA);
        const infoWA = CryptoJS.enc.Utf8.parse('Caldera Derived Key').concat(CryptoJS.enc.Hex.parse('01'));
        let prev = CryptoJS.lib.WordArray.create();
        const words = [];
        for (let i = 0; i < 16; i++) {
            const data = prev.clone()
                .concat(infoWA)
                .concat(CryptoJS.enc.Hex.parse((i + 1).toString(16).padStart(2, '0')));
            prev = CryptoJS.HmacSHA256(data, prk);
            words.push(prev.words[0]);
        }
        return CryptoJS.lib.WordArray.create(words); // 64 bytes
    }

    async function cognitoLogin(username, password) {
        const a = randomBigInt(128);
        const A = modPow(SRP_g, a, SRP_N);

        // InitiateAuth USER_SRP_AUTH
        const init = await gmRequest({
            method: 'POST',
            url: COGNITO_URL,
            headers: {
                'Content-Type': 'application/x-amz-json-1.1',
                'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
            },
            data: JSON.stringify({
                AuthFlow: 'USER_SRP_AUTH',
                ClientId: CLIENT_ID,
                AuthParameters: { USERNAME: username, SRP_A: padHex(A.toString(16)) },
            }),
        });
        let j = JSON.parse(init.text || '{}');
        if (j.__type) throw new Error(j.__type + (j.message ? '：' + j.message : ''));
        if (j.ChallengeName !== 'PASSWORD_VERIFIER') throw new Error('挑戰類型異常：' + (j.ChallengeName || '(無)'));

        const p = j.ChallengeParameters || {};
        const salt = p.SALT || '';
        const B = p.SRP_B || '';
        const secretBlock = p.SECRET_BLOCK || '';
        const userIdForSrp = p.USER_ID_FOR_SRP || '';
        const poolName = POOL_ID.split('_')[1];

        const x = hexBigInt(sha256Hex(salt + sha256Hex(poolName + username + ':' + password)));
        const k = hexBigInt(sha256Hex(padHex(SRP_N.toString(16)) + padHex(SRP_g.toString(16))));
        const u = hexBigInt(sha256Hex(padHex(A.toString(16)) + padHex(B)));
        const gPowX = modPow(SRP_g, x, SRP_N);
        const base = ((hexBigInt(B) - k * gPowX) % SRP_N + SRP_N) % SRP_N;
        const S = modPow(base, a + u * x, SRP_N);

        const hkdfKey = computeHkdf(A.toString(16), S.toString(16));
        const claimData = CryptoJS.enc.Utf8.parse(poolName)
            .concat(CryptoJS.enc.Utf8.parse(userIdForSrp))
            .concat(CryptoJS.enc.Base64.parse(secretBlock));
        const claim = CryptoJS.HmacSHA256(claimData, hkdfKey).toString(CryptoJS.enc.Base64);

        const resp = await gmRequest({
            method: 'POST',
            url: COGNITO_URL,
            headers: {
                'Content-Type': 'application/x-amz-json-1.1',
                'X-Amz-Target': 'AWSCognitoIdentityProviderService.RespondToAuthChallenge',
            },
            data: JSON.stringify({
                ChallengeName: 'PASSWORD_VERIFIER',
                ClientId: CLIENT_ID,
                ChallengeResponses: {
                    USERNAME: username,
                    PASSWORD_CLAIM_SIGNATURE: claim,
                    TIMESTAMP: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
                },
            }),
        });
        j = JSON.parse(resp.text || '{}');
        if (j.__type) throw new Error(j.__type + (j.message ? '：' + j.message : ''));
        if (!j.AuthenticationResult || !j.AuthenticationResult.AccessToken) throw new Error('未回傳 AccessToken（帳密錯誤？）');
        return j.AuthenticationResult.AccessToken;
    }

    /* ============================ 兩段式上傳 ============================ */
    function bytesToWordArray(u8) {
        const words = [];
        for (let i = 0; i < u8.length; i += 4) {
            words.push(((u8[i] || 0) << 24) | ((u8[i + 1] || 0) << 16) | ((u8[i + 2] || 0) << 8) | (u8[i + 3] || 0));
        }
        return CryptoJS.lib.WordArray.create(words, u8.length);
    }

    async function uploadDocument(accessToken, fileBytes, fileName, onLog) {
        const wa = bytesToWordArray(fileBytes);
        const md5 = CryptoJS.MD5(wa).toString(CryptoJS.enc.Base64);
        const sha256 = CryptoJS.SHA256(wa).toString(CryptoJS.enc.Hex);
        const mime = /\.epub$/i.test(fileName) ? 'application/epub+zip' : 'text/plain';

        // 1) 建立 document
        onLog('建立 document：' + fileName);
        const create = await gmRequest({
            method: 'POST',
            url: 'https://api.readmoo.com/store/v3/me/documents/',
            headers: {
                'authorization': 'Bearer ' + accessToken,
                'content-type': 'application/vnd.api+json',
                'accept': 'application/json, text/plain, */*',
                'origin': 'https://next.readmoo.com',
                'referer': 'https://next.readmoo.com/',
            },
            data: JSON.stringify({
                data: { type: 'documents' },
                meta: { file: { name: fileName, size: fileBytes.length, type: mime, md5, sha256 } },
            }),
        });
        let cj = JSON.parse(create.text || '{}');
        if (create.status >= 400 || cj.errors) throw new Error('建立 document 失敗 HTTP ' + create.status);
        const uploadUrl = cj && cj.meta && cj.meta.upload_endpoint;
        if (!uploadUrl) throw new Error('回應缺少 upload_endpoint');

        // 2) PUT 檔案到 S3 presigned URL
        onLog('上傳到 S3：' + fileName);
        const put = await gmRequest({
            method: 'PUT',
            url: uploadUrl,
            headers: {
                'Content-MD5': md5,
                'Content-SHA256': sha256,
                'Content-Type': mime,
            },
            data: new Blob([fileBytes], { type: mime }),
        });
        if (put.status >= 300) throw new Error('S3 上傳失敗 HTTP ' + put.status);
        return cj.data && cj.data.id;
    }

    /* ============================ EPUB 打包 ============================ */
    function xmlEscape(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function chapterXhtml(title, body) {
        const ps = body.split(/\n+/).map(l => l.trim()).filter(Boolean).map(l => '<p>' + xmlEscape(l) + '</p>').join('\n      ');
        return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-TW" lang="zh-TW">\n  <head><meta charset="UTF-8" /><title>' + xmlEscape(title) + '</title><link rel="stylesheet" type="text/css" href="styles.css" /></head>\n  <body>\n    <h2 class="chapter-title">' + xmlEscape(title) + '</h2>\n      ' + ps + '\n  </body>\n</html>';
    }
    const EPUB_CSS = 'body{line-height:1.75;margin:1em 0.8em}h2.chapter-title{font-size:1.1em;text-align:center;margin:0 0 1.2em}p{text-indent:2em;margin:0 0 0.6em;text-align:justify}';

    async function buildEpub(title, author, chapters, volumeLabel) {
        const zip = new JSZip();
        const bookTitle = volumeLabel ? title + ' ' + volumeLabel : title;
        const uid = _uuid();
        zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
        zip.file('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
        zip.file('OEBPS/styles.css', EPUB_CSS);

        const manifest = [], spine = [], navPoints = [], navItems = [];
        chapters.forEach((ch, i) => {
            const id = 'item' + (i + 1);
            const file = 'chap_' + String(i + 1).padStart(5, '0') + '.xhtml';
            zip.file('OEBPS/' + file, chapterXhtml(ch.title, ch.text));
            manifest.push('<item id="' + id + '" href="' + file + '" media-type="application/xhtml+xml"/>');
            spine.push('<itemref idref="' + id + '"/>');
            const t = xmlEscape(ch.title.slice(0, 80));
            navPoints.push('<navPoint id="navPoint-' + (i + 1) + '" playOrder="' + (i + 1) + '"><navLabel><text>' + t + '</text></navLabel><content src="' + file + '"/></navPoint>');
            navItems.push('<li><a href="' + file + '">' + t + '</a></li>');
        });
        manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
        manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
        manifest.push('<item id="css" href="styles.css" media-type="text/css"/>');

        zip.file('OEBPS/content.opf', '<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:uuid:' + uid + '</dc:identifier><dc:title>' + xmlEscape(bookTitle) + '</dc:title><dc:creator>' + xmlEscape(author || '未知作者') + '</dc:creator><dc:language>zh-TW</dc:language></metadata>\n<manifest>' + manifest.join('') + '</manifest>\n<spine toc="ncx">' + spine.join('') + '</spine>\n</package>');
        zip.file('OEBPS/toc.ncx', '<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:' + uid + '"/></head><docTitle><text>' + xmlEscape(bookTitle) + '</text></docTitle><navMap>\n' + navPoints.join('\n') + '\n</navMap></ncx>');
        zip.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="UTF-8" /><title>目錄</title></head><body><nav epub:type="toc" id="toc"><h1>目錄</h1><ol>' + navItems.join('') + '</ol></nav></body></html>');

        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
        return new Uint8Array(await blob.arrayBuffer());
    }

    function splitVolumes(chapters) {
        const MAX_CHAPTERS = 900, MAX_CHARS = 900000, SAFE = 12000;
        const volumes = []; let cur = [], curChars = 0;
        const flush = () => { if (cur.length) { volumes.push(cur); cur = []; curChars = 0; } };
        const push = (c) => { if (cur.length >= MAX_CHAPTERS || curChars + c.text.length > MAX_CHARS) flush(); cur.push(c); curChars += c.text.length; };
        for (const ch of chapters) {
            if (ch.text.length > 15000) {
                const parts = []; let buf = '';
                for (const line of ch.text.split('\n')) {
                    if (line.length > SAFE) { if (buf) { parts.push(buf); buf = ''; } for (let i = 0; i < line.length; i += SAFE) parts.push(line.slice(i, i + SAFE)); continue; }
                    if (buf.length + line.length > SAFE) { parts.push(buf); buf = ''; }
                    buf += line + '\n';
                }
                if (buf.trim()) parts.push(buf);
                parts.forEach((p, i) => push({ title: ch.title + '（' + (i + 1) + '/' + parts.length + '）', text: p }));
                continue;
            }
            push(ch);
        }
        flush();
        return volumes;
    }

    /* ============================ 爬整本 ============================ */
    function findNextLink(rootDoc, pageUrl) {
        const doc = rootDoc;
        if (SITE.nextLinkSelector) {
            const el = doc.querySelector(SITE.nextLinkSelector);
            if (el) return el.getAttribute('href');
        }
        const cands = [...doc.querySelectorAll('a[href]')].filter(a => {
            const h = a.getAttribute('href') || '';
            return h && h !== '#' && !/^javascript:/i.test(h);
        });
        const byRel = cands.find(a => /(^|\s)next(\s|$)/i.test(a.getAttribute('rel') || '') || /(^|\s)(next|nextchapter|next-chapter)(\s|$)/i.test(a.className || ''));
        if (byRel) return byRel.getAttribute('href');
        const txt = (a) => (a.textContent || '').replace(/\s+/g, '');
        return (cands.find(a => /下一[章頁页节]/.test(txt(a))) || cands.find(a => /^下[章页頁]$/.test(txt(a))) || cands.find(a => /^next(\s*(chapter|page|→|»))?$/i.test(txt(a))))?.getAttribute('href') || null;
    }

    async function crawlAll(firstChapterUrl, onProgress, onLog) {
        const chapters = [];
        const visited = new Set();
        let url = firstChapterUrl;
        const max = 5000, maxChars = 12000000; let totalChars = 0;
        while (url && chapters.length < max) {
            if (visited.has(url)) break;
            visited.add(url);
            const { text, url: realUrl } = await fetchPage(url);
            const doc = new DOMParser().parseFromString(text, 'text/html');
            let title = '';
            for (const sel of SITE.titleSelector.split(',')) {
                const el = doc.querySelector(sel.trim());
                if (el && el.textContent.trim()) { title = el.textContent.replace(/\s+/g, ' ').trim(); break; }
            }
            let content = '';
            for (const sel of SITE.contentSelector.split(',')) {
                const el = doc.querySelector(sel.trim());
                if (el) { const t = el.textContent.replace(/\u00a0/g, ' ').split(/\r?\n/).map(l => l.trim()).filter(Boolean).join('\n'); if (t.length > 50) { content = t; break; } }
            }
            if (!content) { onLog('⚠ 解析不到正文，跳過：' + url); }
            else {
                chapters.push({ title: title || '第 ' + (chapters.length + 1) + ' 章', text: content });
                totalChars += content.length;
                onProgress(chapters.length, title);
            }
            if (totalChars > maxChars) { onLog('已達字數上限，停止'); break; }
            const next = findNextLink(doc, realUrl);
            if (!next) break;
            url = norm(next, realUrl);
            if (!sameBook(url)) { onLog('下一章指向其他書/站，停止'); break; }
            await sleep(600); // 節流
        }
        return chapters;
    }

    /* ============================ UI 面板 ============================ */
    function injectUi(onStart) {
        if (document.getElementById('nr-panel')) return;
        const host = document.createElement('div');
        host.id = 'nr-panel';
        host.innerHTML = `
        <style>
          #nr-panel .nr-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#f59e0b;color:#0f172a;font:bold 13px/1 system-ui,sans-serif;padding:10px 14px;border-radius:10px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}
          #nr-panel .nr-box{position:fixed;right:18px;bottom:64px;z-index:2147483000;width:320px;max-width:92vw;background:#0b0f1a;color:#e2e8f0;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:14px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5);display:none}
          #nr-panel .nr-box.open{display:block}
          #nr-panel input{width:100%;box-sizing:border-box;background:#151b2b;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:8px 10px;color:#fff;font-size:13px;margin:4px 0}
          #nr-panel button{background:#f59e0b;color:#0f172a;border:0;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;font-size:13px}
          #nr-panel .nr-log{max-height:180px;overflow:auto;background:#00000055;border-radius:8px;padding:8px;margin-top:8px;font:11px/1.5 monospace;color:#94a3b8;white-space:pre-wrap}
          #nr-panel .nr-bar{height:6px;background:#1e293b;border-radius:3px;overflow:hidden;margin-top:8px}
          #nr-panel .nr-fill{height:100%;background:#f59e0b;width:0;transition:width .3s}
        </style>
        <div class="nr-fab">📤 傳書到 Readmoo</div>
        <div class="nr-box">
          <div style="font-weight:700;margin-bottom:6px">傳書到 Readmoo（mooInk）</div>
          <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">抓取整本 → 打包 EPUB → 上傳到你的書櫃。帳密只在本地使用，不上傳到任何伺服器。</div>
          <input id="nr-email" type="email" placeholder="Readmoo 帳號（Email）" autocomplete="username">
          <input id="nr-pass" type="password" placeholder="Readmoo 密碼" autocomplete="current-password">
          <label style="font-size:11px;color:#94a3b8;display:flex;gap:6px;align-items:center"><input id="nr-remember" type="checkbox" style="width:auto"> 記住帳號（密碼不儲存）</label>
          <div style="margin-top:8px;display:flex;gap:8px">
            <button id="nr-start">開始抓取並上傳</button>
            <button id="nr-close" style="background:#334155;color:#e2e8f0">關閉</button>
          </div>
          <div class="nr-bar"><div class="nr-fill" id="nr-fill"></div></div>
          <div class="nr-log" id="nr-log"></div>
        </div>`;
        document.body.appendChild(host);
        const fab = host.querySelector('.nr-fab');
        const box = host.querySelector('.nr-box');
        fab.onclick = () => box.classList.toggle('open');
        host.querySelector('#nr-close').onclick = () => box.classList.remove('open');
        host.querySelector('#nr-email').value = GM_getValue('nr_email', '');
        host.querySelector('#nr-remember').checked = !!GM_getValue('nr_email', '');
        host.querySelector('#nr-start').onclick = () => {
            const email = host.querySelector('#nr-email').value.trim();
            const pass = host.querySelector('#nr-pass').value;
            const remember = host.querySelector('#nr-remember').checked;
            if (remember && email) GM_setValue('nr_email', email); else GM_setValue('nr_email', '');
            if (!email || !pass) { alert('請輸入 Readmoo 帳號密碼'); return; }
            onStart(email, pass, host);
        };
        return host;
    }

    /* ============================ 主流程 ============================ */
    injectUi(async (email, password, host) => {
        const logEl = host.querySelector('#nr-log');
        const fillEl = host.querySelector('#nr-fill');
        const startBtn = host.querySelector('#nr-start');
        startBtn.disabled = true;
        const log = (m) => { logEl.textContent += '[' + new Date().toLocaleTimeString('zh-TW', { hour12: false }) + '] ' + m + '\n'; logEl.scrollTop = logEl.scrollHeight; };
        const setPct = (p) => { fillEl.style.width = Math.min(100, p) + '%'; };

        try {
            // 1) 找第一章：抓書籍頁，取數值最小的章節連結
            log('尋找書籍目錄…');
            setPct(2);
            const bookUrl = location.origin + SITE.bookPrefix + bookId + '/';
            const { text: bookText } = await fetchPage(bookUrl);
            const bdoc = new DOMParser().parseFromString(bookText, 'text/html');
            let bookTitle = (bdoc.querySelector('h1')?.textContent || document.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim();
            if (!bookTitle) bookTitle = bookId;
            const chapterNo = (u) => { const m = u.match(/\/(\d+)[^\d/]*(?:[#?].*)?$/); return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER; };
            let links = new Set();
            bdoc.querySelectorAll('a[href]').forEach(a => { const h = a.getAttribute('href'); if (!h) return; const abs = norm(h, bookUrl); if (sameBook(abs)) links.add(abs); });
            let chapterUrls = [...links].sort((a, b) => chapterNo(a) - chapterNo(b));
            if (!chapterUrls.length) throw new Error('書籍頁找不到章節連結，請在「章節列表頁」開啟本腳本');
            log('書名：' + bookTitle + '，共偵測 ' + chapterUrls.length + ' 章');

            // 2) 爬整本
            log('開始爬取章節…');
            setPct(5);
            const chapters = await crawlAll(chapterUrls[0], (n, t) => { setPct(5 + Math.min(50, n / 20)); if (n % 20 === 0) log('已抓 ' + n + ' 章（最新：' + t + '）'); }, log);
            log('✓ 完成爬取，共 ' + chapters.length + ' 章');
            if (!chapters.length) throw new Error('沒抓到任何章節');

            // 3) 分卷打包
            log('打包 EPUB…');
            setPct(60);
            const volumes = splitVolumes(chapters);
            log('分卷：' + (volumes.length > 1 ? volumes.length + ' 卷' : '單卷'));
            const epubFiles = [];
            for (let i = 0; i < volumes.length; i++) {
                const label = volumes.length > 1 ? '第' + (i + 1) + '卷' : '';
                const bytes = await buildEpub(bookTitle, '', volumes[i], label);
                epubFiles.push({ bytes, label, chapters: volumes[i].length });
                log('✓ 打包完成：' + (label || '全書') + '（' + volumes[i].length + ' 章，' + (bytes.length / 1024).toFixed(0) + ' KB）');
                setPct(60 + (i + 1) / volumes.length * 10);
            }

            // 4) 登入
            log('登入 Readmoo…');
            setPct(72);
            const token = await cognitoLogin(email, password);
            log('✓ 登入成功');

            // 5) 上傳
            let ok = 0;
            for (let i = 0; i < epubFiles.length; i++) {
                const f = epubFiles[i];
                const safeTitle = bookTitle.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
                const fileName = epubFiles.length > 1 ? safeTitle + '_' + f.label + '.epub' : safeTitle + '.epub';
                log('上傳 ' + (f.label || '全書') + '…');
                const docId = await uploadDocument(token, f.bytes, fileName, log);
                ok++;
                log('✓ 上傳完成（document ' + docId + '）');
                setPct(75 + (i + 1) / epubFiles.length * 25);
            }
            setPct(100);
            log('🎉 全部完成！回到 mooInk 按「同步」即可看到。');
        } catch (e) {
            log('✗ 失敗：' + (e && e.message ? e.message : e));
        } finally {
            startBtn.disabled = false;
        }
    });
})();
