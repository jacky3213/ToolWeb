/**
 * Readmoo 小說自動導入模組
 *
 * 流程：搜尋小說 → 選書 → 輸入 Readmoo 帳密 → 後台逐章爬取 → 打包 EPUB 分卷 → 上傳網頁書櫃
 *
 * 安全約定：
 *  - 使用者輸入的 email / password 僅存在於物件記憶體中，不寫入任何檔案、不打進 log
 *  - job 序列化給前端時，一律透過 publicJob() 剝除敏感欄位
 */

import path from 'path';
import fs from 'fs';
import dns from 'dns';
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import JSZip from 'jszip';
import iconv from 'iconv-lite';

const DATA_DIR = path.join(process.cwd(), 'data');
const READMO_DIR = path.join(DATA_DIR, 'readmo');
const UPLOAD_CFG_FILE = path.join(DATA_DIR, 'readmoo-upload.json');

if (!fs.existsSync(READMO_DIR)) fs.mkdirSync(READMO_DIR, { recursive: true });

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ============================ 基礎 HTTP 工具 ============================ */

export type CookieJar = Map<string, string>;

function newJar(): CookieJar {
  return new Map<string, string>();
}

function absorbCookies(res: Response, jar: CookieJar) {
  const raw =
    (typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : []) as string[];
  const fallback = res.headers.get('set-cookie');
  const list = raw.length ? raw : fallback ? [fallback] : [];
  for (const entry of list) {
    const pair = String(entry).split(';')[0];
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === '' || /^deleted$/i.test(value)) {
      jar.delete(name);
      continue;
    }
    jar.set(name, value);
  }
}

function cookieHeader(jar: CookieJar): string {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

interface FetchOpts {
  jar?: CookieJar;
  headers?: Record<string, string>;
  method?: string;
  body?: string | Buffer | Uint8Array;
  timeout?: number;
  noFollow?: boolean;
  referer?: string;
}

async function httpReq(url: string, opts: FetchOpts = {}) {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8',
    ...(opts.headers || {}),
  };
  if (opts.referer) headers['Referer'] = opts.referer;
  if (opts.jar && opts.jar.size) headers['Cookie'] = cookieHeader(opts.jar);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? 20000);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body as any,
      redirect: opts.noFollow ? 'manual' : 'follow',
      signal: controller.signal,
    });
    if (opts.jar) absorbCookies(res, opts.jar);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(res: Response, encoding?: string): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  if (encoding && /^gb/i.test(encoding)) {
    try {
      return iconv.decode(buf, 'gb18030');
    } catch {
      /* 退回 utf8 */
    }
  }
  // 依 charset meta 自動偵測
  const head = buf.slice(0, 2048).toString('latin1');
  const m = head.match(/charset=["']?([\w-]+)/i);
  const cs = (m && m[1]) ? m[1].toLowerCase() : '';
  if (cs.startsWith('gb')) {
    try {
      return iconv.decode(buf, 'gb18030');
    } catch {
      /* ignore */
    }
  }
  return buf.toString('utf8');
}

/** 正規化網址：去掉 hash 與追蹤用 query，作為「是否已看過」的鍵 */
function canonicalUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return u;
  }
}

function absoluteUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ============================ 安全防護：SSRF -------------------------------- */

/** 展開壓縮的 IPv6（::）為 8 組完整形式，供範圍比對 */
function expandIpv6(ip: string): string {
  if (ip === '::1') return '0:0:0:0:0:0:0:1';
  if (ip === '::') return '0:0:0:0:0:0:0:0';
  const halves = ip.split('::');
  if (halves.length === 1) return ip;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const zeros = new Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0');
  return [...left, ...zeros, ...right].map((s) => s || '0').join(':');
}

function isPrivateIp(ip: string): boolean {
  let v = ip.trim();
  // URL.hostname 對 IPv6 會帶方括號（如 [::1]），先去掉
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  v = v.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7)); // IPv4-mapped
  if (v.includes(':')) {
    const full = expandIpv6(v);
    if (full === '0:0:0:0:0:0:0:1') return true; // loopback ::1（含全展開形式）
    if (full === '0:0:0:0:0:0:0:0') return true; // unspecified ::
    if (/^fe80(:|$)/.test(full)) return true; // link-local fe80::/10
    if (/^f[cd][0-9a-f]/.test(full)) return true; // ULA fc00::/7
    return false;
  }
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 0 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * 阻擋 SSRF：使用者提供的網址若解析到內部網路（127.0.0.1、192.168.x、10.x、雲端 metadata
 * 169.254.169.254 等）一律拒絕，避免這台伺服器被當成打內網的跳板。
 */
export async function assertSafeUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('網址格式不正確');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('只允許 http / https 網址');
  }
  if (rawUrl.length > 2048) throw new Error('網址過長');
  if (u.username || u.password) throw new Error('網址不得包含帳號資訊');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('不允許非標準埠');
  const host = u.hostname;
  // 內部網路慣用網域名稱
  if (/(^|\.)(local|localhost|internal|intranet|lan|home\.arpa)$/i.test(host)) {
    throw new Error('拒絕處理：內部網路位址');
  }
  if (isPrivateIp(host)) throw new Error('拒絕處理：內部網路位址');
  try {
    const addrs = await lookupCached(host);
    if (addrs.some((a) => isPrivateIp(a.address))) {
      throw new Error('拒絕處理：此網域解析到內部網路位址');
    }
  } catch (e: any) {
    if (String(e?.message || '').startsWith('拒絕')) throw e;
    throw new Error('拒絕處理：無法解析此網域');
  }
}

/** DNS 結果快取 60 秒，避免每章都查一次 DNS */
const dnsCache = new Map<string, { at: number; addrs: { address: string }[] }>();
async function lookupCached(host: string): Promise<{ address: string }[]> {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.addrs;
  const addrs = (await dns.promises.lookup(host, { all: true })) as unknown as { address: string }[];
  dnsCache.set(host, { at: Date.now(), addrs });
  return addrs;
}

/**
 * 安全的 HTTP 請求：手動跟隨跳轉，每個目標都先做 SSRF 檢查，
 * 避免惡意網站用 302 把伺服器帶去 169.254.169.254（雲端 metadata）或內網。
 */
async function safeHttpReq(url: string, opts: FetchOpts = {}): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertSafeUrl(current);
    const res = await httpReq(current, { ...opts, noFollow: true });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = absoluteUrl(loc, current);
      continue;
    }
    return res;
  }
  throw new Error('重新導向次數過多');
}

/* ============================ 安全防護：速率限制 ---------------------------- */

interface RateBucket {
  count: number;
  resetAt: number;
}
const rateBuckets = new Map<string, RateBucket>();

