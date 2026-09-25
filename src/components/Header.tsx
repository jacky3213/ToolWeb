import React from 'react';
import { Smartphone, Plus, HelpCircle, ShieldCheck, Lock, Unlock, RefreshCw, FileCode, Code2 } from 'lucide-react';

interface HeaderProps {
  toolCount: number;
  totalDownloads: number;
  onOpenAddModal: () => void;
  onOpenInstallGuide: () => void;
  onOpenAdminModal: () => void;
  onSyncDrive: () => void;
  isSyncingDrive: boolean;
  isUnlocked: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  toolCount,
  totalDownloads,
  onOpenAddModal,
  onOpenInstallGuide,
  onOpenAdminModal,
  onSyncDrive,
  isSyncingDrive,
  isUnlocked,
}) => {
  return (
    <header className="border-b border-white/5 bg-[#020203]/90 px-3 sm:px-8 py-3 sm:py-4 backdrop-blur-md sticky top-0 z-40">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 sm:gap-4">
        {/* Brand & Logo */}
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className="relative flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-cyan-500/20 to-indigo-600/20 border border-cyan-400/30 text-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.15)] shrink-0">
            <Code2 className="h-4 w-4 sm:h-5 sm:w-5" />
            <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-400"></span>
            </span>
          </div>

          <div className="truncate">
            <div className="flex items-center gap-2">
              <span className="text-xs sm:text-sm font-bold font-mono tracking-wider sm:tracking-widest text-white uppercase truncate">
                DEV.STUDIO <span className="hidden xs:inline text-cyan-400">// TOOLBOX</span>
              </span>
              <span className="hidden md:inline-flex items-center gap-1 rounded bg-cyan-400/10 px-2 py-0.5 text-[10px] font-mono text-cyan-400 border border-cyan-400/20">
                <ShieldCheck className="h-3 w-3" /> APK & Scripts
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-light hidden sm:block">
              Android APK 套件與 Tampermonkey 腳本發布中心
            </p>
          </div>
        </div>

        {/* Stats & Actions */}
        <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
          {/* Sync Google Drive Button */}
          <button
            onClick={onSyncDrive}
            disabled={isSyncingDrive}
            className="flex items-center gap-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-400/30 px-2 py-1.5 sm:px-2.5 sm:py-2 text-xs font-mono text-emerald-300 transition-all active:scale-95 disabled:opacity-50"
            title="立即從 Google Drive 重新同步 APK/腳本 與設定"
          >
            <RefreshCw className={`h-3.5 w-3.5 text-emerald-400 shrink-0 ${isSyncingDrive ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">{isSyncingDrive ? '同步中' : '同步 Drive'}</span>
          </button>

          {/* Admin Lock Status Button */}
          <button
            onClick={onOpenAdminModal}
            className={`flex items-center gap-1 sm:gap-1.5 rounded-lg px-2 py-1.5 sm:px-2.5 text-xs font-mono border transition-all ${
              isUnlocked
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20'
                : 'bg-cyan-950/40 border-cyan-500/30 text-cyan-300 hover:bg-cyan-900/50'
            }`}
            title="管理員權限驗證與密碼設定"
          >
            {isUnlocked ? (
              <>
                <Unlock className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                <span className="hidden md:inline">已解鎖</span>
              </>
            ) : (
              <>
                <Lock className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
                <span className="hidden md:inline">管理防護</span>
              </>
            )}
          </button>

          {/* Quick Metrics */}
          <div className="hidden xl:flex items-center gap-4 text-[10px] font-mono tracking-wider text-slate-400 bg-white/5 border border-white/5 px-3.5 py-1.5 rounded-lg">
            <div className="flex items-center gap-1.5">
              <span className="text-slate-500 uppercase">Tools:</span>
              <span className="text-cyan-400 font-bold">{toolCount}</span>
            </div>
            <div className="w-px h-3 bg-white/10"></div>
            <div className="flex items-center gap-1.5">
              <span className="text-slate-500 uppercase">Downloads:</span>
              <span className="text-indigo-400 font-bold">{totalDownloads.toLocaleString()}</span>
            </div>
          </div>

          {/* Installation & Setup Guide Button */}
          <button
            onClick={onOpenInstallGuide}
            className="flex items-center gap-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 px-2 py-1.5 sm:px-2.5 sm:py-2 text-xs font-mono text-slate-300 transition-all hover:text-white active:scale-95"
            title="安裝與使用說明"
          >
            <HelpCircle className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
            <span className="hidden sm:inline">使用說明</span>
          </button>

          {/* Add Tool Button */}
          <button
            onClick={onOpenAddModal}
            className="flex items-center gap-1 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 px-2.5 py-1.5 sm:px-3 sm:py-2 text-xs font-mono font-bold tracking-wider uppercase transition-all shadow-[0_0_20px_rgba(34,211,238,0.2)] active:scale-95 shrink-0"
          >
            <Plus className="h-4 w-4 shrink-0" />
            <span className="text-[11px] sm:text-xs">上架</span>
          </button>
        </div>
      </div>
    </header>
  );
};
