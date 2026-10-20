import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const userscriptHeader = `// ==UserScript==
// @name         YouTube 攔截下載 (MSE Capture Downloader)
// @name:en      YouTube MSE Capture Downloader
// @namespace    https://github.com/jacky3213
// @version      ${pkg.version}
// @description  攔截 YouTube 播放器的 SourceBuffer 分片，16x 靜音加速播放以快速抓取完整高畫質影片（視訊+音訊），不經第三方解析站。僅供個人備份，請遵守著作權法與 YouTube 服務條款。
// @description:en  Capture SourceBuffer segments from the YouTube player and fast-play at 16x to grab full HD video+audio. For personal backup only.
// @author       jacky3213
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
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