/** 滑動視窗速率限制；超過限制回傳 false 與建議重試秒數 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  if (rateBuckets.size > 5000) {
    // 避免 map 無限增長
    for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
  }
  const b = rateBuckets.get(key);
  if (!b || b.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  b.count += 1;
  if (b.count > limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfterSec: 0 };
}

/** 取用戶端 IP（信任 Cloud Run / AI Studio 的反向代理） */
export function clientIp(req: { ip?: string; headers?: any; socket?: any }): string {
  // Cloud Run 等反向代理會把真實客戶端 IP append 在 X-Forwarded-For「最右」，
  // 取最右避免攻擊者偽造最左值繞過限流
  const xff = req.headers?.['x-forwarded-for'];
  const list = String(Array.isArray(xff) ? xff.join(',') : xff || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const right = list[list.length - 1];
  if (right) return right;
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

/* ============================ 站點適配器 ============================ */

export interface SearchResult {
  siteId: string;
  siteName: string;
  title: string;
  author?: string;
  bookUrl: string;
  latest?: string;
  note?: string;
}

export interface BookInfo {
  title: string;
  author?: string;
  siteName: string;
  bookUrl: string;
  wordCountText?: string;
  chapterCount?: number;
  firstChapterUrl?: string;
  intro?: string;
}

interface SiteAdapter {
  id: string;
  name: string;
  hosts: string[];
  bookRe: RegExp;
  chapterRe: RegExp;
  contentSelectors: string[];
  titleSelectors: string[];
  nextSelector: string;
  nextText: string[];
  search(q: string): Promise<SearchResult[]>;
}

function normalizeAuthor(s: string): string | undefined {
  if (!s) return undefined;
  const m = s.replace(/\s+/g, ' ').match(/(?:作者|著者)[:：]?\s*([^\s,，、|]{1,20})/);
  return m ? m[1] : undefined;
}

function pickWordCount(text: string): string | undefined {
  const patterns = [
    /(?:总字数|總字數|字数|字數|全文字数)[:：]?\s*([\d.]+\s*[萬万]?\s*字?)/i,
    /([\d.]+\s*[萬万]字)/,
    /([\d,]{4,})\s*字/,
  ];
  for (const p of patterns) {
    const m = text.replace(/\s+/g, ' ').match(p);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
  }
  return undefined;
}

/** 通用：從搜尋結果頁 / 書籍頁抽出符合書籍網址規則的連結 */
function extractBookLinks(
  html: string,
  base: string,
  bookRe: RegExp,
  site: SiteAdapter,
): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const url = absoluteUrl(href, base);
    if (!bookRe.test(url)) return;
    const key = url.replace(/\/$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    let title = ($(el).text() || '').trim();
    if (!title) title = ($(el).attr('title') || '').trim();
    if (!title) return;
    title = title.replace(/\s+/g, ' ').slice(0, 60);
    const container = $(el).parents('li, tr, div').first();
    const ctx = container.length ? container.text().replace(/\s+/g, ' ').trim() : '';
    out.push({
      siteId: site.id,
      siteName: site.name,
      title,
      author: normalizeAuthor(ctx),
      bookUrl: url,
      note: pickWordCount(ctx),
    });
  });
  return out;
}

async function tryGet(url: string, referer?: string) {
  return safeHttpReq(url, { referer: referer || url, timeout: 20000 });
}

