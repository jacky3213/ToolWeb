import React, { useState, useEffect } from 'react';
import { Search, Smartphone, Plus, ShieldCheck, Sparkles, ArrowUpDown, Lock, CheckCircle2, FileCheck2, Trash2, Code2 } from 'lucide-react';
import { ApkTool, ToolCategory } from './types';
import { INITIAL_TOOLS } from './data';
import { Header } from './components/Header';
import { ToolCard } from './components/ToolCard';
import { ToolDetailModal } from './components/ToolDetailModal';
import { AddToolModal } from './components/AddToolModal';
import { InstallGuideModal } from './components/InstallGuideModal';
import { AdminPasscodeModal } from './components/AdminPasscodeModal';
import { VersionBadge } from './components/VersionBadge';

export function App() {
  const [tools, setTools] = useState<ApkTool[]>([]);
  const [loading, setLoading] = useState(false);

  // Admin Security state
  const [adminPasscode, setAdminPasscode] = useState('Kevin7777777');
  const [isProtectionEnabled, setIsProtectionEnabled] = useState(true);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [isAdminModalOpen, setIsAdminModalOpen] = useState(false);

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<ToolCategory>('All');
  const [sortBy, setSortBy] = useState<'popular' | 'latest' | 'rating'>('popular');

  // Modals state
  const [selectedTool, setSelectedTool] = useState<ApkTool | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isInstallGuideOpen, setIsInstallGuideOpen] = useState(false);
  const [isSyncingDrive, setIsSyncingDrive] = useState(false);

  // Notification Toast
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Fetch tools & admin status on mount
  useEffect(() => {
    fetchTools();
    checkAdminStatus();
  }, []);

  const fetchTools = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/tools');
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

  const checkAdminStatus = async () => {
    try {
      const res = await fetch('/api/admin/status');
      if (res.ok) {
        const data = await res.json();
        setIsProtectionEnabled(data.passcodeRequired);
      }
    } catch (e) {
      console.error(e);
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

  // Handle Manual Google Drive Sync
  const handleSyncDrive = async () => {
    try {
      setIsSyncingDrive(true);
      showToast('🔄 正在連線至 Google Drive 同步最新 APK 與 app-info.json 配置...');
      const res = await fetch('/api/sync-gdrive?force=true', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        if (Array.isArray(data.tools)) {
          setTools(data.tools);
        }
        showToast(`✅ ${data.message || 'Google Drive 同步完成！'}`);
      } else {
        showToast(`⚠️ ${data.message || '同步失敗，請確認 Google Drive 連結'}`);
      }
    } catch (err) {
      console.error('Failed to sync Drive:', err);
      showToast('❌ 同步失敗，請稍後再試');
    } finally {
      setIsSyncingDrive(false);
    }
  };

  // Handle Save New Tool
  const handleSaveTool = async (newToolData: Partial<ApkTool>, passcode?: string) => {
    try {
      const res = await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: newToolData,
          passcode: passcode || adminPasscode,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.tools) {
          setTools(data.tools);
        } else {
          fetchTools();
        }
        showToast(`✅ 成功上架發布 ${newToolData.name}！`);
      } else {
        const err = await res.json();
        showToast(`❌ 發布失敗: ${err.error || '需要管理員授權'}`);
        setIsAdminModalOpen(true);
      }
    } catch (err) {
      console.error(err);
      showToast('❌ 發布時發生伺服器錯誤');
    }
  };

  // Handle Delete Tool
  const handleDeleteTool = async (toolId: string) => {
    if (!confirm('確定要刪除這款 APK 套件嗎？')) return;

    try {
      const res = await fetch(`/api/tools/${toolId}`, {
        method: 'DELETE',
        headers: {
          'x-admin-passcode': adminPasscode,
        },
      });

      if (res.ok) {
        setTools((prev) => prev.filter((t) => t.id !== toolId));
        showToast('🗑️ 已成功移除該 APK 套件');
      } else {
        showToast('❌ 刪除失敗，權限不足');
        setIsAdminModalOpen(true);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Filter & Sort Logic
  const categories: ToolCategory[] = ['All', 'Tampermonkey', 'Utility', 'Developer', 'AI & Tools', 'Network', 'Media'];

  const filteredTools = tools
    .filter((tool) => {
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

  const totalDownloads = tools.reduce((acc, t) => acc + t.downloadCount, 0);

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
        toolCount={tools.length}
        totalDownloads={totalDownloads}
        onOpenAddModal={() => setIsAddOpen(true)}
        onOpenInstallGuide={() => setIsInstallGuideOpen(true)}
        onOpenAdminModal={() => setIsAdminModalOpen(true)}
        onSyncDrive={handleSyncDrive}
        isSyncingDrive={isSyncingDrive}
        isUnlocked={isUnlocked}
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
                      onDelete={handleDeleteTool}
                      isUnlocked={isUnlocked}
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
                歡迎發布您的 Android APK 或 Tampermonkey 腳本
              </h2>
              <p className="text-xs text-slate-300 font-light leading-relaxed max-w-md mx-auto mb-6">
                您可以點擊下方按鈕上傳 APK 或貼上 Tampermonkey (.user.js / 雲端) 連結，開始建立您的專屬工具庫。
              </p>

              <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                <button
                  onClick={() => setIsAddOpen(true)}
                  className="px-6 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-bold uppercase tracking-wider transition-all shadow-[0_0_20px_rgba(34,211,238,0.25)] flex items-center gap-2 active:scale-95"
                >
                  <Plus className="h-4 w-4" /> 上架發布工具或腳本
                </button>

                <button
                  onClick={() => setIsAdminModalOpen(true)}
                  className="px-5 py-3 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 font-mono text-xs border border-white/10 flex items-center gap-2"
                >
                  <Lock className="h-4 w-4 text-cyan-400" /> 管理員安全設定
                </button>
              </div>
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

      <AddToolModal
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onSave={handleSaveTool}
        adminPasscode={adminPasscode}
        isUnlocked={isUnlocked}
        onOpenAdminAuth={() => setIsAdminModalOpen(true)}
      />

      <AdminPasscodeModal
        isOpen={isAdminModalOpen}
        onClose={() => setIsAdminModalOpen(false)}
        adminPasscode={adminPasscode}
        onSavePasscode={(newCode, isRequired) => {
          setAdminPasscode(newCode);
          setIsProtectionEnabled(isRequired);
          fetch('/api/admin/set-passcode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPasscode: adminPasscode, newPasscode: newCode, toggleProtection: isRequired }),
          });
        }}
        isProtectionEnabled={isProtectionEnabled}
        onVerifySuccess={() => setIsUnlocked(true)}
        isUnlocked={isUnlocked}
      />

      <InstallGuideModal
        isOpen={isInstallGuideOpen}
        onClose={() => setIsInstallGuideOpen(false)}
      />
    </div>
  );
}

export default App;
