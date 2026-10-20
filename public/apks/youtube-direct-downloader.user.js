// ==UserScript==
// @name         YouTube 直連下載 (Direct Downloader)
// @name:en      YouTube Direct Downloader
// @namespace    https://github.com/jacky3213
// @version      0.1.0
// @description  在瀏覽器內直接下載 YouTube 影片與 Shorts，音視頻無損合併，不經第三方解析站。僅供個人備份，請遵守著作權法與 YouTube 服務條款。
// @description:en  Download YouTube videos & Shorts directly in the browser with lossless muxing. For personal backup only.
// @author       jacky3213
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      www.youtube.com
// @connect      youtube.com
// @connect      youtubei.googleapis.com
// @connect      googlevideo.com
// ==/UserScript==

(()=>{console.log("[YT-DL] youtube-direct-downloader loaded");})();
