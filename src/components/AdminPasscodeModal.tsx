import React, { useState } from 'react';
import { X, Lock, Key, ShieldCheck, Check, AlertCircle, Eye, EyeOff } from 'lucide-react';

interface AdminPasscodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  adminPasscode: string;
  onSavePasscode: (newCode: string, isRequired: boolean) => void;
  isProtectionEnabled: boolean;
  onVerifySuccess: () => void;
  isUnlocked: boolean;
}

export const AdminPasscodeModal: React.FC<AdminPasscodeModalProps> = ({
  isOpen,
  onClose,
  adminPasscode,
  onSavePasscode,
  isProtectionEnabled,
  onVerifySuccess,
  isUnlocked,
}) => {
  const [inputCode, setInputCode] = useState('');
  const [newCode, setNewCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  if (!isOpen) return null;

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputCode === adminPasscode || !isProtectionEnabled) {
      onVerifySuccess();
      setSuccessMsg('✅ 身分驗證成功！您現在已取得管理員解鎖權限。');
      setErrorMsg('');
      setTimeout(() => setSuccessMsg(''), 3000);
    } else {
      setErrorMsg('❌ 密碼不正確！請確認您的管理員密碼');
    }
  };

  const handleUpdatePasscode = (e: React.FormEvent) => {
    e.preventDefault();
    if (newCode.trim().length < 4) {
      setErrorMsg('新密碼長度至少需 4 個字元');
      return;
    }
    onSavePasscode(newCode.trim(), isProtectionEnabled);
    setSuccessMsg('✅ 管理員安全密碼已更新！');
    setNewCode('');
    setErrorMsg('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-md bg-[#0a0a0c] border border-white/10 rounded-2xl p-4 sm:p-6 shadow-2xl overflow-hidden text-slate-200 max-h-[92vh] overflow-y-auto">
        {/* Top Accent Bar */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-cyan-500 via-indigo-500 to-purple-500"></div>

        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white p-1.5 rounded-lg bg-white/5 hover:bg-white/10 z-10"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-3 mb-5 pr-8">
          <div className="p-2 sm:p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-400/20 text-cyan-400 shrink-0">
            <Lock className="h-5 w-5 sm:h-6 sm:w-6" />
          </div>
          <div>
            <h3 className="text-base sm:text-lg font-bold font-sans text-white">管理員安全與權限鎖定</h3>
            <p className="text-[10px] sm:text-[11px] font-mono text-cyan-400 uppercase tracking-wider">
              ADMIN SECURITY & PASSCODE
            </p>
          </div>
        </div>

        {/* Security Alert Notice */}
        <div className="mb-5 bg-cyan-950/30 border border-cyan-500/30 rounded-xl p-3.5 text-xs text-cyan-200 leading-relaxed font-light">
          <span className="font-bold text-white block mb-1">🛡️ 上傳與發布防護說明：</span>
          為防止任何公開訪客隨意上架或刪除 APK，系統預設已啟用<b>管理員防護</b>。請輸入您的管理員密碼以解鎖權限。
        </div>

        {/* Form 1: Unlock Passcode */}
        {!isUnlocked ? (
          <form onSubmit={handleVerify} className="space-y-4 mb-4">
            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-slate-400 font-bold mb-1.5">
                輸入管理員密碼以解鎖發布權限
              </label>
              <div className="relative flex items-center">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={inputCode}
                  onChange={(e) => setInputCode(e.target.value)}
                  placeholder="請輸入管理員密碼"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:outline-none focus:border-cyan-400"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 text-slate-400 hover:text-white"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {errorMsg && (
              <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 p-2.5 rounded-xl font-mono flex items-center gap-1.5">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            <button
              type="submit"
              className="w-full py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-2"
            >
              <Key className="h-4 w-4" />
              <span>驗證並解鎖管理權限</span>
            </button>
          </form>
        ) : (
          /* Unlocked Admin State & Settings Change */
          <div className="space-y-4">
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 text-xs text-emerald-300 font-mono flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-400 shrink-0" />
              <span>已成功取得管理員身分存取權限！</span>
            </div>

            {/* Form to change passcode */}
            <form onSubmit={handleUpdatePasscode} className="space-y-3 pt-2 border-t border-white/10">
              <label className="block text-xs font-mono uppercase tracking-wider text-slate-400 font-bold">
                修改新的管理員密碼
              </label>
              <input
                type="text"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                placeholder="輸入新密碼 (至少 4 個字元)"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400"
              />

              <div className="flex items-center justify-between pt-1">
                <label className="flex items-center gap-2 text-xs text-slate-300 font-mono cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isProtectionEnabled}
                    onChange={(e) => onSavePasscode(adminPasscode, e.target.checked)}
                    className="accent-cyan-400 rounded"
                  />
                  <span>強制啟用上架驗證 (推薦)</span>
                </label>
              </div>

              {successMsg && (
                <p className="text-xs text-emerald-400 font-mono">{successMsg}</p>
              )}

              <button
                type="submit"
                disabled={!newCode.trim()}
                className="w-full py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white font-mono text-xs font-bold disabled:opacity-40 transition-all"
              >
                儲存新密碼
              </button>
            </form>
          </div>
        )}

        <div className="mt-5 pt-3 border-t border-white/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-white/5 hover:bg-white/10 text-slate-300 rounded-xl text-xs font-mono"
          >
            關閉視窗
          </button>
        </div>
      </div>
    </div>
  );
};
