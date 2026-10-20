// src/decipher.js
//
// youtubei.js runs YouTube's player signature/sabr code via `Platform.shim.eval`.
// Inside a Tampermonkey sandbox combined with a TrustedTypes-enabled page, that
// eval must (a) execute in the page's context (unsafeWindow) and (b) pass
// through a TrustedScript policy so the page's CSP / TrustedTypes enforcement
// allows the dynamically generated player code.
//
// Verified against youtubei.js@18.2.0 (node_modules/youtubei.js/dist/src):
//   * `Platform.shim.eval(data, env)` exists. `data` is a `BuildScriptResult`
//     (NOT a plain string); the executable script is `data.output` (string).
//     `Player.js` injects the eval args into `data.output` itself, so the
//     evaluator only needs to run `data.output` and return its result object.
//   * `Format.decipher(player)` -> Promise<string> (deciphered URL).
//   * `Player.decipher(url, signature_cipher?, cipher?, nsig_cache?)`
//     -> string (deciphered URL); used for SABR `server_abr_streaming_url`.
//   * Player is reachable at `info.actions.session.player`.

import { Platform } from 'youtubei.js/web';
import { isGoogleVideoUrl } from './formats.js';

let clientProvider = null;

/**
 * Registers a fallback provider that returns the active Player instance when it
 * cannot be located on the VideoInfo object (e.g. manually constructed flows).
 *
 * @param {() => object|null} fn
 */
export function setClientProvider(fn) {
  clientProvider = fn;
}

let evalPolicy = null;

/**
 * Installs a TrustedTypes-aware eval environment for youtubei.js's player
 * script execution. Must be called BEFORE `Innertube.create()` so that the
 * shim's default (throw-only) evaluator is replaced in time.
 *
 * The generated player code is wrapped in an IIFE when executed, because the
 * injected script ends with a top-level `return` (invalid at global eval scope
 * but valid inside a function body). The wrapped code is passed through a
 * `TrustedScript` policy (`ytdl-player-eval`) before being run via
 * `unsafeWindow.eval`. Scripts that are not player code (non-string or shorter
 * than 64 chars) are refused.
 */
export function installEvalEnvironment() {
  if (typeof unsafeWindow !== 'undefined' &&
      unsafeWindow.trustedTypes &&
      typeof unsafeWindow.trustedTypes.createPolicy === 'function') {
    try {
      evalPolicy = unsafeWindow.trustedTypes.createPolicy('ytdl-player-eval', {
        createScript: (s) => s
      });
    } catch {
      // A policy with this name may already exist; fall back to raw eval.
      evalPolicy = null;
    }
  }

  Platform.shim.eval = (data, _env) => {
    const code = data && typeof data.output === 'string' ? data.output : null;
    if (typeof code !== 'string' || code.length < 64) {
      throw new Error('Refusing to evaluate unexpected player script payload.');
    }

    // Wrap in an IIFE so the trailing top-level `return` in the player code is
    // valid. The appended `process(...)` returns { sig, n } (or exportedVars).
    const wrapped = `(function(){ ${code} })()`;
    const script = evalPolicy ? evalPolicy.createScript(wrapped) : wrapped;

    // Execute in the page's context so the player code sees the real DOM/window
    // and any page-defined helpers.
    return unsafeWindow.eval(script);
  };
}

/**
 * Resolves the Player instance used for deciphering.
 *
 * @param {object} info - VideoInfo (or compatible) object.
 * @returns {object|null}
 */
function resolvePlayer(info) {
  if (info && info.player) return info.player;
  if (info && info.actions &&
      info.actions.session && info.actions.session.player) {
    return info.actions.session.player;
  }
  if (typeof clientProvider === 'function') {
    const provided = clientProvider();
    if (provided) return provided;
  }
  return null;
}

/**
 * Deciphers a single Format's URL using the player extracted from `info`.
 * The result is validated against the googlevideo host allowlist.
 *
 * @param {object} info - VideoInfo (or compatible) object.
 * @param {object} format - A youtubei.js Format instance.
 * @returns {Promise<string>} The deciphered URL.
 */
export async function decipherFormat(info, format) {
  const player = resolvePlayer(info);
  if (!player) return format.url || '';
  const url = await format.decipher(player);
  if (!isGoogleVideoUrl(url)) {
    throw new Error(`Deciphered format URL is not a googlevideo URL: ${url}`);
  }
  return url;
}

/**
 * Deciphers a SABR `server_abr_streaming_url` using the player from `info`.
 *
 * @param {object} info - VideoInfo (or compatible) object.
 * @param {string} url - The raw server_abr_streaming_url to decipher.
 * @returns {Promise<string>} The deciphered URL.
 */
export async function decipherServerUrl(info, url) {
  const player = resolvePlayer(info);
  if (!player) {
    throw new Error('No player available to decipher server_abr_streaming_url.');
  }
  const deciphered = await player.decipher(url);
  if (!isGoogleVideoUrl(deciphered)) {
    throw new Error(`Deciphered server URL is not a googlevideo URL: ${deciphered}`);
  }
  return deciphered;
}
