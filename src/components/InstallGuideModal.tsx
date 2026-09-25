import React, { useState } from 'react';
import { X, ShieldAlert, Smartphone, CheckCircle2, FileCheck, Info, Code2, Globe } from 'lucide-react';

interface InstallGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const InstallGuideModal: React.FC<InstallGuideModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'all' | 'apk' | 'tampermonkey'>('all');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl bg-[#0a0a0c] border border-white/10 rounded-2xl p-4 sm:p-8 shadow-2xl overflow-hidden text-slate-200 max-h-[92vh] overflow-y-auto">
        {/* Top Accent Line */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-cyan-500 via-indigo-500 to-purple-500"></div>

        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 sm:top-5 sm:right-5 text-slate-400 hover:text-white p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors z-10"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-3 mb-5 sm:mb-6 pr-8">
          <div className="p-2 sm:p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-400/20 text-cyan-400 shrink-0">
            <Code2 className="h-5 w-5 sm:h-6 sm:w-6" />
          </div>
          <div>
            <h2 className="text-lg sm:text-xl font-bold font-sans text-white">APK 與 Tampermonkey 腳本安裝說明</h2>
            <p className="text-[10px] sm:text-xs font-mono text-cyan-400 tracking-wider uppercase mt-0.5">
              INSTALLATION & SETUP GUIDE
            </p>
          </div>
        </div>

        {/* Tampermonkey Script Installation Section */}
        <div className="mb-6 space-y-3">
          <h3 className="text-sm font-mono uppercase tracking-widest text-cyan-300 font-bold flex items-center gap-2">
            <Globe className="h-4 w-4 text-cyan-400" /> 🐵 Tampermonkey (油猴) 腳本安裝步驟
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white/5 border border-white/5 p-4 rounded-xl flex flex-col justify-between">
              <div>
                <span className="inline-block px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 font-mono text-[10px] font-bold mb-2">
                  STEP 01
                </span>
                <h4 className="text-xs font-bold text-white mb-1">安裝 Tampermonkey 擴充</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed font-light">
                  在 Chrome、Edge 或 Firefox 擴充商店安裝 Tampermonkey 擴充套件。
                </p>
              </div>
            </div>

            <div className="bg-white/5 border border-white/5 p-4 rounded-xl flex flex-col justify-between">
              <div>
                <span className="inline-block px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-400 font-mono text-[10px] font-bold mb-2">
                  STEP 02
                </span>
                <h4 className="text-xs font-bold text-white mb-1">點擊腳本連結</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed font-light">
                  在本站工具列表中點擊「立即安裝」或「下載/安裝腳本」，瀏覽器會自動識別 `.user.js`。
                </p>
              </div>
            </div>

            <div className="bg-white/5 border border-white/5 p-4 rounded-xl flex flex-col justify-between">
              <div>
                <span className="inline-block px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono text-[10px] font-bold mb-2">
                  STEP 03
                </span>
                <h4 className="text-xs font-bold text-white mb-1">確認並啟用</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed font-light">
                  Tampermonkey 會自動攔截以 <code className="text-cyan-300">.user.js</code> 結尾的腳本網址並彈出安裝確認視窗，點擊「安裝」即可自動生效！
                </p>
              </div>
            </div>
          </div>
          <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-300/90 leading-relaxed">
            💡 <b>小提示：</b> 如果點擊安裝後瀏覽器只顯示文字代碼而未彈出安裝視窗，請確認您的瀏覽器已安裝並<b>啟用 Tampermonkey (油猴) 擴充套件</b>，並確認已在 Tampermonkey 設定中開啟「允許存取檔案網址」或允許偵測使用者腳本。
          </div>

          {/* Troubleshooting: Allow User Scripts (most common issue) */}
          <div className="p-4 bg-yellow-500/[0.07] border border-yellow-500/25 rounded-xl space-y-3">
            <h4 className="text-xs font-bold text-yellow-400 flex items-center gap-1.5">
              ⚠️ 安裝成功但腳本不執行？（頁面上沒有出現腳本面板）
            </h4>
            <div className="space-y-1.5">
              {[
                <>開啟 Chrome／Edge，網址列輸入 <code className="bg-white/10 px-1.5 py-0.5 rounded text-yellow-200 font-mono text-[11px]">chrome://extensions</code>（Edge 為 <code className="bg-white/10 px-1.5 py-0.5 rounded text-yellow-200 font-mono text-[11px]">edge://extensions</code>）</>,
                <>找到 <b className="text-white">Tampermonkey</b>，點「<b className="text-white">詳細資料</b>」</>,
                <>找到「<b className="text-white">允許使用者指令碼</b>」（Allow User Scripts）開關 → <b className="text-white">打開</b></>,
                <>重新整理目標網站頁面，腳本面板應該就會出現</>,
              ].map((content, i) => (
                <div key={i} className="flex items-start gap-2.5 text-[11px] text-slate-300 leading-relaxed">
                  <span className="shrink-0 w-4 h-4 rounded-full bg-yellow-600/60 text-white text-[9px] font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                  <span>{content}</span>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-slate-500 leading-relaxed border-t border-yellow-500/15 pt-2">
              說明：新版 Chrome／Edge 對使用者腳本新增了獨立權限開關，<b className="text-slate-400">只開瀏覽器的「開發人員模式」不夠</b>——沒開「允許使用者指令碼」時，腳本裝得進去但完全不會執行，這是最常見的安裝問題。
            </p>
          </div>
        </div>

        {/* Steps to Install APK on Phone */}
        <div className="space-y-4">
          <h3 className="text-sm font-mono uppercase tracking-widest text-slate-400 font-bold flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-amber-400" /> 📱 手機安裝 APK 步驟 (Android 系統)
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white/5 border border-white/5 p-4 rounded-xl flex flex-col justify-between">
              <div>
                <span className="inline-block px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 font-mono text-[10px] font-bold mb-2">
                  STEP 01
                </span>
                <h4 className="text-xs font-bold text-white mb-1">下載 APK 檔案</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed font-light">
                  點擊工具頁面的「直接下載」或用手機掃描 QR Code 下載 `.apk` 檔案。
                </p>
              </div>
            </div>

            <div className="bg-white/5 border border-white/5 p-4 rounded-xl flex flex-col justify-between">
              <div>
                <span className="inline-block px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-400 font-mono text-[10px] font-bold mb-2">
                  STEP 02
                </span>
                <h4 className="text-xs font-bold text-white mb-1">允許未知來源安裝</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed font-light">
                  開啟檔案時若跳出提醒，進入「設定」選擇<b>「允許來自此來源的應用程式」</b>。
                </p>
              </div>
            </div>

            <div className="bg-white/5 border border-white/5 p-4 rounded-xl flex flex-col justify-between">
              <div>
                <span className="inline-block px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono text-[10px] font-bold mb-2">
                  STEP 03
                </span>
                <h4 className="text-xs font-bold text-white mb-1">完成安裝與使用</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed font-light">
                  點擊「安裝」後即可開啟並開始體驗您開發的 Android 工具！
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 pt-4 border-t border-white/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-bold tracking-wider uppercase rounded-xl transition-all flex items-center gap-1.5"
          >
            <CheckCircle2 className="h-4 w-4" /> 我瞭解了
          </button>
        </div>
      </div>
    </div>
  );
};
