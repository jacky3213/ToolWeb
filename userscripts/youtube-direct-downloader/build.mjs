import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const userscriptHeader = `// ==UserScript==
// @name         YouTube 直連下載 (Direct Downloader)
// @name:en      YouTube Direct Downloader
// @namespace    https://github.com/jacky3213
// @version      ${pkg.version}
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
`;

await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120', 'firefox120'],
  minify: true,
  legalComments: 'inline',
  banner: { js: userscriptHeader },
  outfile: '../../public/apks/youtube-direct-downloader.user.js',
  logLevel: 'info',
});
