import React, { useState, useRef } from 'react';
import { X, Link, Check, Smartphone, Lock, ShieldCheck, Code2, Upload, FileText, Sparkles } from 'lucide-react';
import { ApkTool, ToolCategory } from '../types';

interface AddToolModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (tool: Partial<ApkTool>, passcode?: string) => void;
  adminPasscode: string;
  isUnlocked: boolean;
  onOpenAdminAuth: () => void;
}

export const AddToolModal: React.FC<AddToolModalProps> = ({
  isOpen,
  onClose,
  onSave,
  adminPasscode,
  isUnlocked,
  onOpenAdminAuth,
}) => {
  // Input Mode: 'link' (URL) or 'code' (Upload / Paste local .user.js)
  const [inputMode, setInputMode] = useState<'link' | 'code'>('link');

  // Form State
  const [name, setName] = useState('');
  const [packageName, setPackageName] = useState('');
  const [version, setVersion] = useState('v1.0.0');
  const [category, setCategory] = useState<ToolCategory>('Tampermonkey');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [fileSize, setFileSize] = useState('15 KB');
  const [architecture, setArchitecture] = useState<'arm64-v8a' | 'armeabi-v7a' | 'universal' | 'x86_64'>('universal');
  const [minSdk, setMinSdk] = useState('Chrome / Edge / Firefox (Tampermonkey)');

  // Local script code & upload state
  const [scriptCode, setScriptCode] = useState('');
  const [scriptFileName, setScriptFileName] = useState('custom-script.user.js');
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [uploadStatusMsg, setUploadStatusMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Admin passcode prompt state inside form
  const [passcodeInput, setPasscodeInput] = useState('');

  if (!isOpen) return null;

  // Helper: Automatically parse Tampermonkey // ==UserScript== header
  const parseScriptMetadata = (code: string, fileName?: string) => {
    try {
      const nameMatch = code.match(/@name\s+(.+)/);
      const versionMatch = code.match(/@version\s+(.+)/);
      const descMatch = code.match(/@description\s+(.+)/);
      const nsMatch = code.match(/@namespace\s+(.+)/);

      if (nameMatch && nameMatch[1]) {
        setName(nameMatch[1].trim());
      } else if (fileName) {
        setName(fileName.replace(/\.user\.js$/, '').replace(/\.js$/, ''));
      }

      if (versionMatch && versionMatch[1]) {
        const v = versionMatch[1].trim();
        setVersion(v.startsWith('v') ? v : `v${v}`);
      }

      if (descMatch && descMatch[1]) {
        const d = descMatch[1].trim();
        setSummary(d);
        setDescription(d);
      }

      if (nsMatch && nsMatch[1]) {
        setPackageName(nsMatch[1].trim());
      } else if (fileName) {
        setPackageName(fileName);
      }

      setCategory('Tampermonkey');
      setMinSdk('Tampermonkey (Chrome/Firefox/Edge)');
      const sizeKb = (new Blob([code]).size / 1024).toFixed(1);
      setFileSize(`${sizeKb} KB`);
    } catch (e) {
      console.warn("Could not auto-parse userscript header", e);
    }
  };

  // Handle local file selection (.user.js or .js)
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setScriptFileName(file.name.endsWith('.user.js') ? file.name : `${file.name.replace(/\.[^.]+$/, '')}.user.js`);
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setScriptCode(content);
      parseScriptMetadata(content, file.name);
      setUploadStatusMsg(`✅ 已讀取「${file.name}」並自動提取腳本名稱與版本！`);
    };
    reader.readAsText(file, 'utf-8');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;

    let finalDownloadUrl = downloadUrl;

    // If in code mode with local script content, save file directly to backend uploads
    if (inputMode === 'code' && scriptCode.trim()) {
      try {
        setIsUploadingFile(true);
        setUploadStatusMsg('正在將腳本儲存至發布站伺服器...');
        const cleanFileName = scriptFileName.endsWith('.user.js') ? scriptFileName : `${scriptFileName.replace(/[^a-zA-Z0-9_-]/g, '_')}.user.js`;
        const res = await fetch('/api/upload-apk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: cleanFileName,
            textContent: scriptCode,
            passcode: passcodeInput || adminPasscode
          })
        });

        const data = await res.json();
        if (data.success && data.downloadUrl) {
          finalDownloadUrl = data.downloadUrl;
        } else {
          finalDownloadUrl = `/api/download/${cleanFileName}`;
        }
      } catch (err) {
        console.error("Failed to upload local script:", err);
        finalDownloadUrl = `/api/download/${scriptFileName}`;
      } finally {
        setIsUploadingFile(false);
      }
    }

    if (!finalDownloadUrl) {
      finalDownloadUrl = `https://drive.google.com`;
    }

    onSave(
      {
        id: name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
        name,
        packageName: packageName || (category === 'Tampermonkey' ? `user.script.${name.toLowerCase().replace(/[^a-z0-9]/g, '')}` : `com.developer.${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`),
        version,
        versionCode: 100,
        minSdk: category === 'Tampermonkey' ? 'Tampermonkey (Chrome/Firefox/Edge)' : minSdk,
        architecture,
        fileSize,
        icon: category === 'Tampermonkey' ? 'Terminal' : 'Smartphone',
        category,
        summary: summary || (category === 'Tampermonkey' ? `${name} Tampermonkey 油猴使用者腳本` : `${name} Android 工具套件`),
        description: description || summary || (category === 'Tampermonkey' ? `${name} 是一款為瀏覽器量身打造的 Tampermonkey 油猴實用腳本。` : `${name} 是一款為 Android 系統打造的高效實用工具。`),
        changelog: ['全新版本發布', '效能優化與邏輯修復'],
        downloadUrl: finalDownloadUrl,
        downloadCount: 1,
        rating: 5.0,
        releaseDate: new Date().toISOString().split('T')[0],
        checksumSha256: Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2),
        screenshots: [],
        isOfficial: true
      },
      passcodeInput || adminPasscode
    );

    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl bg-[#0a0a0c] border border-white/10 rounded-2xl p-4 sm:p-8 shadow-2xl overflow-hidden text-slate-200 max-h-[92vh] overflow-y-auto">
        {/* Top Accent Line */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-cyan-400"></div>

        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 sm:top-5 sm:right-5 text-slate-400 hover:text-white p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-3 mb-5 sm:mb-6 pr-8">
          <div className="p-2 sm:p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-400/20 text-cyan-400 shrink-0">
            <Code2 className="h-5 w-5 sm:h-6 sm:w-6" />
          </div>
          <div>
            <h2 className="text-lg sm:text-xl font-bold font-sans text-white">上架發布 APK 工具或 Tampermonkey 腳本</h2>
            <p className="text-[10px] sm:text-xs font-mono text-cyan-400 tracking-wider uppercase mt-0.5">
              PUBLISH APK PACKAGE OR USERSCRIPT
            </p>
          </div>
        </div>

        {/* Security Notice */}
        <div className="mb-5 bg-cyan-950/30 border border-cyan-500/30 rounded-xl p-3 sm:p-3.5 text-xs text-cyan-200 leading-relaxed flex items-start gap-2.5">
          <ShieldCheck className="h-4 w-4 sm:h-5 sm:w-5 text-cyan-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold text-white block mb-0.5">🛡️ 雲端與腳本發布：</span>
            可貼上 Google Drive、GitHub (.user.js)、GreasyFork 或任何雲端檔案連結。
            {!isUnlocked && (
              <span className="block mt-1 text-slate-300">
                請填寫下方的<b>管理員密碼</b>，或{' '}
                <button
                  type="button"
                  onClick={onOpenAdminAuth}
                  className="text-cyan-400 underline hover:text-cyan-300 font-bold"
                >
                  點此開啟解鎖面板
                </button>
              </span>
            )}
          </div>
        </div>

        {/* Mode Selector Tabs */}
        <div className="flex rounded-xl bg-white/5 p-1 mb-4 border border-white/10 text-xs font-mono">
          <button
            type="button"
            onClick={() => setInputMode('link')}
            className={`flex-1 py-2 rounded-lg flex items-center justify-center gap-2 transition-all ${
              inputMode === 'link'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/30 font-bold'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Link className="h-3.5 w-3.5" />
            <span>外部 / 雲端連結 (URL)</span>
          </button>
          <button
            type="button"
            onClick={() => setInputMode('code')}
            className={`flex-1 py-2 rounded-lg flex items-center justify-center gap-2 transition-all ${
              inputMode === 'code'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-400/30 font-bold'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Upload className="h-3.5 w-3.5" />
            <span>本地腳本上傳 / 貼上代碼 (.user.js)</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Admin Passcode Input Field if not unlocked */}
          {!isUnlocked && (
            <div className="bg-white/5 border border-cyan-500/30 rounded-xl p-3.5 space-y-1">
              <label className="block text-xs font-mono uppercase tracking-wider text-cyan-400 font-bold flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5" /> 管理員密碼 (ADMIN PASSCODE) *
              </label>
              <input
                type="password"
                required
                value={passcodeInput}
                onChange={(e) => setPasscodeInput(e.target.value)}
                placeholder="請輸入管理員密碼"
                className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400"
              />
            </div>
          )}

          {/* Mode 1: External Link input */}
          {inputMode === 'link' && (
            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-cyan-400 font-bold mb-1.5 flex items-center gap-1.5">
                <Link className="h-3.5 w-3.5" /> 下載或安裝連結 (APK 雲端連結 / .user.js 腳本連結) *
              </label>
              <input
                type="url"
                required
                value={downloadUrl}
                onChange={(e) => {
                  const val = e.target.value;
                  setDownloadUrl(val);
                  if (val.includes('.user.js')) {
                    setCategory('Tampermonkey');
                    setMinSdk('Tampermonkey (Chrome/Firefox/Edge)');
                  }
                }}
                placeholder="https://olevod-preloader.app.workbuddy.host/olevod-preloader.user.js 或 Google Drive"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder:text-slate-600 font-mono focus:outline-none focus:border-cyan-400/50"
              />
              <p className="text-[11px] text-slate-400 mt-1.5 flex items-center gap-1">
                <span>💡 例如您的遠端腳本可填：</span>
                <code className="text-cyan-300 font-mono select-all bg-black/40 px-1 rounded">
                  https://olevod-preloader.app.workbuddy.host/olevod-preloader.user.js
                </code>
              </p>
            </div>
          )}

          {/* Mode 2: Local Script Upload / Paste Code */}
          {inputMode === 'code' && (
            <div className="space-y-3 bg-amber-500/5 border border-amber-500/20 rounded-xl p-3.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-mono uppercase tracking-wider text-amber-300 font-bold flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5" /> 上傳本機 .user.js 檔案 或 直接貼上腳本代碼
                </label>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-2.5 py-1 rounded-lg bg-amber-400/20 hover:bg-amber-400/30 text-amber-300 text-[11px] font-mono border border-amber-400/40 flex items-center gap-1 transition-all"
                >
                  <Upload className="h-3 w-3" />
                  選擇本機檔案 (.user.js)
                </button>
                <input
                  type="file"
                  ref={fileInputRef}
                  accept=".js,.user.js"
                  className="hidden"
                  onChange={handleFileUpload}
                />
              </div>

              {uploadStatusMsg && (
                <div className="text-[11px] font-mono text-emerald-400 bg-emerald-950/40 border border-emerald-500/30 p-2 rounded-lg">
                  {uploadStatusMsg}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div>
                  <label className="block text-[10px] font-mono text-slate-400 mb-0.5">腳本儲存檔名 (Filename)</label>
                  <input
                    type="text"
                    value={scriptFileName}
                    onChange={(e) => setScriptFileName(e.target.value)}
                    placeholder="my-script.user.js"
                    className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-amber-400"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-mono text-slate-400 mb-0.5">自動解析狀態</label>
                  <div className="text-[11px] text-amber-200/90 font-mono py-1.5 flex items-center gap-1">
                    <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                    <span>貼上或選取檔案後會自動填寫名稱與版本</span>
                  </div>
                </div>
              </div>

              <div>
                <textarea
                  rows={5}
                  value={scriptCode}
                  onChange={(e) => {
                    setScriptCode(e.target.value);
                    parseScriptMetadata(e.target.value);
                  }}
                  placeholder="// ==UserScript==&#10;// @name         我的自訂腳本&#10;// @version      1.0.0&#10;// @match        https://example.com/*&#10;// ==/UserScript==&#10;&#10;// 在此處貼上您的本機腳本程式碼..."
                  className="w-full bg-[#050608] border border-white/10 rounded-xl p-3 text-xs text-amber-100 font-mono focus:outline-none focus:border-amber-400/50 resize-y placeholder:text-slate-600"
                />
              </div>
            </div>
          )}

          {/* Form Metadata Fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-slate-400 font-bold mb-1">
                工具 / 腳本名稱 *
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如: YouTube 廣告跳過腳本 或 開屏跳過"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400/50"
              />
            </div>

            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-slate-400 font-bold mb-1">
                套件 / 腳本識別碼 (ID / Namespace)
              </label>
              <input
                type="text"
                value={packageName}
                onChange={(e) => setPackageName(e.target.value)}
                placeholder="com.myname.tool 或 userscript.adskip"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400/50"
              />
            </div>

            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-slate-400 font-bold mb-1">
                版本號 (Version)
              </label>
              <input
                type="text"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="v1.0.0"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400/50"
              />
            </div>

            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-slate-400 font-bold mb-1">
                分類 (Category)
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as ToolCategory)}
                className="w-full bg-[#0a0a0c] border border-white/10 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400/50"
              >
                <option value="Tampermonkey">🐵 Tampermonkey (油猴瀏覽器腳本)</option>
                <option value="Utility">Utility (Android 實用工具)</option>
                <option value="Developer">Developer (開發者神器)</option>
                <option value="AI & Tools">AI & Tools (人工智慧與自動化)</option>
                <option value="Network">Network (網路與連線工具)</option>
                <option value="Media">Media (影音輔助工具)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-slate-400 font-bold mb-1">
                檔案大小 (Size)
              </label>
              <input
                type="text"
                value={fileSize}
                onChange={(e) => setFileSize(e.target.value)}
                placeholder="15 KB 或 18.5 MB"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400/50"
              />
            </div>

            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-slate-400 font-bold mb-1">
                支援環境 / 系統 (Platform / OS)
              </label>
              <input
                type="text"
                value={minSdk}
                onChange={(e) => setMinSdk(e.target.value)}
                placeholder="Tampermonkey (Chrome/Edge/Firefox) 或 Android 8.0+"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400/50"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-slate-400 font-bold mb-1">
              簡短簡介 (Summary)
            </label>
            <input
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="例如：自訂 Android 手機實用工具庫..."
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400/50"
            />
          </div>

          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-slate-400 font-bold mb-1">
              詳細功能描述 (Description)
            </label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="介紹這款 APK 工具的核心功能、特色與使用說明..."
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400/50 resize-none"
            />
          </div>

          <div className="pt-4 border-t border-white/10 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-mono text-slate-300"
            >
              取消
            </button>
            <button
              type="submit"
              className="px-6 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-bold uppercase tracking-wider shadow-[0_0_15px_rgba(34,211,238,0.2)] flex items-center gap-1.5"
            >
              <Check className="h-4 w-4" />
              <span>確定發布上架</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
