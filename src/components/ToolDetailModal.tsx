import React, { useState, useEffect } from 'react';
import { X, Download, QrCode, Shield, Check, Copy, ExternalLink, Calendar, HardDrive, Star, Terminal, Smartphone, Code2, Eye, EyeOff } from 'lucide-react';
import { ApkTool } from '../types';

interface ToolDetailModalProps {
  tool: ApkTool | null;
  isOpen: boolean;
  onClose: () => void;
  onDownload: (tool: ApkTool) => void;
}

export const ToolDetailModal: React.FC<ToolDetailModalProps> = ({
  tool,
  isOpen,
  onClose,
  onDownload,
}) => {
  const [copiedHash, setCopiedHash] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [scriptCode, setScriptCode] = useState<string>('');
  const [isLoadingScript, setIsLoadingScript] = useState<boolean>(false);
  const [showScriptViewer, setShowScriptViewer] = useState<boolean>(false);

  const isTampermonkey = !!(tool && (tool.category === 'Tampermonkey' || tool.downloadUrl.includes('.user.js') || tool.scriptFileName));

  useEffect(() => {
    if (isOpen && tool && isTampermonkey) {
      setShowScriptViewer(false);
      setScriptCode('');
      setIsLoadingScript(true);
      const targetScriptUrl = tool.downloadUrl.endsWith('.user.js')
        ? tool.downloadUrl
        : (tool.scriptFileName ? `/api/download/${tool.scriptFileName}` : `/api/download/${tool.id}.user.js`);

      fetch(targetScriptUrl)
        .then((r) => (r.ok ? r.text() : ''))
        .then((code) => {
          setScriptCode(code);
          setIsLoadingScript(false);
        })
        .catch(() => {
          setIsLoadingScript(false);
        });
    }
  }, [isOpen, tool, isTampermonkey]);

  if (!isOpen || !tool) return null;

  const bridgeUrl = `${window.location.origin}/api/tools/${tool.id}/download`;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(bridgeUrl)}`;

  const handleCopyHash = () => {
    navigator.clipboard.writeText(tool.checksumSha256);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  };

  const handleCopyScriptCode = () => {
    if (!scriptCode) return;
    navigator.clipboard.writeText(scriptCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const directScriptUrl = tool.downloadUrl.endsWith('.user.js')
    ? tool.downloadUrl
    : (tool.scriptFileName ? `/api/download/${tool.scriptFileName}` : `/api/download/${tool.id}.user.js`);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-3xl bg-[#0a0a0c] border border-white/10 rounded-2xl p-4 sm:p-8 shadow-2xl overflow-hidden text-slate-200 max-h-[92vh] overflow-y-auto">
        {/* Glow corner background */}
        <div className="absolute top-0 right-0 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none"></div>

        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 sm:top-5 sm:right-5 text-slate-400 hover:text-white p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors z-10"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Header Section */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-white/10 pb-4 sm:pb-6 mb-4 sm:mb-6 pr-8 sm:pr-0">
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-indigo-600/20 border border-cyan-400/30 flex items-center justify-center text-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.15)] shrink-0">
              {isTampermonkey ? <Code2 className="h-6 w-6 sm:h-8 sm:w-8 text-amber-400" /> : <Smartphone className="h-6 w-6 sm:h-8 sm:w-8 text-cyan-400" />}
            </div>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg sm:text-xl font-bold font-sans text-white">{tool.name}</h2>
                <span className="bg-cyan-500/10 border border-cyan-400/20 px-2 py-0.5 rounded text-[10px] font-mono text-cyan-400 font-bold uppercase tracking-wider">
                  {tool.version}
                </span>
              </div>
              <p className="text-xs font-mono text-slate-400 mt-0.5 truncate">{tool.packageName}</p>
            </div>
          </div>

          {/* Quick Category & Rating */}
          <div className="flex items-center gap-2 sm:gap-3">
            <span className={`px-2.5 py-1 rounded-full text-xs font-mono border ${
              isTampermonkey ? 'bg-amber-500/10 border-amber-400/30 text-amber-300' : 'bg-white/5 border-white/10 text-slate-300'
            }`}>
              {isTampermonkey ? '🐵 Tampermonkey' : tool.category}
            </span>
            <div className="flex items-center gap-1 text-amber-400 text-xs font-mono font-bold bg-amber-400/10 border border-amber-400/20 px-2.5 py-1 rounded-full">
              <Star className="h-3.5 w-3.5 fill-amber-400" />
              <span>{tool.rating.toFixed(1)}</span>
            </div>
          </div>
        </div>

        {/* Main Info Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          {/* Left 2 cols: Overview, Changelog, Screenshots */}
          <div className="md:col-span-2 space-y-6">
            {/* Description */}
            <div>
              <h3 className="text-xs font-mono uppercase tracking-widest text-slate-400 font-bold mb-2">
                {isTampermonkey ? '腳本說明 / ABOUT SCRIPT' : '工具說明 / ABOUT TOOL'}
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed font-light bg-white/5 border border-white/5 rounded-xl p-4">
                {tool.description}
              </p>
            </div>

            {/* Screenshots */}
            {tool.screenshots && tool.screenshots.length > 0 && (
              <div>
                <h3 className="text-xs font-mono uppercase tracking-widest text-slate-400 font-bold mb-2">
                  畫面預覽 / SCREENSHOTS
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  {tool.screenshots.map((src, i) => (
                    <img
                      key={i}
                      src={src}
                      alt={`${tool.name} preview ${i + 1}`}
                      className="w-full h-32 object-cover rounded-xl border border-white/10 hover:border-cyan-400/40 transition-all cursor-pointer"
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Script Code Viewer */}
            {isTampermonkey && showScriptViewer && (
              <div className="animate-in fade-in zoom-in-95 duration-200">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-mono uppercase tracking-widest text-amber-400 font-bold flex items-center gap-1.5">
                    <Code2 className="h-4 w-4" /> 腳本源代碼 / SCRIPT SOURCE CODE
                  </h3>
                  <button
                    onClick={handleCopyScriptCode}
                    className="text-xs font-mono text-cyan-400 hover:text-cyan-300 flex items-center gap-1 bg-cyan-500/10 px-2 py-1 rounded border border-cyan-400/20"
                  >
                    {copiedCode ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                    <span>{copiedCode ? '已複製全部代碼' : '複製全部代碼'}</span>
                  </button>
                </div>
                <div className="relative bg-black/80 border border-amber-400/20 rounded-xl p-3 font-mono text-[11px] text-amber-200/90 max-h-64 overflow-y-auto overflow-x-auto select-all leading-relaxed whitespace-pre font-mono">
                  {isLoadingScript ? (
                    <div className="p-4 text-center text-slate-400">正在讀取腳本代碼...</div>
                  ) : (
                    scriptCode || '尚未載入或暫無腳本內容'
                  )}
                </div>
              </div>
            )}

            {/* Changelog */}
            <div>
              <h3 className="text-xs font-mono uppercase tracking-widest text-slate-400 font-bold mb-2">
                更新日誌 / CHANGELOG ({tool.version})
              </h3>
              <div className="bg-black/40 border border-white/5 rounded-xl p-4 font-mono text-xs space-y-2">
                {tool.changelog.map((log, i) => (
                  <div key={i} className="flex items-start gap-2 text-slate-300">
                    <span className="text-cyan-400 font-bold">›</span>
                    <span className="font-light">{log}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right col: Technical Specs, Download, QR Code */}
          <div className="space-y-4">
            {/* Download CTA Card */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-5 space-y-3">
              <button
                onClick={() => onDownload(tool)}
                className={`w-full py-3 text-slate-950 font-mono text-xs font-bold tracking-wider uppercase rounded-xl transition-all shadow-[0_0_20px_rgba(34,211,238,0.2)] flex items-center justify-center gap-2 active:scale-95 ${
                  isTampermonkey ? 'bg-amber-400 hover:bg-amber-300' : 'bg-cyan-500 hover:bg-cyan-400'
                }`}
              >
                <Download className="h-4 w-4" />
                <span>{isTampermonkey ? '立即安裝腳本 (.user.js)' : `下載 APK 套件 (${tool.fileSize})`}</span>
              </button>

              {isTampermonkey && scriptCode && (
                <button
                  onClick={handleCopyScriptCode}
                  className="w-full py-2.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-400/30 text-amber-300 font-mono text-xs uppercase tracking-wider rounded-xl transition-all flex items-center justify-center gap-2"
                >
                  {copiedCode ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                  <span>{copiedCode ? '腳本代碼已複製！' : '複製腳本完整代碼'}</span>
                </button>
              )}

              {isTampermonkey && (
                <a
                  href={directScriptUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="w-full py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white font-mono text-xs uppercase tracking-wider rounded-xl transition-all flex items-center justify-center gap-2"
                >
                  <ExternalLink className="h-4 w-4 text-cyan-400" />
                  <span>在新分頁開啟 .user.js 網址</span>
                </a>
              )}

              <button
                onClick={() => setShowQr(!showQr)}
                className="w-full py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white font-mono text-xs uppercase tracking-wider rounded-xl transition-all flex items-center justify-center gap-2"
              >
                <QrCode className="h-4 w-4 text-cyan-400" />
                <span>{showQr ? '隱藏 QR Code' : '手機掃描 QR Code'}</span>
              </button>

              {isTampermonkey && (
                <button
                  onClick={() => setShowScriptViewer(!showScriptViewer)}
                  className="w-full py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white font-mono text-xs uppercase tracking-wider rounded-xl transition-all flex items-center justify-center gap-2"
                >
                  {showScriptViewer ? <EyeOff className="h-4 w-4 text-amber-400" /> : <Eye className="h-4 w-4 text-amber-400" />}
                  <span>{showScriptViewer ? '收合腳本代碼' : '檢視腳本源代碼'}</span>
                </button>
              )}

              {tool.externalBackupUrl && (
                <a
                  href={tool.externalBackupUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="w-full py-2 bg-black/40 hover:bg-black/60 border border-white/5 text-slate-400 hover:text-slate-200 font-mono text-[11px] rounded-xl transition-all flex items-center justify-center gap-1.5"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>備用雲端連結 / GitHub</span>
                </a>
              )}
            </div>

            {/* QR Code display */}
            {showQr && (
              <div className="bg-white p-4 rounded-2xl flex flex-col items-center justify-center animate-in zoom-in-95 duration-150">
                <img src={qrImageUrl} alt="Download QR Code" className="w-40 h-40" />
                <p className="text-[10px] font-mono text-slate-800 font-bold uppercase tracking-wider mt-2">
                  使用手機相機掃描下載
                </p>
              </div>
            )}

            {/* Technical Specifications */}
            <div className="bg-black/40 border border-white/5 rounded-2xl p-4 font-mono text-[11px] space-y-2.5">
              <div className="flex justify-between border-b border-white/5 pb-1.5">
                <span className="text-slate-500 uppercase">支援系統:</span>
                <span className="text-slate-200">{tool.minSdk}</span>
              </div>
              {!isTampermonkey && (
                <div className="flex justify-between border-b border-white/5 pb-1.5">
                  <span className="text-slate-500 uppercase">架構 (Arch):</span>
                  <span className="text-cyan-400">{tool.architecture}</span>
                </div>
              )}
              <div className="flex justify-between border-b border-white/5 pb-1.5">
                <span className="text-slate-500 uppercase">發布日期:</span>
                <span className="text-slate-200">{tool.releaseDate}</span>
              </div>
              <div className="flex justify-between border-b border-white/5 pb-1.5">
                <span className="text-slate-500 uppercase">{isTampermonkey ? '安裝次數:' : '下載次數:'}</span>
                <span className="text-indigo-400">{tool.downloadCount.toLocaleString()}</span>
              </div>
            </div>

            {/* SHA256 Checksum */}
            <div className="bg-white/5 border border-white/5 rounded-xl p-3 text-[10px] font-mono">
              <div className="flex items-center justify-between text-slate-400 mb-1">
                <span className="flex items-center gap-1 text-slate-400 uppercase font-bold">
                  <Shield className="h-3 w-3 text-cyan-400" /> SHA256 Checksum
                </span>
                <button
                  onClick={handleCopyHash}
                  className="text-cyan-400 hover:text-cyan-300 flex items-center gap-0.5 focus:outline-none"
                >
                  {copiedHash ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedHash ? '已複製' : '複製'}</span>
                </button>
              </div>
              <p className="text-slate-400 break-all select-all font-light opacity-80">
                {tool.checksumSha256}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
