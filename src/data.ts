import { ApkTool } from './types';

// Built-in permanent tools stored directly in codebase
export const INITIAL_TOOLS: ApkTool[] = [
  {
    id: 'adskip-apk',
    name: '開屏跳過',
    packageName: 'com.utility.adskip',
    version: 'v1.4',
    versionCode: 140,
    minSdk: 'Android 7.0+ (API 24)',
    architecture: 'universal',
    fileSize: '762 KB',
    icon: 'Zap',
    category: 'Utility',
    summary: '自動點擊開屏廣告與半屏廣告的跳過',
    description: '無須root，純粹代為點擊開屏廣告與半屏廣告的跳過。協助您順暢開啟各類 App，減少等待時間與廣告干擾。',
    changelog: ['v1.4 增加半屏廣告判定與自動跳過', 'v1.3 優化開屏按鈕偵測速度', '無須 Root 權限', '極簡流暢與超低背景耗電'],
    downloadUrl: 'https://drive.google.com/drive/folders/14QqI6hdNNaThvOS8zIRtRrYzGdlrhdqI?usp=sharing',
    downloadCount: 920,
    rating: 5.0,
    releaseDate: '2026-08-09',
    checksumSha256: 'f8d2b1e4c9a6352018749aefcd12890a5b4c3d2e1f0987654321fedcba987654',
    screenshots: [],
    isOfficial: true,
    isFeatured: true
  }
];

