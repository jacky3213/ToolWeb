// src/gm-bridge.js
//
// Bridges Tampermonkey's GM_xmlhttpRequest into a WHATWG fetch-shaped function
// so that youtubei.js (which expects a standard fetch) can run inside a
// userscript. Also exposes a "page fetch" path that uses the page's native
// fetch (preserving cookies / Origin) and a fallback chain.

/**
 * Converts a fetch `init.headers` value (Headers / plain object / array of
 * pairs) into a plain object suitable for GM_xmlhttpRequest.
 */
function normalizeHeaders(headers) {
  if (!headers) return undefined;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const out = {};
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  if (Array.isArray(headers)) {
    const out = {};
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  if (typeof headers === 'object') {
    const out = {};
    for (const key of Object.keys(headers)) out[key] = headers[key];
    return out;
  }
  return undefined;
}

/**
 * Parses GM_xmlhttpRequest's `responseHeaders` string into a Headers object.
 * GM returns raw headers as "Key: Value\r\nKey2: Value2".
 */
function parseHeaders(raw) {
  const headers = new Headers();
  if (!raw) return headers;
  for (const line of String(raw).split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) headers.append(key, value);
  }
  return headers;
}

/**
 * A WHATWG fetch-shaped wrapper around Tampermonkey's GM_xmlhttpRequest.
 * Returns a Promise<Response> whose body is an ArrayBuffer.
 *
 * Supports `init.signal`: when aborted we call `handle.abort()` and reject
 * with a DOMException named 'AbortError'.
 *
 * @param {string|URL|Request} input
 * @param {object} [init]
 * @returns {Promise<Response>}
 */
export function gmFetch(input, init = {}) {
  return new Promise((resolve, reject) => {
    let url;
    let method = init.method;
    let headers = normalizeHeaders(init.headers);
    let body = init.body;

    if (typeof input === 'string') {
      url = input;
    } else if (typeof URL !== 'undefined' && input instanceof URL) {
      url = input.toString();
    } else if (typeof Request !== 'undefined' && input instanceof Request) {
      url = input.url;
      method = method || input.method;
      headers = normalizeHeaders(input.headers) || headers;
      // Request streams cannot be reused as a simple GM `data`; only pass a
      // buffered body when one is already materialized.
      body = body || undefined;
    } else {
      url = String(input);
    }

    method = (method || 'GET').toUpperCase();
    const signal = init.signal;
    let handle;
    let settled = false;

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (handle && typeof handle.abort === 'function') handle.abort();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    if (signal) {
      if (signal.aborted) {
        // Abort already fired before the request started.
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);
    }

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    handle = GM_xmlhttpRequest({
      method,
      url,
      headers,
      data: body,
      responseType: 'arraybuffer',
      onload: (res) => {
        if (settled) return;
        settled = true;
        cleanup();
        const status = res.status;
        const statusText = res.statusText || '';
        const responseHeaders = parseHeaders(res.responseHeaders);
        const buffer = res.response;
        resolve(new Response(buffer, {
          status,
          statusText,
          headers: responseHeaders
        }));
      },
      onerror: () => fail(new TypeError(`GM_xmlhttpRequest failed for ${url}`)),
      ontimeout: () => fail(new TypeError(`GM_xmlhttpRequest timed out for ${url}`)),
      onabort: () => fail(new DOMException('Aborted', 'AbortError'))
    });
  });
}

/**
 * Uses the page's native fetch (runs in the page's context, so cookies and
 * the Origin / Sec-Fetch headers are sent as YouTube expects).
 *
 * @param {string|URL|Request} input
 * @param {object} [init]
 * @returns {Promise<Response>}
 */
export function pageFetch(input, init) {
  return unsafeWindow.fetch(input, init);
}

/**
 * Attempts the page's native fetch first (best for CORS/cookie-preserving
 * requests), and falls back to the GM bridge if that throws (e.g. blocked by
 * the page's CSP or CORS).
 *
 * @param {string|URL|Request} url
 * @param {object} [init]
 * @returns {Promise<Response>}
 */
export async function mediaFetch(url, init) {
  try {
    return await pageFetch(url, init);
  } catch {
    return gmFetch(url, init);
  }
}
