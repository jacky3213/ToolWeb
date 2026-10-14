// ==UserScript==
// @name         小說傳書 (Novel → Readmoo)
// @namespace    https://github.com/jacky3213
// @version      0.3.2
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
// @connect      api.readmoo.com
// @connect      amazonaws.com
// @connect      uukanshu.cc
// @connect      twkan.com
// @connect      *
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js
// @require      https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
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
    // 即使非書頁也繼續執行（提供「搜尋小說」入口）；bookCtx 代表當前要抓的書
    const norm = (u, base) => { try { return new URL(u, base || location.href).href.split('#')[0]; } catch (e) { return String(u || '').split('#')[0]; } };
    const bookId = SITE ? (location.pathname.match(SITE.bookIdRe) || [])[1] : null;
    const canCrawl = !!(SITE && bookId);
    // 當前要抓的書上下文：書頁由 location 推導；搜索選書後覆蓋為選中的書（原地抓取，不跳轉）
    let bookCtx = canCrawl ? {
        SITE: SITE,
        bookId: bookId,
        bookUrl: location.origin + SITE.bookPrefix + bookId + '/',
        bookKey: hostname + ':' + bookId,
    } : null;
    const sameBook = (u) => {
        if (!bookCtx) return false;
        const prefix = bookCtx.SITE.bookPrefix + bookCtx.bookId + '/';
        try {
            const x = new URL(u, bookCtx.bookUrl);
            return x.pathname.toLowerCase().startsWith(prefix.toLowerCase()) &&
                x.pathname.slice(prefix.length).replace(/\/+$/, '').length > 0;
        } catch (e) { return false; }
    };

    /* ============================ 工具 ============================ */
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const _crypto = (typeof crypto !== 'undefined') ? crypto : (typeof window !== 'undefined' && window.crypto) ? window.crypto : null;
    const _uuid = () => {
        if (_crypto && _crypto.randomUUID) return _crypto.randomUUID();
        return 'xxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)) + Date.now().toString(36);
    };

    // 抓取速度預設（章節間延遲 + 隨機抖動，避免固定模式被反爬辨識）
    const SPEED_PRESETS = {
        slow: { delay: 2500, jitter: 1000, label: '慢（最穩）' },
        medium: { delay: 1200, jitter: 500, label: '中' },
        fast: { delay: 500, jitter: 300, label: '快（易被限流）' },
    };
    // 全域可變速度：抓取過程中使用者改 select 即時生效
    let currentSpeed = 'slow';
    // 每卷章數／字數閾值（邊抓邊上傳，控制記憶體與斷點損失）
    const VOLUME_CHAPTERS = 200;
    const VOLUME_CHARS = 900000;
    // 斷點續傳：依「站點:書id」命名空間
    const resumeKey = () => 'nr_resume_' + (bookCtx ? bookCtx.bookKey : hostname + ':');

    // 抓取頁面：同源用 fetch（帶完整 cookie），跨域用 GM_xmlhttpRequest（arraybuffer 解碼 GBK/UTF-8）
    // 遇到 429 時指數退避重試（30s/60s/120s），避免被封鎖後整本失敗
    async function fetchPage(url, onLog) {
        const MAX_ATTEMPTS = 4; // 首次 + 3 次重試，共 4 次請求
        const sameOrigin = (() => { try { return new URL(url).origin === location.origin; } catch (e) { return false; } })();
        let lastErr;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            let status, buf;
            try {
                if (sameOrigin) {
                    const res = await fetch(url, { credentials: 'include' });
                    status = res.status;
                    if (status === 200) buf = await res.arrayBuffer();
                } else {
                    const res = await gmRequest({ method: 'GET', url, headers: { 'Accept': 'text/html' }, responseType: 'arraybuffer' });
                    status = res.status;
                    if (status === 200) buf = res.raw;
                }
            } catch (e) {
                lastErr = e;
                if (attempt === MAX_ATTEMPTS - 1) break;
                await sleep(2000 * (attempt + 1));
                continue;
            }
            if (status === 429) {
                if (attempt === MAX_ATTEMPTS - 1) { lastErr = new Error('HTTP 429'); break; }
                const wait = 30000 * Math.pow(2, attempt); // 30s / 60s / 120s（最後一次不再空等）
                if (onLog) onLog('⚠ HTTP 429 被限流，等待 ' + Math.round(wait / 1000) + ' 秒後重試…');
                await sleep(wait);
                continue;
            }
            if (status !== 200) {
                lastErr = new Error('HTTP ' + status);
                if (attempt === MAX_ATTEMPTS - 1) break;
                await sleep(2000 * (attempt + 1));
                continue;
            }
            // 解碼：先 UTF-8，出現大量替換字元（\ufffd）時改用 GBK
            let text;
            try {
                text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
                if (/[\ufffd]{3,}/.test(text)) text = new TextDecoder('gbk', { fatal: false }).decode(buf);
            } catch (e) {
                text = new TextDecoder('utf-8').decode(buf);
            }
            return { text, url };
        }
        throw lastErr || new Error('HTTP 429 重試仍失敗，可能被暫時封鎖，請稍後再試');
    }

    // 跨域（Cognito / api.readmoo.com / S3 / 小說站）用 GM_xmlhttpRequest
    function gmRequest(opt) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: opt.method || 'GET',
                url: opt.url,
                headers: opt.headers || {},
                data: opt.data,
                binary: !!opt.binary,
                responseType: opt.responseType,
                timeout: opt.timeout || 60000,
                onload: (r) => resolve({ status: r.status, text: r.responseText, raw: r.response, finalUrl: r.finalUrl }),
                onerror: (e) => reject(new Error('GM 請求失敗（可能是跨域授權被拒，請在 Tampermonkey 彈窗中點「允許」）')),
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
    // Cognito 前有 AWS WAF，缺 Origin/Referer 會被判定為 bot 而回 ForbiddenException（WAF block）
    const COGNITO_HEADERS = {
        'Origin': 'https://next.readmoo.com',
        'Referer': 'https://next.readmoo.com/',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    };

    const sha256Hex = (s) => CryptoJS.SHA256(s).toString(CryptoJS.enc.Hex); // 對字串做 UTF-8 的 SHA256
    const hexHash = (hexStr) => CryptoJS.SHA256(CryptoJS.enc.Hex.parse(hexStr)).toString(CryptoJS.enc.Hex); // 先 hex 解碼再 SHA256
    const hexBigInt = (h) => BigInt('0x' + h);
    // Java BigInteger.toByteArray() 相容的 two's-complement 編碼：偶數長度 + MSB 置位時加 "00" 前綴
    const padHex = (v) => {
        let hex = v.toString(16);
        if (hex.length % 2 !== 0) hex = '0' + hex;
        if (/^[89a-f]/i.test(hex)) hex = '00' + hex;
        return hex;
    };

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

    // Cognito 的 HKDF：PRK = HMAC-SHA256(key=salt=u, msg=ikm=S)；輸出 = HMAC-SHA256(key=PRK, msg="Caldera Derived Key"+0x01) 取前 16 bytes
    function computeHkdf(S, u) {
        const ikmWA = CryptoJS.enc.Hex.parse(padHex(S));      // ikm = S
        const saltWA = CryptoJS.enc.Hex.parse(padHex(u));     // salt = u
        const prk = CryptoJS.HmacSHA256(ikmWA, saltWA);       // HMAC(key=salt, message=ikm)
        const infoWA = CryptoJS.enc.Utf8.parse('Caldera Derived Key').concat(CryptoJS.enc.Hex.parse('01'));
        const full = CryptoJS.HmacSHA256(infoWA, prk);        // HMAC(key=prk, message=info)
        return CryptoJS.lib.WordArray.create(full.words.slice(0, 4), 16); // 前 16 bytes
    }

    // Cognito 的 TIMESTAMP 需 Java Date.toString() 格式（EEE MMM d HH:mm:ss UTC yyyy，英文）
    function srpTimestamp() {
        const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return weekDays[d.getUTCDay()] + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCDate() + ' ' +
            pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' UTC ' + d.getUTCFullYear();
    }

    async function cognitoLogin(username, password, log) {
        const a = randomBigInt(128);
        const A = modPow(SRP_g, a, SRP_N);

        // 1) InitiateAuth USER_SRP_AUTH
        const init = await gmRequest({
            method: 'POST',
            url: COGNITO_URL,
            headers: {
                'Content-Type': 'application/x-amz-json-1.1',
                'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
                ...COGNITO_HEADERS,
            },
            data: JSON.stringify({
                AuthFlow: 'USER_SRP_AUTH',
                ClientId: CLIENT_ID,
                AuthParameters: { USERNAME: username, SRP_A: A.toString(16) },
            }),
        });
        let j = JSON.parse(init.text || '{}');
        if (j.__type) throw new Error(j.__type + (j.message ? '：' + j.message : ''));
        if (j.ChallengeName !== 'PASSWORD_VERIFIER') throw new Error('挑戰類型異常：' + (j.ChallengeName || '(無)'));
        if (log) log('InitiateAuth 回應欄位：' + Object.keys(j).join(', '));

        const p = j.ChallengeParameters || {};
        const salt = hexBigInt(p.SALT || '0');            // SALT 為 hex，轉 BigInt
        const B = hexBigInt(p.SRP_B || '0');
        const secretBlock = p.SECRET_BLOCK || '';
        const userIdForSrp = p.USER_ID_FOR_SRP || username;
        const session = j.Session || '';
        if (log) log('Session 長度：' + session.length + (session ? '（' + session.slice(0, 8) + '…）' : '（空）'));
        const poolName = POOL_ID.split('_')[1];

        // 2) SRP-6a 計算（完全對照 amazon-cognito-identity-js）
        const usernamePasswordHash = sha256Hex(poolName + userIdForSrp + ':' + password);
        const x = hexBigInt(hexHash(padHex(salt) + usernamePasswordHash));
        const k = hexBigInt(hexHash(padHex(SRP_N) + padHex(SRP_g)));
        const u = hexBigInt(hexHash(padHex(A) + padHex(B)));
        const gPowX = modPow(SRP_g, x, SRP_N);
        const base = ((B - k * gPowX) % SRP_N + SRP_N) % SRP_N;
        const S = modPow(base, a + u * x, SRP_N);

        // 3) HKDF(S, u) → 16 bytes key；claim = HMAC-SHA256(key, poolName+userIdForSrp+secretBlock+timestamp)
        const hkdfKey = computeHkdf(S, u);
        const dateNow = srpTimestamp();
        const claimData = CryptoJS.enc.Utf8.parse(poolName)
            .concat(CryptoJS.enc.Utf8.parse(userIdForSrp))
            .concat(CryptoJS.enc.Base64.parse(secretBlock))
            .concat(CryptoJS.enc.Utf8.parse(dateNow));
        const claim = CryptoJS.HmacSHA256(claimData, hkdfKey).toString(CryptoJS.enc.Base64);

        // 4) RespondToAuthChallenge
        const resp = await gmRequest({
            method: 'POST',
            url: COGNITO_URL,
            headers: {
                'Content-Type': 'application/x-amz-json-1.1',
                'X-Amz-Target': 'AWSCognitoIdentityProviderService.RespondToAuthChallenge',
                ...COGNITO_HEADERS,
            },
            data: JSON.stringify({
                ChallengeName: 'PASSWORD_VERIFIER',
                ClientId: CLIENT_ID,
                ChallengeResponses: {
                    USERNAME: userIdForSrp,
                    PASSWORD_CLAIM_SECRET_BLOCK: secretBlock,
                    PASSWORD_CLAIM_SIGNATURE: claim,
                    TIMESTAMP: dateNow,
                },
                Session: session || undefined,
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

    function buildEpub(title, author, chapters, volumeLabel) {
        const bookTitle = volumeLabel ? title + ' ' + volumeLabel : title;
        const uid = _uuid();
        const u8 = (s) => fflate.strToU8(s);
        const files = {};
        // mimetype 必須 STORE（不壓縮）且為 zip 第一筆
        files['mimetype'] = [u8('application/epub+zip'), { level: 0 }];
        files['META-INF/container.xml'] = u8('<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
        files['OEBPS/styles.css'] = u8(EPUB_CSS);

        const manifest = [], spine = [], navPoints = [], navItems = [];
        chapters.forEach((ch, i) => {
            const id = 'item' + (i + 1);
            const file = 'chap_' + String(i + 1).padStart(5, '0') + '.xhtml';
            files['OEBPS/' + file] = u8(chapterXhtml(ch.title, ch.text));
            manifest.push('<item id="' + id + '" href="' + file + '" media-type="application/xhtml+xml"/>');
            spine.push('<itemref idref="' + id + '"/>');
            const t = xmlEscape(ch.title.slice(0, 80));
            navPoints.push('<navPoint id="navPoint-' + (i + 1) + '" playOrder="' + (i + 1) + '"><navLabel><text>' + t + '</text></navLabel><content src="' + file + '"/></navPoint>');
            navItems.push('<li><a href="' + file + '">' + t + '</a></li>');
        });
        manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
        manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
        manifest.push('<item id="css" href="styles.css" media-type="text/css"/>');

        files['OEBPS/content.opf'] = u8('<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:uuid:' + uid + '</dc:identifier><dc:title>' + xmlEscape(bookTitle) + '</dc:title><dc:creator>' + xmlEscape(author || '未知作者') + '</dc:creator><dc:language>zh-TW</dc:language></metadata>\n<manifest>' + manifest.join('') + '</manifest>\n<spine toc="ncx">' + spine.join('') + '</spine>\n</package>');
        files['OEBPS/toc.ncx'] = u8('<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:' + uid + '"/></head><docTitle><text>' + xmlEscape(bookTitle) + '</text></docTitle><navMap>\n' + navPoints.join('\n') + '\n</navMap></ncx>');
        files['OEBPS/nav.xhtml'] = u8('<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="UTF-8" /><title>目錄</title></head><body><nav epub:type="toc" id="toc"><h1>目錄</h1><ol>' + navItems.join('') + '</ol></nav></body></html>');

        // fflate 同步打包（無非同步調度問題），level 3 平衡速度與大小
        return fflate.zipSync(files, { level: 3 });
    }

    /* ============================ 爬整本 ============================ */
    function findNextLink(rootDoc, pageUrl) {
        const doc = rootDoc;
        if (bookCtx && bookCtx.SITE.nextLinkSelector) {
            const el = doc.querySelector(bookCtx.SITE.nextLinkSelector);
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

    // 邊抓邊打包邊上傳的流水線：每湊滿一卷立即打包上傳並釋放記憶體，
    // 期間每章保存斷點，遇到 429 退避耗盡時可從斷點接續
    async function runPipeline(opts) {
        const { token, bookTitle, chapterUrls, startUrl, doneChapters, volumeIdx, log, setPct } = opts;
        const safeTitle = bookTitle.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
        const totalEstimate = chapterUrls.length || 0;
        const estVolumes = Math.max(1, Math.ceil(totalEstimate / VOLUME_CHAPTERS));
        const rk = resumeKey();
        let volumeChapters = [];
        let volumeChars = 0;
        let volumeStartUrl = null;   // 本卷第一個尚未上傳章節的 URL（斷點回退用）
        let done = doneChapters;
        let vIdx = volumeIdx;        // 已成功上傳的卷數
        let url = startUrl;
        let lastTitle = '';
        const visited = new Set();

        const flushVolume = async () => {
            if (!volumeChapters.length) return;
            const label = '第' + (vIdx + 1) + '卷';
            const t0 = Date.now();
            log('── 打包 ' + label + '（' + volumeChapters.length + ' 章）…');
            const maxCh = volumeChapters.reduce((m, c) => Math.max(m, c.text.length), 0);
            log('  總字數 ' + volumeChars + '，最大單章 ' + maxCh + ' 字');
            setPct(Math.min(90, 60 + Math.round(vIdx / estVolumes * 30)));
            const bytes = await buildEpub(bookTitle, '', volumeChapters, label);
            log('✓ ' + label + ' 打包完成（' + (bytes.length / 1024).toFixed(0) + ' KB，耗時 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）');
            setPct(Math.min(94, 62 + Math.round((vIdx + 1) / estVolumes * 32)));
            log('  上傳 ' + label + ' …');
            const fileName = safeTitle + '_' + label + '.epub';
            const docId = await uploadDocument(token, bytes, fileName, log);
            log('✓ ' + label + ' 上傳完成（document ' + docId + '）');
            vIdx++;                      // 成功上傳後才遞增，確保斷點卷號正確
            volumeChapters = [];
            volumeChars = 0;
            volumeStartUrl = null;
        };

        // 加入一個章節片段（超長章會切分；Readmoo 單章上限 1.5 萬字）
        const pushSeg = (t, txt) => {
            volumeChapters.push({ title: t, text: txt });
            volumeChars += txt.length;
            done++;
            lastTitle = t;
        };

        while (url && done < 5000) {
            if (visited.has(url)) break;
            visited.add(url);
            if (!volumeChapters.length) volumeStartUrl = url;   // 記錄本卷開頭，供斷點回退
            let parsed;
            try {
                parsed = await fetchPage(url, log);
            } catch (e) {
                log('✗ 抓取中斷：' + (e && e.message ? e.message : e));
                // 中斷前先上傳已抓未上傳的章節，避免遺失
                try {
                    if (volumeChapters.length) {
                        log('中斷前先上傳已抓的 ' + volumeChapters.length + ' 章…');
                        await flushVolume();
                    }
                } catch (fe) {
                    log('⚠ 上傳剩餘章節也失敗：' + (fe && fe.message ? fe.message : fe));
                }
                // 斷點：nextUrl 指向「第一個未上傳章節」；done 只算已上傳
                const resumeUrl = volumeChapters.length ? (volumeStartUrl || url) : url;
                const resumeDone = done - volumeChapters.length;
                GM_setValue(rk, { bookKey: bookCtx.bookKey, nextUrl: resumeUrl, doneChapters: resumeDone, volumeIdx: vIdx });
                log('已上傳 ' + vIdx + ' 卷；斷點已保存，可再次點「開始」接續（從第 ' + (resumeDone + 1) + ' 段起）。');
                return { interrupted: true, done: resumeDone, volumeIdx: vIdx };
            }
            const doc = new DOMParser().parseFromString(parsed.text, 'text/html');
            let title = '';
            for (const sel of bookCtx.SITE.titleSelector.split(',')) {
                const el = doc.querySelector(sel.trim());
                if (el && el.textContent.trim()) { title = el.textContent.replace(/\s+/g, ' ').trim(); break; }
            }
            let content = '';
            for (const sel of bookCtx.SITE.contentSelector.split(',')) {
                const el = doc.querySelector(sel.trim());
                if (el) { const t = el.textContent.replace(/\u00a0/g, ' ').split(/\r?\n/).map(l => l.trim()).filter(Boolean).join('\n'); if (t.length > 50) { content = t; break; } }
            }
            if (content) {
                const baseTitle = title || '第 ' + (done + 1) + ' 章';
                if (content.length > 15000) {
                    const parts = [];
                    let buf = '';
                    for (const line of content.split('\n')) {
                        if (line.length > 12000) { if (buf) { parts.push(buf); buf = ''; } for (let i = 0; i < line.length; i += 12000) parts.push(line.slice(i, i + 12000)); continue; }
                        if (buf.length + line.length > 12000) { parts.push(buf); buf = ''; }
                        buf += line + '\n';
                    }
                    if (buf.trim()) parts.push(buf);
                    parts.forEach((p, i) => pushSeg(baseTitle + '（' + (i + 1) + '/' + parts.length + '）', p));
                } else {
                    pushSeg(baseTitle, content);
                }
                if (done % 5 === 0) {
                    const pct = totalEstimate ? 5 + Math.min(60, Math.round(done / totalEstimate * 60)) : Math.min(60, 5 + Math.round(done / 100));
                    setPct(pct);
                    log('已抓 ' + done + (totalEstimate ? '/' + totalEstimate : '') + ' 章（最新：' + lastTitle + '）');
                }
            } else {
                log('⚠ 解析不到正文，跳過：' + url);
            }
            if (volumeChapters.length >= VOLUME_CHAPTERS || volumeChars >= VOLUME_CHARS) {
                try {
                    await flushVolume();
                } catch (fe) {
                    log('✗ 上傳失敗：' + (fe && fe.message ? fe.message : fe));
                    GM_setValue(rk, { bookKey: bookCtx.bookKey, nextUrl: volumeChapters.length ? (volumeStartUrl || url) : url, doneChapters: done - volumeChapters.length, volumeIdx: vIdx });
                    log('斷點已保存（從第 ' + (done - volumeChapters.length + 1) + ' 段起），可再次點「開始」接續。');
                    return { interrupted: true, done: done - volumeChapters.length, volumeIdx: vIdx };
                }
            }
            const next = findNextLink(doc, parsed.url);
            if (!next) break;
            url = norm(next, parsed.url);
            if (!sameBook(url)) { log('下一章指向其他書/站，停止'); break; }
            // 斷點：nextUrl 指向「第一個未上傳章節」，done 只算已上傳
            GM_setValue(rk, { bookKey: bookCtx.bookKey, nextUrl: volumeChapters.length ? (volumeStartUrl || url) : url, doneChapters: done - volumeChapters.length, volumeIdx: vIdx });
            const sp = SPEED_PRESETS[currentSpeed] || SPEED_PRESETS.slow;
            await sleep(sp.delay + Math.random() * sp.jitter);
        }
        const hitLimit = done >= 5000;
        try {
            await flushVolume();
        } catch (fe) {
            log('✗ 上傳失敗：' + (fe && fe.message ? fe.message : fe));
            if (volumeChapters.length) {
                GM_setValue(rk, { bookKey: bookCtx.bookKey, nextUrl: volumeStartUrl || url, doneChapters: done - volumeChapters.length, volumeIdx: vIdx });
                log('斷點已保存（從第 ' + (done - volumeChapters.length + 1) + ' 段起），可再次點「開始」接續。');
                return { interrupted: true, done: done - volumeChapters.length, volumeIdx: vIdx };
            }
            throw fe;
        }
        GM_setValue(rk, null);
        return { interrupted: false, done, volumeIdx: vIdx, hitLimit };
    }

    /* ============================ 搜尋小說 ============================ */
    // 從文字中猜字數（如「字数：1,366,186」或「123.4万字」，含逗號千分位與小數）
    function pickWordCount(text) {
        const m = text.match(/(?:字数|字數|全文字数|總字數)[:：]?\s*([\d,]+(?:\.\d+)?\s*[萬万]?)/i) || text.match(/([\d,]+(?:\.\d+)?\s*[萬万]字)/);
        return m ? m[1].replace(/[\s,]/g, '') : '';
    }

    // 通用：從搜索結果 HTML 解析書籍連結（bookRe 匹配書根網址）
    function extractBookLinks(doc, baseUrl, bookRe, siteName) {
        const results = [];
        const seen = new Set();
        const container = doc.querySelector('#sitembox, .newbox, .search-list, .result-list');
        const links = container ? container.querySelectorAll('a[href]') : doc.querySelectorAll('a[href]');
        links.forEach(a => {
            const href = a.getAttribute('href') || '';
            const abs = norm(href, baseUrl);
            if (!bookRe.test(abs)) return;
            const key = abs.replace(/\/$/, '');
            if (seen.has(key)) return;
            seen.add(key);
            let title = (a.textContent || '').replace(/\s+/g, ' ').trim();
            if (!title) title = (a.getAttribute('title') || '').trim();
            if (!title) return;
            const ctx = ((a.closest('li, tr, div'))?.textContent || '').replace(/\s+/g, ' ');
            results.push({ title: title.slice(0, 60), bookUrl: abs, note: pickWordCount(ctx), siteName });
        });
        return results.slice(0, 20);
    }

    // 通用：搜尋站點（GET，多候選端點），偵測精確匹配（302→詳情頁）直接回傳該書
    async function searchSite(q, cfg) {
        const urls = cfg.searchUrls(q);
        let lastErr;
        for (const url of urls) {
            try {
                const res = await gmRequest({ method: 'GET', url, headers: { 'Accept': 'text/html' } });
                if (res.status !== 200) { lastErr = new Error('HTTP ' + res.status); continue; }
                const doc = new DOMParser().parseFromString(res.text, 'text/html');
                const h1Title = (doc.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim();
                // 精確匹配偵測：finalUrl → canonical/og:url → 「單一 bookId + 章節目錄」
                let bookIdMatch = (res.finalUrl || '').match(cfg.bookRe);
                if (!bookIdMatch) {
                    const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href')
                        || doc.querySelector('meta[property="og:url"]')?.getAttribute('content') || '';
                    bookIdMatch = canonical.match(cfg.bookRe);
                }
                if (!bookIdMatch && h1Title) {
                    const ids = new Set();
                    let chapterCount = 0;
                    doc.querySelectorAll('a[href]').forEach(a => {
                        const abs = norm(a.getAttribute('href') || '', url);
                        const m = abs.match(cfg.bookRe);
                        if (!m) return;
                        ids.add(m[1]);
                        if (new RegExp('/' + m[1] + '/\\d+').test(abs)) chapterCount++;
                    });
                    if (ids.size === 1 && chapterCount >= 3) bookIdMatch = [cfg.prefix + [...ids][0], [...ids][0]];
                }
                if (bookIdMatch && h1Title) {
                    const ctx = (doc.querySelector('.jieshao_content, dd.jieshao_content, .bookintro')?.textContent || doc.body?.textContent || '').replace(/\s+/g, ' ');
                    // bookUrl 從匹配到的子串（含前綴，如 /book/123）原樣重建，避免 prefix 硬編錯誤
                    let bookUrl = cfg.origin + bookIdMatch[0].replace(/\/+$/, '') + '/';
                    const finalOrCanonical = res.finalUrl || (doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || '');
                    const rootMatch = finalOrCanonical.match(/^(https?:\/\/[^/]+\/(?:book|txt)\/\d+\/)/i);
                    if (rootMatch) bookUrl = rootMatch[1];
                    return [{ title: h1Title.slice(0, 60), bookUrl, note: pickWordCount(ctx), siteName: cfg.name }];
                }
                const list = extractBookLinks(doc, url, cfg.listBookRe, cfg.name);
                if (list.length) return list;
                lastErr = new Error('無結果');
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr || new Error(cfg.name + ' 搜尋失敗');
    }

    // 支援的搜尋站點（69shu 家族域名已失效，暫不納入）
    const SEARCH_SITES = [
        { name: 'uukanshu.cc', origin: 'https://uukanshu.cc', prefix: '/book/', bookRe: /\/book\/(\d+)/i, listBookRe: /\/book\/(\d+)\/?$/i, searchUrls: (q) => ['https://uukanshu.cc/search?searchkey=' + encodeURIComponent(q)] },
        { name: 'twkan.com', origin: 'https://twkan.com', prefix: '/txt/', bookRe: /\/txt\/(\d+)/i, listBookRe: /\/txt\/(\d+)\/?$/i, searchUrls: (q) => [
            'https://twkan.com/search?searchkey=' + encodeURIComponent(q),
            'https://twkan.com/search?q=' + encodeURIComponent(q),
            'https://twkan.com/modules/article/search.php?searchkey=' + encodeURIComponent(q),
        ] },
    ];

    async function searchAll(q) {
        const results = await Promise.allSettled(SEARCH_SITES.map(s => searchSite(q, s)));
        const merged = [];
        const errors = [];
        results.forEach((r, i) => {
            if (r.status === 'fulfilled') merged.push(...r.value);
            else errors.push(SEARCH_SITES[i].name);
        });
        if (!merged.length && errors.length) throw new Error('搜尋失敗（' + errors.join('、') + ' 無回應）');
        return merged;
    }

    /* ============================ UI 面板 ============================ */
    function injectUi(onStart) {
        if (document.getElementById('nr-panel')) return;
        const host = document.createElement('div');
        host.id = 'nr-panel';
        host.innerHTML = `
        <style>
          #nr-panel .nr-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#f59e0b;color:#0f172a;font:bold 13px/1 system-ui,sans-serif;padding:10px 14px;border-radius:10px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}
          #nr-panel .nr-box{position:fixed;right:18px;bottom:64px;z-index:2147483000;width:340px;max-width:92vw;max-height:80vh;overflow:auto;background:#0b0f1a;color:#e2e8f0;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:14px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5);display:none}
          #nr-panel .nr-box.open{display:block}
          #nr-panel input{width:100%;box-sizing:border-box;background:#151b2b;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:8px 10px;color:#fff;font-size:13px;margin:4px 0}
          #nr-panel button{background:#f59e0b;color:#0f172a;border:0;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;font-size:13px}
          #nr-panel .nr-log{max-height:180px;overflow:auto;background:#00000055;border-radius:8px;padding:8px;margin-top:8px;font:11px/1.5 monospace;color:#94a3b8;white-space:pre-wrap}
          #nr-panel .nr-bar{height:6px;background:#1e293b;border-radius:3px;overflow:hidden;margin-top:8px}
          #nr-panel .nr-fill{height:100%;background:#f59e0b;width:0;transition:width .3s}
          #nr-panel .nr-search-item{display:block;padding:8px 10px;border-radius:8px;background:#151b2b;margin:4px 0;cursor:pointer;color:#e2e8f0}
          #nr-panel .nr-search-item:hover{background:#1e293b}
          #nr-panel .nr-search-item .t{font-weight:600}
          #nr-panel .nr-search-item .m{font-size:11px;color:#94a3b8;margin-top:2px}
        </style>
        <div class="nr-fab">${canCrawl ? '📤 傳書到 Readmoo' : '🔍 搜尋小說'}</div>
        <div class="nr-box">
          <div style="font-weight:700;margin-bottom:6px">🔍 搜尋小說（多站）</div>
          <div style="display:flex;gap:6px">
            <input id="nr-search-q" placeholder="輸入小說名…" style="flex:1;margin:0">
            <button id="nr-search-btn" style="white-space:nowrap">搜尋</button>
          </div>
          <div id="nr-search-results" style="margin-top:8px"></div>
          <div id="nr-crawl" style="${canCrawl ? '' : 'display:none'}">
            <div style="font-weight:700;margin:12px 0 6px">📤 傳書到 Readmoo（mooInk）</div>
            <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">抓取整本 → 打包 EPUB → 上傳到你的書櫃。帳密只在本地使用，不上傳到任何伺服器。</div>
            <input id="nr-email" type="email" placeholder="Readmoo 帳號（Email）" autocomplete="username">
            <input id="nr-pass" type="password" placeholder="Readmoo 密碼" autocomplete="current-password">
            <label style="font-size:11px;color:#94a3b8;display:flex;gap:6px;align-items:center"><input id="nr-remember" type="checkbox" style="width:auto"> 記住帳號（密碼不儲存）</label>
            <label style="font-size:11px;color:#94a3b8;display:flex;gap:6px;align-items:center;margin:4px 0">
              <span>抓取速度</span>
              <select id="nr-speed" style="flex:1;background:#151b2b;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:6px 8px;color:#fff;font-size:12px">
                <option value="slow">慢（最穩，約 2.5~3.5 秒/章）</option>
                <option value="medium">中（約 1.2~1.7 秒/章）</option>
                <option value="fast">快（約 0.5~0.8 秒/章，易被限流）</option>
              </select>
            </label>
            <label style="font-size:11px;color:#94a3b8;display:flex;gap:6px;align-items:center"><input id="nr-fresh" type="checkbox" style="width:auto"> 重新開始（忽略上次斷點）</label>
            <div id="nr-resume-info" style="font-size:11px;color:#fbbf24;margin:4px 0;display:none"></div>
            <div style="margin-top:8px;display:flex;gap:8px">
              <button id="nr-start">開始抓取並上傳</button>
            </div>
            <div class="nr-bar"><div class="nr-fill" id="nr-fill"></div></div>
            <div class="nr-log" id="nr-log"></div>
          </div>
          <button id="nr-close" style="width:100%;margin-top:10px;background:#334155;color:#e2e8f0">關閉</button>
        </div>`;
        document.body.appendChild(host);
        const fab = host.querySelector('.nr-fab');
        const box = host.querySelector('.nr-box');
        fab.onclick = () => box.classList.toggle('open');
        host.querySelector('#nr-close').onclick = () => box.classList.remove('open');

        // 搜尋邏輯
        const resultsEl = host.querySelector('#nr-search-results');
        let searching = false;
        const doSearch = async () => {
            if (searching) return;
            const q = host.querySelector('#nr-search-q').value.trim();
            if (!q) { alert('請輸入小說名'); return; }
            searching = true;
            resultsEl.textContent = '搜尋中…';
            let results;
            try {
                results = await searchAll(q);
            } catch (e) {
                resultsEl.textContent = '搜尋失敗：' + (e && e.message ? e.message : e);
                searching = false;
                return;
            }
            if (!results.length) {
                resultsEl.textContent = '找不到結果，換個關鍵字試試。';
                searching = false;
                return;
            }
            resultsEl.innerHTML = '';
            results.forEach(r => {
                const item = document.createElement('div');
                item.className = 'nr-search-item';
                // 第一行：書名（左）+ 字數（右）
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px';
                const t = document.createElement('div');
                t.className = 't';
                t.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
                t.textContent = r.title;
                const wc = document.createElement('div');
                wc.style.cssText = 'font-size:11px;color:#fbbf24;white-space:nowrap;font-weight:600';
                wc.textContent = r.note ? r.note + '字' : '';
                row.appendChild(t);
                row.appendChild(wc);
                // 第二行：平台 + 提示
                const m = document.createElement('div');
                m.className = 'm';
                m.textContent = r.siteName + ' · 點擊後在本面板直接抓取上傳';
                item.appendChild(row);
                item.appendChild(m);
                item.onclick = () => {
                    // 原地抓取：設定 bookCtx，顯示抓取區塊，不跳轉
                    const bid = (r.bookUrl.match(/\/(?:book|txt)\/(\d+)/i) || [])[1] || '';
                    const bookHost = (() => { try { return new URL(r.bookUrl).hostname.replace(/^www\./, ''); } catch (e) { return 'uukanshu.cc'; } })();
                    let site = SITES[bookHost];
                    if (!site) {
                        const pm = r.bookUrl.match(/\/(book|txt)\//i);
                        const prefix = '/' + (pm ? pm[1] : 'book') + '/';
                        site = {
                            bookIdRe: new RegExp('^' + prefix + '(\\d+)'),
                            bookPrefix: prefix,
                            contentSelector: '#content, .txtnav, .yd_text2, #chaptercontent',
                            titleSelector: 'h1, .bookname h1, .title h1',
                            nextLinkSelector: '#next_url',
                        };
                    }
                    bookCtx = {
                        SITE: site,
                        bookId: bid,
                        bookUrl: r.bookUrl.replace(/\/?$/, '/'),
                        bookKey: bookHost + ':' + bid,
                    };
                    const crawlEl = host.querySelector('#nr-crawl');
                    if (crawlEl) crawlEl.style.display = '';
                    resultsEl.textContent = '已選：《' + r.title + '》(' + r.siteName + ')，請在下方輸入 Readmoo 帳密開始抓取。';
                };
                resultsEl.appendChild(item);
            });
            searching = false;
        };
        host.querySelector('#nr-search-btn').onclick = doSearch;
        host.querySelector('#nr-search-q').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };

        // 抓取欄位初始化
        host.querySelector('#nr-email').value = GM_getValue('nr_email', '');
        host.querySelector('#nr-remember').checked = !!GM_getValue('nr_email', '');
        host.querySelector('#nr-speed').value = GM_getValue('nr_speed', 'slow');
        // 抓取過程中改速度即時生效
        host.querySelector('#nr-speed').onchange = (e) => { currentSpeed = e.target.value; };
        // 斷點提示
        const resumeInfoEl = host.querySelector('#nr-resume-info');
        const rk = resumeKey();
        const resumeData = GM_getValue(rk, null);
        if (resumeData && resumeData.doneChapters) {
            resumeInfoEl.textContent = '⚠ 上次未完成：已抓 ' + resumeData.doneChapters + ' 章、已上傳 ' + resumeData.volumeIdx + ' 卷。可點「開始」接續。';
            resumeInfoEl.style.display = 'block';
        }
        host.querySelector('#nr-start').onclick = () => {
            const email = host.querySelector('#nr-email').value.trim();
            const pass = host.querySelector('#nr-pass').value;
            const remember = host.querySelector('#nr-remember').checked;
            const speed = host.querySelector('#nr-speed').value;
            const fresh = host.querySelector('#nr-fresh').checked;
            currentSpeed = speed;
            if (remember && email) GM_setValue('nr_email', email); else GM_setValue('nr_email', '');
            GM_setValue('nr_speed', speed);
            if (!email || !pass) { alert('請輸入 Readmoo 帳號密碼'); return; }
            onStart(email, pass, speed, fresh, host);
        };
        return host;
    }

    /* ============================ 主流程 ============================ */
    injectUi(async (email, password, speed, fresh, host) => {
        if (!bookCtx) { alert('請先搜尋並選擇一本小說，或在章節頁開啟本腳本'); return; }
        const logEl = host.querySelector('#nr-log');
        const fillEl = host.querySelector('#nr-fill');
        const startBtn = host.querySelector('#nr-start');
        startBtn.disabled = true;
        const log = (m) => { logEl.textContent += '[' + new Date().toLocaleTimeString('zh-TW', { hour12: false }) + '] ' + m + '\n'; logEl.scrollTop = logEl.scrollHeight; };
        const setPct = (p) => { fillEl.style.width = Math.min(100, p) + '%'; };
        currentSpeed = speed;

        try {
            // 1) 登入（先登入，因為要邊抓邊打包邊上傳）
            log('登入 Readmoo…');
            setPct(1);
            const token = await cognitoLogin(email, password, log);
            log('✓ 登入成功');

            // 2) 找第一章：抓書籍頁，取數值最小的章節連結
            log('尋找書籍目錄…');
            setPct(2);
            const bookUrl = bookCtx.bookUrl;
            const { text: bookText } = await fetchPage(bookUrl, log);
            const bdoc = new DOMParser().parseFromString(bookText, 'text/html');
            let bookTitle = (bdoc.querySelector('h1')?.textContent || document.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim();
            if (!bookTitle) bookTitle = bookCtx.bookId;
            const chapterNo = (u) => { const m = u.match(/\/(\d+)[^\d/]*(?:[#?].*)?$/); return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER; };
            let links = new Set();
            bdoc.querySelectorAll('a[href]').forEach(a => { const h = a.getAttribute('href'); if (!h) return; const abs = norm(h, bookUrl); if (sameBook(abs)) links.add(abs); });
            let chapterUrls = [...links].sort((a, b) => chapterNo(a) - chapterNo(b));
            if (!chapterUrls.length) throw new Error('書籍頁找不到章節連結，請在「章節列表頁」開啟本腳本');
            log('書名：' + bookTitle + '，共偵測 ' + chapterUrls.length + ' 章');

            // 3) 斷點續傳檢查
            const rk = resumeKey();
            const resume = GM_getValue(rk, null);
            let startUrl = chapterUrls[0];
            let doneChapters = 0;
            let volumeIdx = 0;
            if (!fresh && resume && resume.bookKey === bookCtx.bookKey && resume.nextUrl) {
                startUrl = resume.nextUrl;
                doneChapters = resume.doneChapters;
                volumeIdx = resume.volumeIdx;
                log('⚠ 從上次斷點接續：第 ' + (doneChapters + 1) + ' 段起（已上傳 ' + volumeIdx + ' 卷）');
            } else if (fresh && resume && resume.bookKey === bookCtx.bookKey && resume.volumeIdx > 0) {
                log('⚠ 已勾選重新開始，將重新上傳，書櫃可能出現同名重複文件。');
            }

            // 4) 邊抓邊打包邊上傳
            log('開始抓取（每 ' + VOLUME_CHAPTERS + ' 章打包上傳一卷）…');
            setPct(3);
            const result = await runPipeline({ token, bookTitle, chapterUrls, startUrl, doneChapters, volumeIdx, log, setPct });
            setPct(100);
            if (!result.interrupted) {
                if (result.hitLimit) {
                    log('⚠ 已達 5000 段上限，剩餘章節未抓；已抓 ' + result.done + ' 段、上傳 ' + result.volumeIdx + ' 卷。');
                } else {
                    log('🎉 全部完成！共 ' + result.done + ' 段、' + result.volumeIdx + ' 卷。回到 mooInk 按「同步」即可看到。');
                }
            }
        } catch (e) {
            log('✗ 失敗：' + (e && e.message ? e.message : e));
        } finally {
            startBtn.disabled = false;
        }
    });
})();
