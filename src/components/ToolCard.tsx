import React, { useState } from 'react';
import { Download, QrCode, Star, Sparkles, Smartphone, Cpu, Activity, Terminal, Trash2, Code2, Globe } from 'lucide-react';
import { ApkTool } from '../types';

interface ToolCardProps {
  tool: ApkTool;
  onSelect: (tool: ApkTool) => void;
  onDownload: (tool: ApkTool) => void;
  onDelete?: (toolId: string) => void;
  isUnlocked?: boolean;
}

export const ToolCard: React.FC<ToolCardProps> = ({ tool, onSelect, onDownload, onDelete, isUnlocked }) => {
  const [qrOpen, setQrOpen] = useState(false);

  const bridgeUrl = `${window.location.origin}/api/tools/${tool.id}/download`;

  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(bridgeUrl)}`;

  const isTampermonkey = tool.category === 'Tampermonkey' || tool.downloadUrl.includes('.user.js');

  // Icon selector based on category / string
  const renderIcon = () => {
    if (isTampermonkey) return <Code2 className="h-6 w-6 text-amber-400" />;
    switch (tool.icon) {
      case 'Activity': return <Activity className="h-6 w-6 text-emerald-400" />;
      case 'Terminal': return <Terminal className="h-6 w-6 text-purple-400" />;
      case 'Cpu': return <Cpu className="h-6 w-6 text-amber-400" />;
      case 'Sparkles': default: return <Sparkles className="h-6 w-6 text-cyan-400" />;
    }
  };

  return (
    <div className="group relative bg-[#0a0a0c] border border-white/10 hover:border-cyan-400/40 rounded-2xl p-3.5 sm:p-5 transition-all duration-300 hover:shadow-[0_0_30px_rgba(34,211,238,0.12)] flex flex-col justify-between">
      {/* Background Subtle Accent Glow */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/5 rounded-full blur-2xl group-hover:bg-cyan-500/10 transition-all pointer-events-none"></div>

      <div>
        {/* Top Header Row */}
        <div className="flex items-start justify-between gap-2 sm:gap-3 mb-2.5 sm:mb-3">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br from-cyan-500/10 to-indigo-600/10 border border-white/10 group-hover:border-cyan-400/30 flex items-center justify-center transition-all shrink-0">
              {renderIcon()}
            </div>
            <div className="truncate">
              <h3 
                onClick={() => onSelect(tool)}
                className="font-bold text-xs sm:text-sm text-white group-hover:text-cyan-300 transition-colors cursor-pointer truncate"
              >
                {tool.name}
              </h3>
              <p className="text-[10px] sm:text-[11px] font-mono text-slate-400 truncate max-w-[130px] sm:max-w-[180px]">
                {tool.packageName}
              </p>
            </div>
          </div>

          {/* Rating Badge or Delete Button */}
          <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
            {isUnlocked && onDelete && (
              <button
                onClick={() => onDelete(tool.id)}
                className="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 transition-all"
                title="刪除此項目"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
            <div className="flex items-center gap-1 bg-white/5 border border-white/10 px-1.5 py-0.5 sm:px-2 rounded-md text-[10px] font-mono text-amber-400">
              <Star className="h-3 w-3 fill-amber-400 shrink-0" />
              <span>{tool.rating.toFixed(1)}</span>
            </div>
          </div>
        </div>

        {/* Badges: Version, Category, Arch, Size */}
        <div className="flex flex-wrap items-center gap-1 sm:gap-1.5 mb-2.5 sm:mb-3 font-mono text-[10px]">
          <span className="bg-cyan-500/10 border border-cyan-400/20 text-cyan-400 px-1.5 py-0.5 rounded font-bold">
            {tool.version}
          </span>
          <span className={`px-1.5 py-0.5 rounded border ${isTampermonkey ? 'bg-amber-500/10 border-amber-400/30 text-amber-300 font-bold' : 'bg-white/5 border-white/10 text-slate-300'}`}>
            {isTampermonkey ? '🐵 Tampermonkey' : tool.category}
          </span>
          {tool.architecture && !isTampermonkey && (
            <span className="bg-white/5 border border-white/5 text-slate-400 px-1.5 py-0.5 rounded">
              {tool.architecture}
            </span>
          )}
          <span className="bg-white/5 border border-white/5 text-slate-400 px-1.5 py-0.5 rounded">
            {tool.fileSize}
          </span>
        </div>

        {/* Summary Description */}
        <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed font-light mb-3 sm:mb-4">
          {tool.summary}
        </p>
      </div>

      {/* QR Code Popup overlay if clicked */}
      {qrOpen && (
        <div className="my-2 p-3 bg-white rounded-xl flex flex-col items-center animate-in zoom-in-95 duration-150">
          <img src={qrImageUrl} alt="QR Code" className="w-28 h-28" />
          <p className="text-[9px] font-mono text-slate-900 font-bold uppercase mt-1">
            {isTampermonkey ? '手機/平板掃描取得腳本' : '手機掃描直接下載 APK'}
          </p>
        </div>
      )}

      {/* Bottom Action Footer */}
      <div className="pt-2.5 sm:pt-3 border-t border-white/5 flex items-center justify-between gap-1 sm:gap-2">
        <div className="text-[10px] font-mono text-slate-400 shrink-0">
          <span className="text-cyan-400 font-bold">{tool.downloadCount.toLocaleString()}</span> {isTampermonkey ? '安裝' : '下載'}
        </div>

        <div className="flex items-center gap-1 sm:gap-1.5">
          {/* QR Code Toggle */}
          <button
            onClick={() => setQrOpen(!qrOpen)}
            className="p-1.5 sm:p-2 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-cyan-400 transition-colors shrink-0"
            title="掃描 QR Code"
          >
            <QrCode className="h-3.5 w-3.5" />
          </button>

          {/* View Details */}
          <button
            onClick={() => onSelect(tool)}
            className="px-2 py-1.5 sm:px-2.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white text-[10px] sm:text-[11px] font-mono transition-colors shrink-0"
          >
            詳情
          </button>

          {/* Download / Install Script */}
          <button
            onClick={() => onDownload(tool)}
            className={`px-2.5 sm:px-3 py-1.5 rounded-lg text-slate-950 text-[10px] sm:text-[11px] font-mono font-bold tracking-wider uppercase transition-all flex items-center gap-1 active:scale-95 shadow-[0_0_10px_rgba(34,211,238,0.2)] shrink-0 ${
              isTampermonkey ? 'bg-amber-400 hover:bg-amber-300' : 'bg-cyan-500 hover:bg-cyan-400'
            }`}
          >
            <Download className="h-3.5 w-3.5 shrink-0" />
            <span>{isTampermonkey ? '安裝腳本' : '下載'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