const SITES: SiteAdapter[] = [
  {
    id: 'uukanshu',
    name: 'UU看書 (uukanshu.cc)',
    hosts: ['uukanshu.cc', 'www.uukanshu.cc'],
    bookRe: /^https?:\/\/([\w.]*uukanshu[\w.-]*)\/book\/(\d+)/i,
    chapterRe: /^https?:\/\/([\w.]*uukanshu[\w.-]*)\/book\/(\d+)\/([^/?#]+)/i,
    contentSelectors: ['.readcotent.bbb.font-normal', '.readcotent', '#content', '#BookText'],
    titleSelectors: ['h1', '.title h1', '#timu'],
    nextSelector: '#linkNext',
    nextText: ['下一章', '下章', '下一章>', '下一页', '下一頁', 'Next'],
    async search(q: string) {
      const candidates = [
        `https://uukanshu.cc/book/search?searchkey=${encodeURIComponent(q)}`,
        `https://uukanshu.cc/search?wd=${encodeURIComponent(q)}`,
        `https://uukanshu.cc/s.php?searchkey=${encodeURIComponent(q)}`,
      ];
      for (const url of candidates) {
        try {
          const res = await tryGet(url);
          if (!res.ok) continue;
          const html = await readBody(res);
          const found = extractBookLinks(html, url, /\/book\/(\d+)\/?$/i, this);
          if (found.length) return found.slice(0, 20);
        } catch {
          /* 嘗試下一種 */
        }
      }
      return [];
    },
  },
  {
    id: 'twkan',
    name: '台灣小說網 (twkan.com)',
    hosts: ['twkan.com', 'www.twkan.com'],
    bookRe: /^https?:\/\/([\w.]*twkan[\w.-]*)\/txt\/(\d+)/i,
    chapterRe: /^https?:\/\/([\w.]*twkan[\w.-]*)\/txt\/(\d+)\/([^/?#]+)/i,
    contentSelectors: ['#txtcontent0', '#txtcontent', '.readcotent', '#content'],
    titleSelectors: ['.txtnav h1', '#container h1', 'h1'],
    nextSelector: '#linkNext',
    nextText: ['下一章', '下章', '下一页', '下一頁', 'Next'],
    async search(q: string) {
      const candidates = [
        `https://twkan.com/search?searchkey=${encodeURIComponent(q)}`,
        `https://twkan.com/search?q=${encodeURIComponent(q)}`,
        `https://twkan.com/modules/article/search.php?searchkey=${encodeURIComponent(q)}`,
      ];
      for (const url of candidates) {
        try {
          const res = await tryGet(url);
          if (!res.ok) continue;
          const html = await readBody(res);
          const found = extractBookLinks(html, url, /\/txt\/(\d+)\/?$/i, this);
          if (found.length) return found.slice(0, 20);
        } catch {
          /* next */
        }
      }
      return [];
    },
  },
  {
    id: '69shu',
    name: '69書吧 (69shuba)',
    hosts: ['www.69shuba.cx', 'www.69shuba.com', 'www.69shu.pro', '69shuba.com'],
    bookRe: /^https?:\/\/([\w.]*69(?:shuba|shu|xinshu)[\w.-]*)\/(?:book|txt)\/(\d+)/i,
    chapterRe: /^https?:\/\/([\w.]*69(?:shuba|shu|xinshu)[\w.-]*)\/(?:txt|read)\/(\d+)\/(\d+)/i,
    contentSelectors: ['#content', '.txtnav', '.yd_text2', '#chaptercontent'],
    titleSelectors: ['h1', '.bookname h1', '.title h1'],
    nextSelector: '#next_url',
    nextText: ['下一章', '下章', '下一页', '下一頁', 'Next'],
    async search(q: string) {
      const hosts = ['https://www.69shuba.cx', 'https://www.69shu.pro', 'https://www.69shuba.com'];
      for (const host of hosts) {
        try {
          const searchUrl = `${host}/modules/article/search.php`;
          const key = iconv.encode(q, 'gb18030');
          const body = `searchkey=${Array.from(key)
            .map((b) => '%' + b.toString(16).padStart(2, '0'))
            .join('')}&searchtype=all&submit=Search`;
          const res = await safeHttpReq(searchUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Origin: host,
              Referer: `${host}/modules/article/search.php`,
            },
            body,
            timeout: 20000,
          });
          if (!res.ok) continue;
          const html = await readBody(res, 'gbk');
          const found = extractBookLinks(html, searchUrl, /\/(?:book|txt)\/(\d+)/i, this);
          if (found.length) return found.slice(0, 20);
        } catch {
          /* next host */
        }
      }
      return [];
    },
  },
];

export function listSites() {
  return SITES.map((s) => ({ id: s.id, name: s.name }));
}

function siteForUrl(url: string): SiteAdapter | undefined {
  return SITES.find((s) => s.bookRe.test(url) || s.chapterRe.test(url));
}

/* ============================ 搜尋 ============================ */

export async function searchNovels(query: string): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const results = await Promise.allSettled(SITES.map((s) => s.search(q)));
  const merged: SearchResult[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') merged.push(...r.value);
    else console.warn(`[readmo] ${SITES[i].name} 搜尋失敗:`, String(r.reason).slice(0, 120));
  });
  // 去重重複書名（不同站同一本書）
  const seen = new Set<string>();
  return merged.filter((r) => {
    const k = `${r.title}|${r.author || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ============================ 書籍資訊 ============================ */

function prefetchCommonSite(url: string): SiteAdapter | undefined {
  return siteForUrl(url);
}

export async function getBookInfo(bookUrl: string): Promise<BookInfo> {
  const site = prefetchCommonSite(bookUrl);
  if (!site) throw new Error('不支援的網站，請確認網址是否為 UU看書 / 台灣小說網 / 69書吧');

  // SSRF 防護：先確認目標不是內部網路
  await assertSafeUrl(bookUrl);

  const res = await safeHttpReq(bookUrl, { referer: bookUrl, timeout: 25000 });
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? 'HTTP 403：網站拒絕連線（可能是 Cloudflare 反爬，建議改在本機執行此功能）'
        : `HTTP ${res.status}：書籍頁讀取失敗`,
    );
  }
  const html = await readBody(res);
  const $ = cheerio.load(html);

  let title = '';
  for (const sel of site.titleSelectors) {
    const t = $(sel).first().text().trim();
    if (t) {
      title = t.replace(/\s+/g, ' ');
      break;
    }
  }
  if (!title) title = ($('title').text() || '').trim();

  const pageText = $('body').text().replace(/\s+/g, ' ');
  const wordCountText = pickWordCount(pageText);

  // 找第一個章節連結（同書同站）
  const links = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href) return;
    const abs = absoluteUrl(href, bookUrl);
    if (site.chapterRe.test(abs)) links.add(abs);
  });
  // 依「章節編號」數值排序：純字串排序會把 /1000.html 排在 /200.html 前面，
  // 導致從書中間開始爬、前面章節全部漏掉
  const chapterNo = (u: string): number => {
    const m = u.match(/\/(\d+)[^\d\/]*(?:[#?].*)?$/);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  let chapterUrls = Array.from(links).sort((a, b) => chapterNo(a) - chapterNo(b));

  // 書籍頁若只列出「最新幾章」，改抓目錄頁取得完整章節清單
  if (chapterUrls.length < 50) {
    const catalogHref = $('a[href]')
      .toArray()
      .map((el) => $(el).attr('href') || '')
      .find((h) => /catalog|目录|目錄|allchapter|readlist/i.test(h));
    if (catalogHref) {
      const catalogUrl = absoluteUrl(catalogHref, bookUrl);
      try {
        await assertSafeUrl(catalogUrl);
        const catRes = await safeHttpReq(catalogUrl, { referer: bookUrl, timeout: 25000 });
        if (catRes.ok) {
          const $c = cheerio.load(await readBody(catRes));
          const catLinks = new Set<string>();
          $c('a[href]').each((_, el) => {
            const href = $c(el).attr('href') || '';
            if (!href) return;
            const abs = absoluteUrl(href, catalogUrl);
            if (site.chapterRe.test(abs)) catLinks.add(abs);
          });
          if (catLinks.size > chapterUrls.length) {
            chapterUrls = Array.from(catLinks).sort((a, b) => chapterNo(a) - chapterNo(b));
          }
        }
      } catch {
        /* 取不到目錄就用原本的清單 */
      }
    }
  }
  const firstChapterUrl = chapterUrls[0];

  let intro: string | undefined;
  const introSel = ['.intro', '#intro', '.book-intro', '.bookintro', 'meta[name="description"]'];
  for (const sel of introSel) {
    const el = $(sel).first();
    const val = el.attr('content') || el.text() || '';
    if (val && val.trim().length > 10) {
      intro = val.trim().replace(/\s+/g, ' ').slice(0, 200);
      break;
    }
  }

  return {
    title,
    author: normalizeAuthor(pageText),
    siteName: site.name,
    bookUrl,
    wordCountText,
    chapterCount: chapterUrls.length || undefined,
    firstChapterUrl,
    intro,
  };
}

/* ============================ 章節爬取 ============================ */

export interface CrawledChapter {
  title: string;
  text: string;
}

function cleanText(raw: string): string {
  return raw
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

function pickContent($: cheerio.CheerioAPI, selectors: string[]): string {
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el && el.length) {
      const t = cleanText(el.text());
      if (t.length > 50) return t;
    }
  }
  // 後備：最長文字區塊
  let best = '';
  $('div, article').each((_, el) => {
    const t = cleanText($(el).text());
    if (t.length > best.length) best = t;
  });
  return best;
}

function findNextUrl(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  site: SiteAdapter,
): string | undefined {
  const direct = $(site.nextSelector).first();
  let href = direct && direct.length ? direct.attr('href') : undefined;

  if (!href) {
    const texts = new RegExp(site.nextText.join('|'), 'i');
    let found: string | undefined;
    $('a[href]').each((_, el) => {
      if (found) return;
      const t = ($(el).text() || '').trim();
      if (texts.test(t)) found = $(el).attr('href');
    });
    href = found;
  }
  if (!href) return undefined;

  const abs = absoluteUrl(href, pageUrl);
  // 必須是同本書的章節頁
  const mThis = pageUrl.match(site.chapterRe);
  const mNext = abs.match(site.chapterRe);
  if (!mNext || !mThis) return undefined;
  if (mThis[2] !== mNext[2]) return undefined; // 不同書 → 拒絕
  if (abs === pageUrl) return undefined;
  return abs;
}

async function fetchChapter(
  url: string,
  site: SiteAdapter,
  log: (m: string) => void,
): Promise<{ title: string; text: string; next?: string }> {
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await safeHttpReq(url, { referer: url, timeout: 20000 });
      if (res.status === 403) {
        lastErr = 'HTTP 403（Cloudflare 反爬）';
        await sleep(1500 * attempt);
        continue;
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        await sleep(1200 * attempt);
        continue;
      }
      const html = await readBody(res);
      const $ = cheerio.load(html);
      let title = '';
      for (const sel of site.titleSelectors) {
        const t = $(sel).first().text().trim();
        if (t) {
          title = t.replace(/\s+/g, ' ');
          break;
        }
      }
      const text = pickContent($, site.contentSelectors);
      if (!text) {
        lastErr = '解析不到正文';
        await sleep(1200 * attempt);
        continue;
      }
      const next = findNextUrl($, url, site);
      return { title: title || '未命名章節', text, next };
    } catch (e: any) {
      lastErr = e?.name === 'AbortError' ? '逾時' : String(e?.message || e).slice(0, 80);
      await sleep(1200 * attempt);
    }
  }
  log(`  ✗ 失敗：${url}（${lastErr}）`);
  throw new Error(`章節抓取失敗：${lastErr}`);
}

export async function crawlNovel(opts: {
  firstChapterUrl: string;
  site: { id: string };
  max?: number;
  maxChars?: number;
  onProgress?: (crawled: number, lastTitle: string) => void;
  log: (m: string) => void;
}): Promise<CrawledChapter[]> {
  const site = SITES.find((s) => s.id === opts.site.id)!;
  const chapters: CrawledChapter[] = [];
  const visited = new Set<string>();
  let url: string | undefined = opts.firstChapterUrl;
  const max = opts.max ?? 5000;
  const maxChars = opts.maxChars ?? 12_000_000; // 防止長篇撐爆記憶體（約 1200 萬字）
  let totalChars = 0;
  // 只在書籍來源網域內跟隨連結，避免被頁面帶去別的地方（含內部網路）
  const allowedOrigin = (() => {
    try {
      return new URL(opts.firstChapterUrl).origin;
    } catch {
      return '';
    }
  })();

  while (url && chapters.length < max) {
    const visitKey = canonicalUrl(url);
    if (visited.has(visitKey)) break;
    visited.add(visitKey);
    const data = await fetchChapter(url, site, opts.log);
    chapters.push({ title: data.title.trim() || `第 ${chapters.length + 1} 章`, text: data.text });
    totalChars += data.text.length;
    opts.onProgress?.(chapters.length, data.title);
    if (totalChars > maxChars) {
      opts.log(`  ⚠ 已達字數上限（${maxChars}），提前結束以避免記憶體超載`);
      break;
    }
    url = data.next;
    if (!url) break;
    try {
      if (allowedOrigin && new URL(url).origin !== allowedOrigin) {
        opts.log(`  ⚠ 章節連結指向其他網域，停止跟隨：${url}`);
        break;
      }
    } catch {
      break;
    }
    // 去掉追蹤參數後若指向同一章，代表已到書末或進入循環，停止
    if (canonicalUrl(url) === visitKey) {
      opts.log('  已抵達最後一章（下一章連結指回本章）');
      break;
    }
    await sleep(1100); // 節流，避免被封
  }
  return chapters;
}

/* ============================ EPUB 打包 ============================ */

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function chapterXhtml(title: string, body: string): string {
  const paragraphs = body
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<p>${xmlEscape(l)}</p>`)
    .join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-TW" lang="zh-TW">
  <head>
    <meta charset="UTF-8" />
    <title>${xmlEscape(title)}</title>
    <link rel="stylesheet" type="text/css" href="styles.css" />
  </head>
  <body>
    <h2 class="chapter-title">${xmlEscape(title)}</h2>
      ${paragraphs}
  </body>
</html>`;
}

const EPUB_CSS = `body { line-height: 1.75; margin: 1em 0.8em; font-size: 100%; }
h2.chapter-title { font-size: 1.1em; text-align: center; margin: 0 0 1.2em; }
p { text-indent: 2em; margin: 0 0 0.6em; text-align: justify; }`;

/** 依 Readmoo 限制分卷：< 1000 章、< 100 萬字、單章 < 1.5 萬字 */
export function splitVolumes(chapters: CrawledChapter[]): CrawledChapter[][] {
  const MAX_CHAPTERS = 900;
  const MAX_CHARS = 900000;
  const MAX_SECTION_CHARS = 15000; // Readmoo 單章上限
  const SAFE_SECTION_CHARS = 12000;
  const volumes: CrawledChapter[][] = [];
  let cur: CrawledChapter[] = [];
  let curChars = 0;

  const flush = () => {
    if (cur.length) {
      volumes.push(cur);
      cur = [];
      curChars = 0;
    }
  };

  /** 把超長正文切成數個 ≤ SAFE_SECTION_CHARS 的片段 */
  const sliceLong = (title: string, text: string): CrawledChapter[] => {
    let chunks: string[] = [];
    // 先依段落切，盡量不在句子中間斷開
    let buf = '';
    for (const line of text.split('\n')) {
      if (line.length > SAFE_SECTION_CHARS) {
        if (buf.trim()) {
          chunks.push(buf.trim());
          buf = '';
        }
        // 單行本身就過長 → 硬切成等長片段
        for (let i = 0; i < line.length; i += SAFE_SECTION_CHARS) {
          chunks.push(line.slice(i, i + SAFE_SECTION_CHARS));
        }
        continue;
      }
      if (buf.length + line.length > SAFE_SECTION_CHARS) {
        chunks.push(buf.trim());
        buf = '';
      }
      buf += line + '\n';
    }
    if (buf.trim()) chunks.push(buf.trim());
    chunks = chunks.filter((c) => c.length > 0);

    return chunks.map((c, i) => ({
      title: chunks.length > 1 ? `${title}（${i + 1}/${chunks.length}）` : title,
      text: c,
    }));
  };

  const push = (ch: CrawledChapter) => {
    if (cur.length >= MAX_CHAPTERS || curChars + ch.text.length > MAX_CHARS) flush();
    cur.push(ch);
    curChars += ch.text.length;
  };

  for (const ch of chapters) {
    if (ch.text.length > MAX_SECTION_CHARS) {
      for (const part of sliceLong(ch.title, ch.text)) push(part);
      continue;
    }
    push(ch);
  }
  flush();
  return volumes;
}

export async function buildEpub(
  meta: { title: string; author?: string; volumeLabel?: string },
  chapters: CrawledChapter[],
  outFile: string,
): Promise<void> {
  const zip = new JSZip();
  const uid = crypto.randomUUID();
  const bookTitle = meta.volumeLabel ? `${meta.title} ${meta.volumeLabel}` : meta.title;
  const author = meta.author || '未知作者';

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  zip.file('OEBPS/styles.css', EPUB_CSS);

  const manifest: string[] = [];
  const spine: string[] = [];
  const navPoints: string[] = [];
  const navItems: string[] = [];

  chapters.forEach((ch, i) => {
    const id = `item${i + 1}`;
    const file = `chap_${String(i + 1).padStart(5, '0')}.xhtml`;
    zip.file(`OEBPS/${file}`, chapterXhtml(ch.title, ch.text));
    manifest.push(`<item id="${id}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
    navPoints.push(
      `  <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">\n    <navLabel><text>${xmlEscape(
        ch.title.slice(0, 80),
      )}</text></navLabel>\n    <content src="${file}"/>\n  </navPoint>`,
    );
    navItems.push(
      `<li><a href="${file}">${xmlEscape(ch.title.slice(0, 80))}</a></li>`,
    );
  });

  manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  manifest.push('<item id="css" href="styles.css" media-type="text/css"/>');

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:${uid}</dc:identifier>
    <dc:title>${xmlEscape(bookTitle)}</dc:title>
    <dc:creator>${xmlEscape(author)}</dc:creator>
    <dc:language>zh-TW</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>${manifest.join('')}</manifest>
  <spine toc="ncx">${spine.join('')}</spine>
