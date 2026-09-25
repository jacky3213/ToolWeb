export type ToolCategory = 'All' | 'Tampermonkey' | 'Utility' | 'AI & Tools' | 'Network' | 'Developer' | 'Media';

export interface InstallGuideTroubleshooting {
  title: string;
  steps: string[];
  note?: string;
}

export interface InstallGuide {
  steps: string[];
  verify?: string;
  troubleshooting?: InstallGuideTroubleshooting;
}

export interface ApkTool {
  id: string;
  name: string;
  packageName: string;
  version: string;
  versionCode: number;
  minSdk: string;
  architecture: 'arm64-v8a' | 'armeabi-v7a' | 'universal' | 'x86_64';
  fileSize: string;
  icon: string; // Lucide icon name or image URL
  category: ToolCategory;
  summary: string;
  description: string;
  changelog: string[];
  downloadUrl: string;
  externalBackupUrl?: string;
  downloadCount: number;
  baseDownloadCount?: number;
  apkFileName?: string;
  scriptFileName?: string;
  rating: number;
  releaseDate: string;
  checksumSha256: string;
  screenshots: string[];
  installGuide?: InstallGuide;
  isFeatured?: boolean;
  isOfficial?: boolean;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: Date;
}
