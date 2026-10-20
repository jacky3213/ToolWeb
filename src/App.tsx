import React, { useState, useEffect } from 'react';
import { Search, Sparkles, ArrowUpDown, Code2, Lock, X } from 'lucide-react';
import { ApkTool, ToolCategory } from './types';
import { UNLOCK_TOKEN_KEY, UNLOCK_API_PATH } from './config';
import { Header } from './components/Header';
import { ToolCard } from './components/ToolCard';
import { ToolDetailModal } from './components/ToolDetailModal';
import { InstallGuideModal } from './components/InstallGuideModal';
import { VersionBadge } from './components/VersionBadge';

export function App() {
  const [tools, setTools] = useState<ApkTool[]>([]);
  const [loading, setLoading] = useState(false);


  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<ToolCategory>('All');
  const [sortBy, setSortBy] = useState<'popular' | 'latest' | 'rating'>('popular');

  // Modals state
  const [selectedTool, setSelectedTool] = useState<ApkTool | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isInstallGuideOpen, setIsInstallGuideOpen] = useState(false);

  // Notification Toast
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Admin unlock state (restricted/locked tools)
  const [unlockToken, setUnlockToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem(UNLOCK_TOKEN_KEY);
    } catch {
      return null;
    }
  });
  const [isUnlockOpen, setIsUnlockOpen] = useState(false);
  const [unlockInput, setUnlockInput] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);

  const hasLockedTools = tools.some((t) => t.locked);

  // 前端「已解鎖」＝持有 token。真正權威過濾在後端（/api/tools 依 token 返回），
  // 此布林僅用於 UI 提示與避免 token 失效時的短暫閃爍。
  const isUnlocked = Boolean(unlockToken);

  // ⚠️ 不可用 hasLockedTools 當入口顯示條件：後端在未解鎖時不會回傳 locked 工具
  // （server.ts:408），tools.some(t => t.locked) 恆為 false，入口永遠不會出現，
  // 密碼框也就永遠打不開。未解鎖時一律顯示入口；已解鎖時才需要「重新鎖定」。
  const showLockBar = !isUnlocked || hasLockedTools;

  const handleUnlock = async () => {
    if (!unlockInput.trim()) return;
    setIsUnlocking(true);
    setUnlockError(null);
    try {
      const res = await fetch(UNLOCK_API_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: unlockInput }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.token) {
        setUnlockToken(data.token);
        setUnlockInput('');
        setIsUnlockOpen(false);
        try {
          localStorage.setItem(UNLOCK_TOKEN_KEY, data.token);
        } catch {
          /* ignore */
        }
        showToast('🔓 已解鎖受限工具');
      } else {
        setUnlockError(data.error || '密碼錯誤，請重試');
      }
    } catch {
      setUnlockError('連線失敗，請稍後重試');
    } finally {
      setIsUnlocking(false);
    }
  };

  const handleLock = () => {
    setUnlockToken(null);
    try {
      localStorage.removeItem(UNLOCK_TOKEN_KEY);
    } catch {
      /* ignore */
    }
    showToast('🔒 已重新鎖定受限工具');
  };

  // Fetch tools on mount and whenever the unlock token changes
  useEffect(() => {
    fetchTools();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlockToken]);

  const fetchTools = async () => {
    try {
      setLoading(true);
      // 帶上解鎖 token（若有），讓後端放行 locked 工具。
      const url = unlockToken ? `/api/tools?token=${encodeURIComponent(unlockToken)}` : '/api/tools';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setTools(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to fetch tools from API', err);
      setTools([]);
    } finally {
      setLoading(false);
    }
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Handle Download / Install (Routes through Server Bridge without popup blocker issues)
  const handleDownload = (tool: ApkTool) => {
    const isUserScript = tool.category === 'Tampermonkey' || tool.downloadUrl.includes('.user.js');
    showToast(isUserScript ? `🚀 準備安裝油猴腳本 ${tool.name} (${tool.version})...` : `🚀 經由伺服器橋樑轉接下載 ${tool.name} (${tool.version})...`);

    setTools((prev) =>
      prev.map((t) => (t.id === tool.id ? { ...t, downloadCount: t.downloadCount + 1 } : t))
    );

    if (isUserScript) {
      // Direct userscript URL ending in .user.js is REQUIRED by Tampermonkey extension to intercept and trigger the install dialog
      const targetScriptUrl = tool.downloadUrl.endsWith('.user.js')
        ? tool.downloadUrl
        : (tool.scriptFileName ? `/api/download/${tool.scriptFileName}` : `/api/download/${tool.id}.user.js`);

      // Using an anchor with target="_blank" so Tampermonkey catches the .user.js navigation
      const link = document.createElement('a');
      link.href = targetScriptUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else {
      const bridgeUrl = `/api/tools/${tool.id}/download`;
      const link = document.createElement('a');
      link.href = bridgeUrl;
      link.download = `${tool.name}_${tool.version || 'v1.0'}.apk`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  // Filter & Sort Logic
  const categories: ToolCategory[] = ['All', 'Tampermonkey', 'Utility', 'Developer', 'AI & Tools', 'Network', 'Media'];

  const filteredTools = tools
    .filter((tool) => {
      // Hide locked tools until the admin passcode unlocks them
      if (tool.locked && !isUnlocked) return false;

      const matchesSearch =
        tool.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        tool.packageName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        tool.summary.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesCategory = selectedCategory === 'All' || tool.category === selectedCategory;

      return matchesSearch && matchesCategory;
    })
    .sort((a, b) => {
      if (sortBy === 'popular') return b.downloadCount - a.downloadCount;
      if (sortBy === 'latest') return new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime();
      if (sortBy === 'rating') return b.rating - a.rating;
      return 0;
    });

  // Tools visible regardless of search/filter (only lock state applies) — used for header stats
  const visibleTools = tools.filter((t) => !t.locked || isUnlocked);
  const visibleTotalDownloads = visibleTools.reduce((acc, t) => acc + t.downloadCount, 0);

  return (
    <div className="min-h-screen bg-[#020203] text-slate-100 flex flex-col font-sans selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 z-50 bg-cyan-950 border border-cyan-400/50 text-cyan-200 px-4 py-3 rounded-2xl shadow-2xl font-mono text-xs flex items-center justify-center sm:justify-start gap-2 animate-in slide-in-from-bottom duration-200">
          <Sparkles className="h-4 w-4 text-cyan-400 animate-spin shrink-0" />
          <span className="truncate">{toastMessage}</span>
        </div>
      )}

      {/* Top Header */}
      <Header
        toolCount={visibleTools.length}
        totalDownloads={visibleTotalDownloads}
        onOpenInstallGuide={() => setIsInstallGuideOpen(true)}
      />

      {/* Hero Section */}
      <section className="relative overflow-hidden border-b border-white/5 py-8 sm:py-12 px-4 sm:px-8 bg-gradient-to-b from-cyan-950/20 via-[#020203] to-[#020203]">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[350px] sm:w-[500px] h-[200px] sm:h-[300px] bg-cyan-500/10 rounded-full blur-[100px] sm:blur-[120px] pointer-events-none"></div>

        <div className="mx-auto max-w-5xl text-center relative z-10">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-cyan-500/10 border border-cyan-400/20 text-cyan-400 font-mono text-[10px] sm:text-xs uppercase tracking-wider sm:tracking-widest mb-3">
            <Code2 className="h-3 w-3 sm:h-3.5 sm:w-3.5 shrink-0" /> APK Tools & Tampermonkey Userscripts Hub
          </div>

          <h1 className="text-2xl sm:text-4xl lg:text-5xl font-extrabold text-white tracking-tight mb-3 font-sans leading-tight">
            專屬 APK 工具與 <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-indigo-400 to-purple-400">Tampermonkey 腳本</span> 發布中心
          </h1>

          <p className="text-xs sm:text-base text-slate-300 max-w-2xl mx-auto font-light leading-relaxed mb-6">
            集中管理您的 Android APK 實用套件與 Tampermonkey (油猴) 瀏覽器腳本。支援 Google Drive 雲端同步、手機 QR Code 下載、腳本快速安裝與自動計數統計。
          </p>

          {/* Search Box in Hero */}
          <div className="max-w-xl mx-auto relative">
            <div className="relative flex items-center bg-[#0a0a0c] border border-white/10 hover:border-cyan-400/40 rounded-2xl p-1.5 sm:p-2 shadow-2xl transition-all focus-within:border-cyan-400">
              <Search className="h-4 w-4 sm:h-5 sm:w-5 text-slate-400 ml-2.5 shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜尋工具名稱、腳本或 Package ID..."
                className="w-full bg-transparent px-2.5 py-1.5 sm:py-2 text-xs sm:text-sm text-white placeholder:text-slate-500 focus:outline-none font-mono"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="px-2 text-xs font-mono text-slate-400 hover:text-white shrink-0"
                >
                  清除
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Main Content Area */}
      <main className="flex-1 mx-auto max-w-7xl w-full px-3 sm:px-8 py-6 sm:py-8">
        {/* Restricted tools unlock bar */}
        {showLockBar && (
          <div className="mb-5 flex items-center justify-between gap-3 rounded-2xl border border-amber-400/20 bg-amber-500/5 px-4 py-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Lock className="h-4 w-4 text-amber-400 shrink-0" />
              <span className="text-xs font-mono text-amber-200/90 truncate">
                {isUnlocked ? '受限工具已解鎖' : '部分工具需輸入管理密碼才能顯示'}
              </span>
            </div>
            <button
              onClick={isUnlocked ? handleLock : () => setIsUnlockOpen(true)}
              className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-mono transition-all active:scale-95 ${
                isUnlocked
                  ? 'border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10'
                  : 'border-amber-400/30 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20'
              }`}
            >
              {isUnlocked ? '重新鎖定' : '解鎖'}
            </button>
          </div>
        )}

        {tools.length > 0 && (
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-6">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-2 sm:pb-0 no-scrollbar touch-pan-x -mx-3 px-3 sm:mx-0 sm:px-0">
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-3 py-1.5 sm:px-3.5 sm:py-2 rounded-xl text-xs font-mono transition-all shrink-0 ${
                    selectedCategory === cat
                      ? 'bg-cyan-500 text-slate-950 font-bold shadow-[0_0_15px_rgba(34,211,238,0.2)]'
                      : 'bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/5'
                  }`}
                >
                  {cat === 'All' ? '全部工具與腳本' : cat === 'Tampermonkey' ? '🐵 Tampermonkey 腳本' : cat}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <div className="flex items-center justify-between sm:justify-start w-full sm:w-auto gap-2 text-xs font-mono text-slate-400 bg-white/5 border border-white/10 px-3 py-1.5 sm:py-2 rounded-xl">
                <div className="flex items-center gap-1">
                  <ArrowUpDown className="h-3.5 w-3.5 text-cyan-400" />
                  <span>排序:</span>
                </div>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  className="bg-transparent text-white font-bold focus:outline-none cursor-pointer"
                >
                  <option value="popular" className="bg-[#0a0a0c]">最多下載 (Popular)</option>
                  <option value="latest" className="bg-[#0a0a0c]">最新釋出 (Latest)</option>
                  <option value="rating" className="bg-[#0a0a0c]">評分最高 (Rating)</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Tools Grid / Empty Clean State */}
        <div className="mb-6">
          {tools.length > 0 ? (
            <div>
              <div className="flex items-center justify-between mb-3 sm:mb-4">
                <h2 className="text-[11px] sm:text-xs font-mono uppercase tracking-widest text-slate-400 font-bold flex items-center gap-1.5">
                  <Code2 className="h-4 w-4 text-cyan-400" /> 已發布工具與腳本清單 ({filteredTools.length})
                </h2>
              </div>

              {filteredTools.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 sm:gap-5">
                  {filteredTools.map((tool) => (
                    <ToolCard
                      key={tool.id}
                      tool={tool}
                      onSelect={(t) => {
                        setSelectedTool(t);
                        setIsDetailOpen(true);
                      }}
                      onDownload={handleDownload}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 bg-[#0a0a0c] border border-white/5 rounded-2xl p-8">
                  <p className="text-xs text-slate-400 font-mono">未搜尋到符合篩選條件的 APK 工具或腳本</p>
                </div>
              )}
            </div>
          ) : (
            /* Clean Initial Empty State */
            <div className="max-w-2xl mx-auto my-8 bg-[#0a0a0c] border border-cyan-500/20 rounded-3xl p-8 text-center relative overflow-hidden shadow-2xl">
              <div className="absolute -top-12 -right-12 w-48 h-48 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none"></div>

              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-indigo-600/20 border border-cyan-400/30 flex items-center justify-center mx-auto mb-5 text-cyan-400">
                <Code2 className="h-8 w-8" />
              </div>

              <h2 className="text-xl font-bold text-white mb-2 font-sans">
              工具庫目前是空的
            </h2>
            <p className="text-xs text-slate-300 font-light leading-relaxed max-w-md mx-auto">
              尚未發布任何工具。若你是網站維護者，將 APK 或 <code className="text-cyan-300">.user.js</code> 放入
              <code className="text-cyan-300"> public/apks/</code> 並在
              <code className="text-cyan-300"> tools.json</code> 登錄後，工具會在約一分鐘內自動出現。
            </p>

            {/* 全部工具都被鎖住時，列表會是空的——這裡必須留一個解鎖入口，否則沒有出路 */}
            {!isUnlocked && (
              <button
                onClick={() => setIsUnlockOpen(true)}
                className="mt-5 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-xs font-mono text-amber-200 hover:bg-amber-400/20 active:scale-95 transition-all"
              >
                輸入管理密碼解鎖受限工具
              </button>
            )}
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-8 px-4 text-center text-xs font-mono text-slate-500 bg-[#020203]">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Code2 className="h-4 w-4 text-cyan-400" />
            <span>DEV.STUDIO TOOLBOX // APK & TAMPERMONKEY</span>
          </div>
          <p>© 2026 Custom Clean Tools & Scripts Distribution Center.</p>
        </div>
      </footer>

      {/* Build version badge (bottom-right corner) */}
      <VersionBadge />

      {/* Modals */}
      <ToolDetailModal
        tool={selectedTool}
        isOpen={isDetailOpen}
        onClose={() => {
          setIsDetailOpen(false);
          setSelectedTool(null);
        }}
        onDownload={handleDownload}
      />

      <InstallGuideModal
        isOpen={isInstallGuideOpen}
        onClose={() => setIsInstallGuideOpen(false)}
      />

      {/* Admin unlock modal */}
      {isUnlockOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => {
              setIsUnlockOpen(false);
              setUnlockInput('');
              setUnlockError(null);
            }}
          />
          <div className="relative w-full max-w-sm rounded-2xl border border-amber-400/20 bg-[#0a0a0c] p-6 shadow-2xl">
            <button
              onClick={() => {
                setIsUnlockOpen(false);
                setUnlockInput('');
                setUnlockError(null);
              }}
              className="absolute right-4 top-4 text-slate-500 hover:text-white transition-colors"
              aria-label="關閉"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="flex items-center gap-2.5 mb-2">
              <Lock className="h-5 w-5 text-amber-400" />
              <h3 className="text-base font-bold text-white font-sans">解鎖受限工具</h3>
            </div>
            <p className="text-xs text-slate-400 font-light mb-4 leading-relaxed">
              輸入管理密碼以顯示受限工具（如 YouTube 直連下載）。
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleUnlock();
              }}
            >
              <input
                type="password"
                autoFocus
                value={unlockInput}
                onChange={(e) => {
                  setUnlockInput(e.target.value);
                  setUnlockError(null);
                }}
                placeholder="管理密碼"
                className={`w-full rounded-xl border bg-white/5 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none transition-colors ${
                  unlockError
                    ? 'border-red-500/60 focus:border-red-400'
                    : 'border-white/10 focus:border-amber-400/50'
                }`}
              />
              {unlockError && (
                <p className="mt-2 text-xs font-mono text-red-400">{unlockError}</p>
              )}
              <button
                type="submit"
                disabled={isUnlocking}
                className="mt-4 w-full rounded-xl bg-amber-400 py-2.5 text-sm font-bold text-slate-950 transition-all hover:bg-amber-300 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isUnlocking ? '驗證中…' : '解鎖'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
