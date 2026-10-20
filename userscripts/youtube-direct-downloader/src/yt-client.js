// src/yt-client.js
//
// 建立 youtubei.js (Innertube) session，並以多個客戶端並行探測影片資訊，
// 依可下載性評分選出最佳候選；全部失敗時退回頁面內嵌的 player response。
//
// 查證依據（node_modules/youtubei.js@18.2.0 實際 API）：
//  - Innertube.create(options) 支援：fetch / cookie / retrieve_player /
//    generate_session_locally / enable_session_cache（見 core/Session.js）。
//  - session.getBasicInfo(video_id, { client }) —— client 鍵名為 `client`，
//    可用值見 utils/Constants SUPPORTED_CLIENTS（ANDROID_VR/ANDROID/TV_SIMPLY/WEB/IOS...）。
//  - 回傳為 VideoInfo 實例：格式位於 info.streaming_data.formats 與
//    info.streaming_data.adaptive_formats（無頂層 formats/adaptive_formats），
//    且 streaming_data、player_config 均為 snake_case；SABR 欄位為
//    info.streaming_data.server_abr_streaming_url。
//  - Parser.parseResponse(data) 僅接受單一參數（見 parser/parser.js）。

import { Innertube, Parser } from 'youtubei.js/web';

// 依優先順序探測的客戶端候選。ANDROID_VR/ANDROID 通常能直接拿到可 decipher 的
// 直連 URL；TV_SIMPLY/WEB 多走 SABR。
export const CLIENT_CANDIDATES = ['ANDROID_VR', 'ANDROID', 'TV_SIMPLY', 'WEB'];

// 依候選資訊的可下載性給分。失敗或需登入直接 -1（不合格）。
//  直連 URL（可 decipher）> SABR > 基本可用；同級時可選格式越多分越高。
export function scoreInfoCandidate(c) {
  if (!c.ok || c.isLoginRequired) return -1;
  let s = 0;
  if (c.hasDirectUrls) s += 3;
  if (c.hasSabr) s += 2;
  s += Math.min((c.formatCount ?? 0) / 10, 1); // 最多 +1
  return s;
}

let sessionPromise = null;

// 建立（並快取）Innertube session。gmFetch 為 WHATWG fetch 形狀的函式
// （由 gm-bridge 將 Tampermonkey 的 GM_xmlhttpRequest 轉接而來）。
// 失敗時清空快取以便重試。
export function getYouTubeClient(gmFetch, { cookie } = {}) {
  sessionPromise ??= Innertube.create({
    fetch: gmFetch,
    retrieve_player: true,
    generate_session_locally: true,
    enable_session_cache: false,
    cookie,
  }).catch((err) => {
    sessionPromise = null;
    throw err;
  });
  return sessionPromise;
}

function collectFormats(info) {
  const sd = info?.streaming_data;
  const formats = sd?.formats ?? [];
  const adaptive = sd?.adaptive_formats ?? [];
  return { formats, adaptive, streamingData: sd };
}

// 單一客戶端探測。絕不 throw；失敗時回傳描述物件（ok:false）。
async function probeClient(client, videoId, session) {
  try {
    const info = await session.getBasicInfo(videoId, { client });
    const { formats, adaptive, streamingData } = collectFormats(info);

    const all = [...formats, ...adaptive];
    const hasDirectUrls = all.some((f) => f && (f.url || f.cipher || f.signature_cipher));
    const hasSabr = !!streamingData?.server_abr_streaming_url;
    const formatCount = all.length;
    const status = info?.playability_status?.status;

    const isLoginRequired =
      status === 'LOGIN_REQUIRED' ||
      /LOGIN_REQUIRED|Sign in|sign.?in required/i.test(JSON.stringify(info?.playability_status ?? ''));

    return {
      ok: true,
      client,
      error: null,
      hasDirectUrls,
      hasSabr,
      isLoginRequired,
      formatCount,
      info,
    };
  } catch (error) {
    const msg = error?.message ?? String(error);
    const isLoginRequired = /LOGIN_REQUIRED|Sign in|sign.?in required/i.test(msg);
    return {
      ok: false,
      client,
      error,
      hasDirectUrls: false,
      hasSabr: false,
      isLoginRequired,
      formatCount: 0,
      info: null,
    };
  }
}

// 主入口：並行探測所有候選客戶端 → 評分取最佳 → 全敗則退回頁面 player response。
//   - 成功：回傳 { source:'innertube', client, info }
//   - 全客戶端失敗且有 pagePlayerResponse：用 Parser.parseResponse 解析後
//     回傳 { source:'page', client:'PAGE', info }
//   - 否則 throw 第一個錯誤
export async function loadVideoInfo(videoId, gmFetch, pagePlayerResponse) {
  const [session, pageInfo] = await Promise.all([
    getYouTubeClient(gmFetch),
    Promise.resolve(
      pagePlayerResponse ? Parser.parseResponse(pagePlayerResponse) : null
    ).catch(() => null),
  ]);

  const probes = await Promise.all(
    CLIENT_CANDIDATES.map((client) => probeClient(client, videoId, session))
  );

  const scored = probes
    .map((p) => ({ p, score: scoreInfoCandidate(p) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    const best = scored[0].p;
    return { source: 'innertube', client: best.client, info: best.info };
  }

  // 全部 innertube 候選失敗：若頁面有內嵌 player response 則退回該來源。
  if (pageInfo) {
    return { source: 'page', client: 'PAGE', info: pageInfo };
  }

  // 否則拋出第一個（非登入類）錯誤，呼叫方得以處理。
  const firstError = probes.find((p) => p.error)?.error;
  throw firstError ?? new Error('All Innertube clients failed and no page player response available');
}