</package>`,
  );

  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uid}"/>
  </head>
  <docTitle><text>${xmlEscape(bookTitle)}</text></docTitle>
  <navMap>
${navPoints.join('\n')}
  </navMap>
</ncx>`,
  );

  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <meta charset="UTF-8" />
    <title>目錄</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目錄</h1>
      <ol>
        ${navItems.join('\n        ')}
      </ol>
    </nav>
  </body>
</html>`,
  );

  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    mimeType: 'application/epub+zip',
  });
  fs.writeFileSync(outFile, buf);
}

/* ============================ Readmoo Cognito 登入（v3 上傳端點） ============================ */

// Readmoo v3 上傳端點（api.readmoo.com/store/v3/me/documents/）使用 Cognito Bearer JWT。
// 下列參數由用戶提供的 AccessToken 解出（iss / client_id 欄位）。
const COGNITO_REGION = process.env.READMOO_COGNITO_REGION || 'ap-northeast-1';
const COGNITO_POOL_ID =
  process.env.READMOO_COGNITO_POOL_ID || 'ap-northeast-1_EH9vxBYqK';
const COGNITO_CLIENT_ID =
  process.env.READMOO_COGNITO_CLIENT_ID || '1vo6drk6c6ma7htam496pnrkdr';
const COGNITO_ENDPOINT = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;

// SRP-6a 標準群（RFC 5054, 3072-bit），Cognito 固定使用這組
const SRP_N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';
const SRP_g = 2n;
const SRP_N = BigInt('0x' + SRP_N_HEX);
const SRP_N_BYTES = 384; // 3072 bits

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

function sha256Hex(str: string): string {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function hexBigInt(hex: string): bigint {
  return BigInt('0x' + hex);
}

function padHex(hex: string): string {
  return hex.padStart(SRP_N_BYTES * 2, '0');
}

function randomBigInt(bytes: number): bigint {
  return BigInt('0x' + crypto.randomBytes(bytes).toString('hex'));
}

async function cognitoRequest(target: string, body: Record<string, unknown>) {
  let res: Response;
  try {
    res = await fetch(COGNITO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    throw new Error(`連不上 Cognito（${String(e?.message || e).slice(0, 60)}）`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data as any).__type) {
    const t = (data as any).__type || `HTTP ${res.status}`;
    const msg = (data as any).message || '';
    throw new Error(`${t}${msg ? `：${msg}` : ''}`);
  }
  return data as any;
}

/** 用帳號密碼向 Readmoo 的 Cognito 換 Bearer JWT（優先 USER_PASSWORD_AUTH，失敗自動切 SRP） */
export async function cognitoLogin(
  username: string,
  password: string,
  log: (m: string) => void,
): Promise<string> {
  // 1) 先試最簡單的 USER_PASSWORD_AUTH（若 Readmoo 有啟用）
  try {
    const r = await cognitoRequest('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    });
    if (r.AuthenticationResult?.AccessToken) {
      log('✓ Cognito 登入成功（password flow）');
      return r.AuthenticationResult.AccessToken;
    }
  } catch (e: any) {
    log(`  password flow 不可用，改用 SRP（${String(e?.message || e).slice(0, 60)}）`);
  }

  // 2) SRP flow
  const poolName = COGNITO_POOL_ID.split('_')[1]!;
  const a = randomBigInt(128);
  const A = modPow(SRP_g, a, SRP_N);

  const init = await cognitoRequest('InitiateAuth', {
    AuthFlow: 'USER_SRP_AUTH',
    ClientId: COGNITO_CLIENT_ID,
    AuthParameters: { USERNAME: username, SRP_A: padHex(A.toString(16)) },
  });

  if (init.ChallengeName !== 'PASSWORD_VERIFIER') {
    throw new Error(`Cognito 挑戰類型異常：${init.ChallengeName || '(無)'}`);
  }
  const p = init.ChallengeParameters || {};
  const salt = String(p.SALT || '');
  const B = String(p.SRP_B || '');
  const secretBlock = String(p.SECRET_BLOCK || '');
  const userIdForSrp = String(p.USER_ID_FOR_SRP || '');

  const x = hexBigInt(sha256Hex(salt + sha256Hex(poolName + username + ':' + password)));
  const k = hexBigInt(sha256Hex(padHex(SRP_N.toString(16)) + padHex(SRP_g.toString(16))));
  const u = hexBigInt(sha256Hex(padHex(A.toString(16)) + padHex(B)));
  const gPowX = modPow(SRP_g, x, SRP_N);
  const base = ((hexBigInt(B) - k * gPowX) % SRP_N + SRP_N) % SRP_N;
  const S = modPow(base, a + u * x, SRP_N);

  // HKDF：key = A，data = S，info = "Caldera Derived Key" + 0x01，展開 16 段各取前 4 bytes
  const infoBits = Buffer.concat([
    Buffer.from('Caldera Derived Key', 'utf8'),
    Buffer.from([1]),
  ]);
  const hkdfKey = Buffer.from(padHex(A.toString(16)), 'hex');
  const ikm = Buffer.from(padHex(S.toString(16)), 'hex');
  const prk = crypto.createHmac('sha256', hkdfKey).update(ikm).digest();
  let prev = Buffer.alloc(0);
  const hkdfOut = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) {
    prev = crypto
      .createHmac('sha256', prk)
      .update(Buffer.concat([prev, infoBits, Buffer.from([i + 1])]))
      .digest();
    prev.copy(hkdfOut, i * 4, 0, 4);
  }

  const claim = crypto
    .createHmac('sha256', hkdfOut)
    .update(
      Buffer.concat([
        Buffer.from(poolName, 'utf8'),
        Buffer.from(userIdForSrp, 'utf8'),
        Buffer.from(secretBlock, 'base64'),
      ]),
    )
    .digest('base64');

  const resp = await cognitoRequest('RespondToAuthChallenge', {
    ChallengeName: 'PASSWORD_VERIFIER',
    ClientId: COGNITO_CLIENT_ID,
    ChallengeResponses: {
      USERNAME: username,
      PASSWORD_CLAIM_SIGNATURE: claim,
      TIMESTAMP: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
  });

  if (!resp.AuthenticationResult?.AccessToken) {
    throw new Error('Cognito 登入未回傳 AccessToken（帳號或密碼錯誤，或需要驗證）');
  }
  log('✓ Cognito 登入成功（SRP flow）');
  return resp.AuthenticationResult.AccessToken;
}

/* ============================ Readmoo v3 兩段式上傳 ============================ */

const READMOO_CREATE_DOC_URL = 'https://api.readmoo.com/store/v3/me/documents/';

/**
 * 兩段式上傳（依 Readmoo 實際流程，取代舊的 multipart 猜測）：
 * 1. POST /store/v3/me/documents/（JSON:API，送 filename/size/mime/md5/sha256）
 *    → 回傳 meta.upload_endpoint（S3 presigned PUT 網址）與 document id
 * 2. PUT 檔案內容到 upload_endpoint（Content-MD5 必須與建立時的 md5 一致）
 */
export async function uploadDocument(
  accessToken: string,
  filePath: string,
  fileName: string,
  log: (m: string) => void,
): Promise<boolean> {
  const buf = fs.readFileSync(filePath);
  const md5 = crypto.createHash('md5').update(buf).digest('base64');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const mime = /\.epub$/i.test(fileName) ? 'application/epub+zip' : 'text/plain';

  // 1) 建立 document，取得 presigned 上傳網址
  let createJson: any;
  try {
    const res = await fetch(READMOO_CREATE_DOC_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/vnd.api+json',
        accept: 'application/json, text/plain, */*',
        origin: 'https://next.readmoo.com',
        referer: 'https://next.readmoo.com/',
      },
      body: JSON.stringify({
        data: { type: 'documents' },
        meta: { file: { name: fileName, size: buf.length, type: mime, md5, sha256 } },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      log(`  建立 document 失敗 HTTP ${res.status}（回應長度 ${text.length}）`);
      return false;
    }
    createJson = JSON.parse(text);
  } catch (e: any) {
    log(`  建立 document 失敗：${String(e?.message || e).slice(0, 80)}`);
    return false;
  }

  const uploadUrl: string | undefined = createJson?.meta?.upload_endpoint;
  const docId: string | undefined = createJson?.data?.id;
  if (!uploadUrl) {
    log('  建立 document 回應缺少 upload_endpoint');
    return false;
  }

  // 2) PUT 檔案內容到 presigned S3 網址
  try {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-MD5': md5,
        'Content-SHA256': sha256,
        'Content-Type': mime,
        'Content-Length': String(buf.length),
      },
      body: new Uint8Array(buf),
    });
    if (res.ok) {
      log(`  ✓ ${fileName} 上傳完成（document ${docId || ''}）`);
      return true;
    }
    const t = await res.text().catch(() => '');
    log(`  上傳 S3 失敗 HTTP ${res.status}（回應長度 ${t.length}）`);
    return false;
  } catch (e: any) {
    log(`  上傳 S3 失敗：${String(e?.message || e).slice(0, 80)}`);
    return false;
  }
}

/**
 * 連通性診斷：從「這台伺服器的 IP」分別探測三個上游，
 * 判斷哪些被擋（Cloudflare / WAF）、哪些通，供部署後快速驗證。
 */
export async function diagnoseConnectivity(): Promise<Record<string, any>> {
  const out: Record<string, any> = {};

  // 1) 小說站（uukanshu.cc）
  try {
    const res = await httpReq('https://uukanshu.cc/', { timeout: 12000 });
    out.novel = {
      status: res.status,
      reachable: true,
      blocked: !res.ok,
      note: res.ok ? '連通（HTTP 200）' : '被擋（Cloudflare 反爬？）',
    };
  } catch (e: any) {
    out.novel = { status: null, reachable: false, blocked: true, note: String(e?.message || e).slice(0, 80) };
  }

  // 2) Cognito 登入端點（假帳號探測：連通會回「帳號不存在」類錯誤；被 WAF 擋會回 ForbiddenException）
  try {
    const res = await fetch(COGNITO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: { USERNAME: 'diag-probe@example.com', PASSWORD: 'diag-probe' },
      }),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    const type = data.__type || '';
    const msg = data.message || '';
    if (/forbidden/i.test(type) || /WAF/i.test(msg)) {
      out.cognito = { status: res.status, reachable: true, blocked: true, note: `被 WAF 擋（${type}）` };
    } else {
      out.cognito = {
        status: res.status,
        reachable: true,
        blocked: false,
        note: `連通正常（${type || 'HTTP ' + res.status}，帳號不存在屬預期）`,
      };
    }
  } catch (e: any) {
    out.cognito = { status: null, reachable: false, blocked: false, note: String(e?.message || e).slice(0, 80) };
  }

  // 3) S3 上傳 bucket（403/404 都代表已連到 S3，即「通」）
  try {
    const res = await fetch('https://readmoo-doc-production.s3.ap-northeast-1.amazonaws.com/', { method: 'GET' });
    out.s3 = { status: res.status, reachable: true, blocked: false, note: '連通' };
  } catch (e: any) {
    out.s3 = { status: null, reachable: false, blocked: false, note: String(e?.message || e).slice(0, 80) };
  }

  return out;
}

/* ============================ Readmoo 客戶端 ============================ */

const READMOO_LOGIN_URL = 'https://member.readmoo.com/login/';
const READMOO_VERIFY_URLS = [
  'https://new-read.readmoo.com/api/me/readings',
  'https://readmoo.com/api/me/readings',
  'https://readmoo.com/api/me',
];

export class ReadmoAuthError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

function extractCsrf(html: string): { field: string; value: string } | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i, 'authenticity_token'],
    [/<meta[^>]+name=["']csrf-param["'][^>]+content=["']([^"']+)["']/i, 'csrf_param_marker'],
    [
      /<input[^>]+name=["'](authenticity_token|csrf[_a-z-]*token|token|_token)["'][^>]+value=["']([^"']+)["']/i,
      '',
    ],
  ];
  let paramName = 'authenticity_token';
  const pm = html.match(/<meta[^>]+name=["']csrf-param["'][^>]+content=["']([^"']+)["']/i);
  if (pm) paramName = pm[1];

  for (const [re, fieldHint] of patterns) {
    const m = html.match(re);
    if (!m) continue;
    if (fieldHint === 'csrf_param_marker') continue;
    if (m[2]) return { field: m[1], value: m[2] };
    return { field: paramName, value: m[1] };
  }
  return undefined;
}

function looksLikeCaptcha(html: string): boolean {
  return /g-recaptcha|recaptcha|cloudflare.*challenge|cf-turnstile/i.test(html);
}

export async function readmooLogin(
  email: string,
  password: string,
  log: (m: string) => void,
): Promise<CookieJar> {
  const jar = newJar();
  log('取得 Readmoo 登入頁…');
  const page = await httpReq(READMOO_LOGIN_URL, { jar, referer: 'https://readmoo.com/' }).catch(
    (e) => {
      throw new ReadmoAuthError(
        `連不上 Readmoo（${String(e?.message || e).slice(0, 60)}）`,
        '若此環境無法連線 readmoo.com，請改在本機執行',
      );
    },
  );
  const html = await readBody(page).catch(() => '');
  if (looksLikeCaptcha(html)) {
    throw new ReadmoAuthError(
      'Readmoo 登入頁出現圖形驗證碼，無法自動登入',
      '請改用「貼上瀏覽器 cookie」方式，或稍後再試',
    );
  }

  const body = new URLSearchParams({ email, password });
  const csrf = extractCsrf(html);
  if (csrf) body.set(csrf.field, csrf.value);

  log('送出登入請求…');
  const res = await httpReq(READMOO_LOGIN_URL, {
    jar,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://member.readmoo.com',
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
    },
    body: body.toString(),
    referer: READMOO_LOGIN_URL,
    noFollow: true,
  });

  const location = res.headers.get('location');
  if (location) {
    const target = absoluteUrl(location, READMOO_LOGIN_URL);
    log(`跟隨導向 ${target.slice(0, 60)}…`);
    await httpReq(target, { jar, referer: READMOO_LOGIN_URL });
  }

  // 驗證 session
  for (const url of READMOO_VERIFY_URLS) {
    try {
      const check = await httpReq(url, { jar, referer: 'https://readmoo.com/' });
      const text = await check.text().catch(() => '');
      if (check.ok && !/error_login|not_login|unauthorized/i.test(text)) {
        log('✓ Readmoo 登入成功');
        return jar;
      }
    } catch {
      /* try next */
    }
  }
  throw new ReadmoAuthError(
    'Readmoo 登入失敗（帳號或密碼錯誤，或網站已改版）',
    '請確認帳密正確；若網站改版，請重新錄製上傳請求後再試',
  );
}

/* ============================ 上傳設定（由 DevTools cURL 學習） ============================ */

export interface UploadConfig {
  method: string;
  url: string;
  headers: Record<string, string>;
  fields: Record<string, string>;
  fileField: string;
  bookshelfUrl?: string;
  csrfField?: string;
  /** 錄製的請求是否帶有靜態憑證（cookie / Bearer token）——有則代表身分被綁死在錄製者身上 */
  hasStaticAuth?: boolean;
  updatedAt?: string;
}

const DEFAULT_UPLOAD_URL = process.env.READMOO_UPLOAD_URL || '';

export function loadUploadConfig(): UploadConfig | null {
  try {
    if (fs.existsSync(UPLOAD_CFG_FILE)) {
      return JSON.parse(fs.readFileSync(UPLOAD_CFG_FILE, 'utf8')) as UploadConfig;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_UPLOAD_URL
    ? ({
        method: 'POST',
        url: DEFAULT_UPLOAD_URL,
        headers: {},
        fields: {},
        fileField: 'file',
      } as UploadConfig)
    : null;
}

export function saveUploadConfig(cfg: UploadConfig) {
  // 內容可能含書櫃端點與 CSRF 欄位樣本，設為僅擁有者可讀寫
  try {
    fs.writeFileSync(UPLOAD_CFG_FILE, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(UPLOAD_CFG_FILE, 0o600);
  } catch {
    fs.writeFileSync(UPLOAD_CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  }
}

function unquote(v: string): string {
  return v.trim().replace(/^['"]|['"]$/g, '');
}

const CURL_BS = String.fromCharCode(92);

/** 把 cURL 指令切成 token，支援 '...'、"..."、$'...' 與裸值 */
function tokenizeCurl(s: string): string[] {
  const tokens: string[] = [];
  const SP = [' ', '\t', '\n', '\r'];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && SP.indexOf(s.charAt(i)) >= 0) i++;
    if (i >= s.length) break;
    let quote = '';
    if (s.charAt(i) === '$' && (s.charAt(i + 1) === "'" || s.charAt(i + 1) === '"')) {
      quote = s.charAt(i + 1);
      i += 2;
    } else if (s.charAt(i) === "'" || s.charAt(i) === '"') {
      quote = s.charAt(i);
      i += 1;
    }
    let buf = '';
    while (i < s.length) {
      const ch = s.charAt(i);
      if (quote) {
        if (ch === CURL_BS) {
          buf += s.charAt(i + 1) || '';
          i += 2;
          continue;
        }
        if (ch === quote) {
          i += 1;
          break;
        }
        buf += ch;
        i += 1;
      } else if (SP.indexOf(ch) >= 0) {
        break;
      } else {
        buf += ch;
        i += 1;
      }
    }
    if (buf.length) tokens.push(buf);
  }
  return tokens;
}

/** 解析 Chrome DevTools「複製為 cURL」的內容 */
export function parseCurl(input: string): UploadConfig {
  // 移除續行符號（ \ + 換行 ）
  let src = input;
  src = src.split(CURL_BS + '\r\n').join(' ');
  src = src.split(CURL_BS + '\n').join(' ');

  const tokens = tokenizeCurl(src);
  let url = '';
  let method = '';
  const headers: Record<string, string> = {};
  const forms: string[] = [];
  const datas: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1] || '';
    if (t === 'curl') continue;
    if (t === '-X' || t === '--request') {
      method = next.toUpperCase();
    } else if (t === '-H' || t === '--header') {
      const idx = next.indexOf(':');
      if (idx > 0) {
        const key = next.slice(0, idx).trim();
        if (key.toLowerCase() !== 'content-length') {
          headers[key] = next.slice(idx + 1).trim();
        }
      }
    } else if (t === '-F' || t === '--form' || t === '--form-string') {
      forms.push(next);
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') {
      datas.push(next);
    } else if (!url && (t.indexOf('http://') === 0 || t.indexOf('https://') === 0)) {
      url = t;
    }
  }

  if (!url) throw new Error('cURL 中找不到網址（請確認貼的是完整請求）');

  const fields: Record<string, string> = {};
  let fileField = 'file';

  for (const raw of forms) {
    const idx = raw.indexOf('=');
    if (idx <= 0) continue;
    const key = raw.slice(0, idx).trim();
    let value = raw.slice(idx + 1).trim();
    // Chrome 可能寫成 file=@x.epub;type=application/epub+zip
    const semi = value.indexOf(';');
    if (semi >= 0) value = value.slice(0, semi);
    if (value.startsWith('@') || value.startsWith('<')) {
      fileField = key;
      continue;
    }
    fields[key] = value;
  }

  if (!Object.keys(fields).length) {
    for (const raw of datas) {
      let body = raw;
      if (body.startsWith('$') && body.length > 3) body = body.slice(1);
      if (body.startsWith('{')) {
        try {
          const obj = JSON.parse(body) as Record<string, unknown>;
          for (const [k, v] of Object.entries(obj)) {
            fields[k] = typeof v === 'string' ? v : JSON.stringify(v);
          }
        } catch {
          /* 忽略非 JSON */
        }
      } else {
        for (const pair of body.split('&')) {
          if (!pair) continue;
          const idx = pair.indexOf('=');
          if (idx <= 0) continue;
          const k = pair.slice(0, idx);
          const v = unquote(decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' ')));
          if (v.startsWith('@')) {
            fileField = unquote(k);
            continue;
          }
          fields[unquote(k)] = v;
        }
      }
    }
  }

  const finalMethod = method || (forms.length || datas.length ? 'POST' : 'GET');

  // 推測 CSRF 欄位
  const csrfField = Object.keys(fields).find((k) =>
    /(token|csrf|nonce|_method)/i.test(k),
  );
  // 一律改用 fetch 自己產生的 multipart boundary / content-type，
  // 錄製來的 boundary 屬於那一次的請求，照搬會讓伺服器解析不出檔案
  Object.keys(headers).forEach((k) => {
    if (k.toLowerCase() === 'content-type') delete headers[k];
  });

  // 記錄是否含有「綁死某個人的身分憑證」，供 UI 警示
  // 注意：這些靜態憑證一律「不寫入設定檔」，避免明文 token 落盤
  let hasStaticAuth = false;
  Object.keys(headers).forEach((k) => {
    const key = k.toLowerCase();
    if (key === 'cookie' || key === 'authorization' || key.startsWith('x-auth') || key === 'x-session-token') {
      hasStaticAuth = true;
      delete headers[k];
    }
  });

  const originHost = new URL(url).origin;
  if (!headers['Origin']) headers['Origin'] = originHost;
  if (!headers['Referer']) headers['Referer'] = originHost + '/';

  return {
    method: finalMethod,
    url,
    headers,
    fields,
    fileField,
    csrfField,
    hasStaticAuth,
    bookshelfUrl: `${originHost}/bookshelf`,
    updatedAt: new Date().toISOString(),
  };
}

async function refreshCsrfIfNeeded(jar: CookieJar, cfg: UploadConfig): Promise<void> {
  if (!cfg.csrfField || !cfg.bookshelfUrl) return;
  try {
    const res = await httpReq(cfg.bookshelfUrl, { jar, referer: cfg.bookshelfUrl });
    if (!res.ok) return;
    const html = await readBody(res);
    const found = extractCsrf(html);
    if (found) cfg.fields[found.field === cfg.csrfField ? cfg.csrfField : found.field] = found.value;
  } catch {
    /* 失敗就用錄製時的值 */
  }
}

export async function uploadVolume(
  jar: CookieJar,
  cfg: UploadConfig,
  filePath: string,
  log: (m: string) => void,
): Promise<boolean> {
  await refreshCsrfIfNeeded(jar, cfg);

  const form = new FormData();
  for (const [k, v] of Object.entries(cfg.fields)) form.append(k, v);
  const buf = fs.readFileSync(filePath);
  form.append(
    cfg.fileField || 'file',
    new Blob([new Uint8Array(buf)], { type: 'application/epub+zip' }),
    path.basename(filePath),
  );

  const headers: Record<string, string> = { ...cfg.headers };
  // 移除 content-type（multipart boundary 由 fetch 產生）
  // 並移除錄製時的「身分憑證」：否則每次上傳都會用錄製者本人的身分，
  // 換任何帳號來導入，檔案仍會進到同一個人的書櫃（且 cookie 會和新 session 打架）
  const keepStaticAuth = process.env.READMOO_KEEP_STATIC_AUTH === 'true';
  const dropped: string[] = [];
  Object.keys(headers).forEach((k) => {
    const key = k.toLowerCase();
    if (key === 'content-type' || key === 'content-length') {
      delete headers[k];
      return;
    }
    if (!keepStaticAuth && (key === 'cookie' || key === 'authorization' || key.startsWith('x-auth') || key === 'x-session-token')) {
      dropped.push(k);
      delete headers[k];
    }
  });
  if (dropped.length) {
    log(`  已移除錄製憑證標頭：${dropped.join(', ')}（改用本次登入的 session cookie）`);
  }
  if (jar.size) headers['Cookie'] = cookieHeader(jar);

  const res = await fetch(cfg.url, {
    method: cfg.method || 'POST',
    headers,
    body: form as any,
    redirect: 'follow',
  }).catch((e) => {
    throw new Error(`上傳請求失敗：${String(e?.message || e).slice(0, 80)}`);
  });

  const text = await res.text().catch(() => '');
  if (res.ok && !/error_login/i.test(text)) return true;
  // 只記錄狀態碼與極短摘要，避免回應內含的 token / 個資進到 job log
  log(`  上傳失敗 HTTP ${res.status}${text ? `（回應長度 ${text.length}）` : ''}`);
  return false;
}

/* ============================ 任務佇列 ============================ */

export interface ReadmoJob {
  id: string;
  status: 'queued' | 'info' | 'crawling' | 'packing' | 'uploading' | 'done' | 'error';
  stage: string;
  bookUrl: string;
  siteId?: string;
  title?: string;
  author?: string;
  siteName?: string;
  wordCountText?: string;
  chapterCount?: number;
  crawled: number;
  volumes: { label: string; file: string; chapters: number; uploaded: boolean }[];
  logs: string[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const jobs = new Map<string, ReadmoJob>();
const queue: string[] = [];
let running = false;

/** 只保留最近 20 個任務產出的 EPUB，避免磁碟無限增長 */
function pruneVolumes() {
  try {
    const dirs = fs
      .readdirSync(READMO_DIR)
      .map((n) => ({ n, t: fs.statSync(path.join(READMO_DIR, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const d of dirs.slice(20)) {
      fs.rmSync(path.join(READMO_DIR, d.n), { recursive: true, force: true });
    }
  } catch {
    /* 忽略清理失敗 */
  }
}

function log(job: ReadmoJob, msg: string) {
  job.logs.push(`[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ${msg}`);
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
  job.updatedAt = Date.now();
}

export function publicJob(job: ReadmoJob) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    title: job.title,
    author: job.author,
    siteName: job.siteName,
    bookUrl: job.bookUrl,
    wordCountText: job.wordCountText,
    chapterCount: job.chapterCount,
    crawled: job.crawled,
    volumes: job.volumes.map((v) => ({
      label: v.label,
      chapters: v.chapters,
      uploaded: v.uploaded,
      downloadUrl: `/api/readmo/jobs/${job.id}/volume/${encodeURIComponent(v.file)}`,
    })),
    logs: job.logs.slice(-80),
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function getJob(id: string) {
  return jobs.get(id);
}

export function listJobs() {
  return Array.from(jobs.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
    .map(publicJob);
}

export function createJob(input: {
  bookUrl: string;
  email: string;
  password: string;
  siteId?: string;
  title?: string;
}): ReadmoJob {
  const id = crypto.randomUUID();
  const job: ReadmoJob = {
    id,
    status: 'queued',
    stage: '排隊中',
    bookUrl: input.bookUrl,
    siteId: input.siteId,
    title: input.title,
    crawled: 0,
    volumes: [],
    logs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(id, job);

  // 佇列上限：避免被短時間大量請求塞爆
  if (queue.length >= 5) {
    job.status = 'error';
    job.stage = '失敗';
    job.error = '目前有太多導入任務在排隊，請稍後再試';
    log(job, job.error);
    return job;
  }
  queue.push(id);

  // 清理過期任務（保留最近 50 筆 / 24 小時內）
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [k, v] of jobs) {
      if (k !== id && v.createdAt < cutoff) jobs.delete(k);
    }
    const arr = Array.from(jobs.entries()).sort((a, b) => b[1].createdAt - a[1].createdAt);
    for (const [k] of arr.slice(50)) jobs.delete(k);
  } catch {
    /* ignore */
  }

  (jobs as any).get(id)._cred = { email: input.email, password: input.password };
  pump();
  return job;
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      const job = jobs.get(id);
      if (!job) continue;
      const cred = (job as any)._cred as { email: string; password: string } | undefined;
      try {
        await runJob(job, cred);
      } catch (e: any) {
        job.status = 'error';
        job.stage = '失敗';
        job.error = String(e?.message || e);
        log(job, `✗ 失敗：${job.error}`);
      } finally {
        delete (job as any)._cred;
      }
    }
  } finally {
    running = false;
  }
}

async function runJob(job: ReadmoJob, cred?: { email: string; password: string }) {
  // 1. 書籍資訊
  job.status = 'info';
  job.stage = '讀取書籍資訊';
  log(job, `書籍來源：${job.bookUrl}`);
  const info = await getBookInfo(job.bookUrl);
  job.title = job.title || info.title;
  job.author = info.author;
  job.siteName = info.siteName;
  job.siteId = siteForUrl(job.bookUrl)?.id;
  job.wordCountText = info.wordCountText;
  job.chapterCount = info.chapterCount;
  log(job, `《${info.title}》${info.author ? ' / ' + info.author : ''} ${info.wordCountText || ''}`);

  if (!info.firstChapterUrl) {
    throw new Error('找不到第一章連結，此書籍頁結構可能不支援');
  }

  // 2. 爬取
  job.status = 'crawling';
  job.stage = '逐章爬取';
  log(job, '開始爬取章節（每章間隔 1.1 秒）…');
  const chapters = await crawlNovel({
    firstChapterUrl: info.firstChapterUrl,
    site: { id: job.siteId! },
    max: 5000,
    maxChars: 12_000_000,
    log: (m) => log(job, m),
    onProgress: (n, title) => {
      job.crawled = n;
      job.stage = `爬取中：第 ${n} 章《${title.slice(0, 20)}》`;
    },
  });
  log(job, `✓ 完成爬取，共 ${chapters.length} 章`);

  // 3. 分卷打包
  job.status = 'packing';
  job.stage = '打包 EPUB';
  const volumes = splitVolumes(chapters);
  const dir = path.join(READMO_DIR, job.id);
  fs.mkdirSync(dir, { recursive: true });
  pruneVolumes();
  for (let i = 0; i < volumes.length; i++) {
    const label = volumes.length > 1 ? `第${i + 1}卷` : '';
    const file = volumes.length > 1 ? `vol-${i + 1}.epub` : 'book.epub';
    const outFile = path.join(dir, file);
    await buildEpub({ title: info.title, author: info.author, volumeLabel: label }, volumes[i], outFile);
    job.volumes.push({
      label: label || '全書',
      file,
      chapters: volumes[i].length,
      uploaded: false,
    });
    log(job, `✓ 打包完成：${file}（${volumes[i].length} 章）`);
  }

  // 4. 上傳（Readmoo v3 兩段式：登入拿 Bearer → 建立 document → PUT 到 S3）
  if (!cred?.email || !cred?.password) {
    job.status = 'done';
    job.stage = '完成（未登入，略過上傳）';
    log(job, '⚠ 未輸入 Readmoo 帳密，已略過上傳，EPUB 可直接下載。');
    return;
  }

  job.status = 'uploading';
  job.stage = '登入 Readmoo';
  let accessToken: string;
  try {
    accessToken = await cognitoLogin(cred.email, cred.password, (m) => log(job, m));
  } catch (e: any) {
    job.status = 'done';
    job.stage = '完成（登入失敗，EPUB 可下載）';
    job.error = String(e?.message || e);
    log(job, `⚠ ${job.error}`);
    return;
  }

  let okCount = 0;
  for (const v of job.volumes) {
    job.stage = `上傳中：${v.label}`;
    log(job, `上傳 ${v.label}…`);
    try {
      const safeTitle = (job.title || 'novel').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
      const fileName =
        job.volumes.length > 1 ? `${safeTitle}_${v.label}.epub` : `${safeTitle}.epub`;
      const done = await uploadDocument(accessToken, path.join(dir, v.file), fileName, (m) => log(job, m));
      v.uploaded = done;
      if (done) {
        okCount++;
        log(job, `✓ ${v.label} 上傳成功`);
      } else {
        log(job, `✗ ${v.label} 上傳失敗（詳見上傳回應）`);
      }
    } catch (e: any) {
      log(job, `✗ ${v.label} 上傳失敗：${String(e?.message || e).slice(0, 120)}`);
    }
  }

  job.status = okCount === job.volumes.length ? 'done' : 'error';
  job.stage = `完成 ${okCount}/${job.volumes.length} 卷`;
  log(job, `🎉 完成 ${okCount}/${job.volumes.length} 卷，回到 mooInk 按「同步」即可看到。`);
}

export function resolveVolumeFile(jobId: string, file: string): string | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (!/^[a-z0-9][a-z0-9._-]*\.epub$/i.test(file)) return null;
  const full = path.join(READMO_DIR, jobId, file);
  return fs.existsSync(full) ? full : null;
}
