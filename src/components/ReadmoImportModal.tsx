import React, { useState, useEffect, useCallback } from 'react';
import {
  X, Search, BookOpen, Loader2, CheckCircle2, AlertTriangle, Download,
  Settings, Link2, KeyRound, UploadCloud, FileDown, ChevronDown, ChevronUp, Eye, EyeOff, ShieldAlert,
} from 'lucide-react';

interface SearchResult {
  siteId: string;
  siteName: string;
  title: string;
  author?: string;
  bookUrl: string;
  note?: string;
}

interface BookInfo {
  title: string;
  author?: string;
  siteName: string;
  bookUrl: string;
  wordCountText?: string;
  chapterCount?: number;
  firstChapterUrl?: string;
  intro?: string;
}

interface Volume {
  label: string;
  chapters: number;
  uploaded: boolean;
  downloadUrl: string;
}

interface Job {
  id: string;
  status: 'queued' | 'info' | 'crawling' | 'packing' | 'uploading' | 'done' | 'error';
  stage: string;
  title?: string;
  author?: string;
  siteName?: string;
  bookUrl: string;
  wordCountText?: string;
  chapterCount?: number;
  crawled: number;
  volumes: Volume[];
  logs: string[];
  error?: string;
}

interface ReadmoImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  adminPasscode?: string;
  isUnlocked?: boolean;
  onRequestUnlock?: () => void;
}

/** 統一带上管理員密碼並處理 401 / 429，避免每次 request 各自處理 */
async function api<T>(url: string, passcode: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (passcode) headers['x-admin-passcode'] = passcode;
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e) {
    throw new Error('連線失敗，請稍後再試');
  }
  const data = await res.json().catch(() => ({} as any));
  if (res.status === 401) {
    throw new Error('尚未解鎖管理員權限，請先點右上角「管理防護」輸入密碼');
  }
  if (res.status === 429) {
    throw new Error((data as any)?.error || '操作過於頻繁，請稍後再試');
  }
  if (!res.ok) {
    throw new Error((data as any)?.error || `請求失敗（HTTP ${res.status}）`);
  }
  return data as T;
}

export const ReadmoImportModal: React.FC<ReadmoImportModalProps> = ({
  isOpen,
  onClose,
  adminPasscode = '',
  isUnlocked = false,
  onRequestUnlock,
}) => {
  const [query, setQuery] = useState('');
  const [directUrl, setDirectUrl] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [info, setInfo] = useState<BookInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);

  const [job, setJob] = useState<Job | null>(null);

  // 上傳設定（由 DevTools cURL 學習）
  const [showConfig, setShowConfig] = useState(false);
  const [curlText, setCurlText] = useState('');
  const [cfgState, setCfgState] = useState<{
    configured: boolean;
    url?: string;
    fileField?: string;
    hasStaticAuth?: boolean;
  } | null>(null);
  const [savingCfg, setSavingCfg] = useState(false);

  const reset = () => {
    setQuery('');
    setDirectUrl('');
    setResults([]);
    setSelected(null);
    setInfo(null);
    setErrorMsg(null);
    setJob(null);
  };

  const fetchConfig = useCallback(async () => {
    try {
      const data = await api<Record<string, unknown>>('/api/readmo/config', adminPasscode);
      setCfgState(data as { configured: boolean; url?: string; fileField?: string });
    } catch {
      /* ignore */
    }
  }, [adminPasscode]);

  useEffect(() => {
    if (isOpen) fetchConfig();
  }, [isOpen, fetchConfig]);

  const pick = async (targetUrl: string, fallbackTitle?: string) => {
    setErrorMsg(null);
    setLoadingInfo(true);
    try {
      const data = await api<{ info: BookInfo }>(
        `/api/readmo/info?url=${encodeURIComponent(targetUrl)}`,
        adminPasscode,
      );
      if (!data.info) throw new Error('讀取書籍資訊失敗');
      setInfo(data.info);
      setSelected((prev) => prev || {
        siteId: '', siteName: data.info.siteName, title: data.info.title,
        author: data.info.author, bookUrl: targetUrl,
      });
    } catch (e: any) {
      setInfo({
        title: fallbackTitle || '（未知書名）',
        siteName: '—', bookUrl: targetUrl,
      });
      setErrorMsg(`${e.message || '讀取失敗'}｜仍可直接嘗試導入`);
    } finally {
      setLoadingInfo(false);
    }
  };

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setErrorMsg(null);
    setSelected(null);
    setInfo(null);
    setJob(null);
    try {
      const data = await api<{ results: SearchResult[] }>(
        `/api/readmo/search?q=${encodeURIComponent(query.trim())}`,
        adminPasscode,
      );
      setResults(data.results || []);
      if (!(data.results || []).length) {
        setErrorMsg('查無結果。可改用下方「直接貼書籍網址」，或換個關鍵字試試。');
      }
    } catch (e: any) {
      setErrorMsg(e.message || '搜尋失敗');
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleDirectUrl = async () => {
    if (!directUrl.trim()) return;
    await pick(directUrl.trim());
  };

  const startImport = async () => {
    if (!selected) return;
    setErrorMsg(null);
    try {
      const data = await api<{ job: Job }>('/api/readmo/import', adminPasscode, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookUrl: selected.bookUrl,
          title: selected.title,
          email,
          password,
        }),
      });
      setJob(data.job);
      setPassword(''); // 送出後立即自前端清除
    } catch (e: any) {
      setErrorMsg(e.message || '建立任務失敗');
    }
  };

  // 輪詢任務進度
  useEffect(() => {
    if (!job) return;
    const id = job.id;
    const timer = setInterval(async () => {
      try {
        const data = await api<{ job: Job }>(`/api/readmo/jobs/${id}`, adminPasscode);
        setJob(data.job);
        if (data.job.status === 'done' || data.job.status === 'error') clearInterval(timer);
      } catch {
        /* ignore */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [job?.id, adminPasscode]);

  const saveConfig = async () => {
    if (!curlText.trim()) return;
    setSavingCfg(true);
    try {
      const data = await api<{ url?: string; fileField?: string }>('/api/readmo/config', adminPasscode, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curl: curlText }),
      });
      setCurlText('');
      setErrorMsg(`上傳端點已設定：${data.url || ''}`);
      await fetchConfig();
      setShowConfig(false);
    } catch (e: any) {
      setErrorMsg(e.message || '設定失敗');
    } finally {
      setSavingCfg(false);
    }
  };

  if (!isOpen) return null;

  const progressValue = job
    ? job.status === 'done'
      ? 100
      : Math.min(95, Math.round((job.crawled / Math.max(1, job.chapterCount || 500)) * 70) +
          (job.status === 'uploading' ? 20 : job.status === 'packing' ? 15 : 0))
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-3xl bg-[#0a0a0c] border border-white/10 rounded-2xl p-4 sm:p-7 shadow-2xl text-slate-200 max-h-[92vh] overflow-y-auto">
        <button
          onClick={() => { reset(); onClose(); }}
          className="absolute top-3 right-3 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2.5 mb-1">
          <BookOpen className="h-5 w-5 text-amber-400" />
          <h2 className="text-base sm:text-lg font-bold text-white">小說導入 Readmoo（mooInk）</h2>
        </div>
        <p className="text-[11px] sm:text-xs text-slate-400 mb-3 font-light">
          搜尋小說 → 選擇後輸入 Readmoo 帳密 → 自動爬完整本、打包 EPUB 分卷並上傳到你的網頁書櫃。
        </p>

        {!isUnlocked && (
          <div className="flex items-start gap-2 bg-cyan-500/10 border border-cyan-400/30 rounded-lg px-3 py-2 mb-3 text-[11px] text-cyan-200">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span className="flex-1">
              此功能會用伺服器代替你連線小說站與 Readmoo，因此需要管理員權限才能使用（避免被外人當成免費爬蟲 Proxy）。
            </span>
            {onRequestUnlock && (
              <button
                onClick={onRequestUnlock}
                className="shrink-0 bg-cyan-500 hover:bg-cyan-400 text-slate-950 px-2.5 py-1 rounded text-[10px] font-bold transition-all"
              >
                解鎖
              </button>
            )}
          </div>
        )}

        {/* ---- 搜尋區 ---- */}
        {!job && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  placeholder="輸入小說名稱，例如：大奉打更人"
                  className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-xs sm:text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400/50"
                />
              </div>
              <button
                onClick={handleSearch}
                disabled={searching || !query.trim()}
                className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-bold transition-all disabled:opacity-50 active:scale-95"
              >
                {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                <span className="hidden sm:inline">搜尋</span>
              </button>
            </div>

            <details className="text-xs">
              <summary className="cursor-pointer text-slate-400 hover:text-amber-300 select-none">
                搜不到？直接貼小說書籍頁網址
              </summary>
              <div className="flex gap-2 mt-2">
                <input
                  value={directUrl}
                  onChange={(e) => setDirectUrl(e.target.value)}
                  placeholder="https://uukanshu.cc/book/1234/"
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[11px] sm:text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400/50 font-mono"
                />
                <button
                  onClick={handleDirectUrl}
                  disabled={loadingInfo || !directUrl.trim()}
                  className="flex items-center gap-1 bg-white/10 hover:bg-white/15 border border-white/10 px-3 py-2 rounded-lg text-[11px] sm:text-xs transition-all disabled:opacity-50"
                >
                  <Link2 className="h-3.5 w-3.5" /> 讀取
                </button>
              </div>
            </details>

            {errorMsg && (
              <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-[11px] sm:text-xs text-red-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* ---- 結果列表 ---- */}
            {results.length > 0 && !info && (
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                {results.map((r, i) => (
                  <button
                    key={`${r.bookUrl}-${i}`}
                    onClick={() => pick(r.bookUrl, r.title)}
                    className="w-full text-left bg-white/5 hover:bg-white/10 border border-white/10 hover:border-amber-400/40 rounded-lg px-3 py-2.5 transition-all"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs sm:text-sm text-white font-medium truncate">{r.title}</span>
                      <span className="text-[10px] text-cyan-300/80 font-mono shrink-0">{r.siteName}</span>
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5 font-mono truncate">
                      {r.author ? `作者：${r.author}` : ''}
                      {r.note ? ` ｜ 字數 ${r.note}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {loadingInfo && (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" /> 讀取書籍資訊…
              </div>
            )}

            {/* ---- 選定書籍 + 帳密 ---- */}
            {info && !job && (
              <div className="bg-gradient-to-br from-amber-500/10 to-transparent border border-amber-400/30 rounded-xl p-3 sm:p-4 space-y-3">
                <div>
                  <div className="text-sm sm:text-base text-white font-bold">{info.title}</div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-[10px] sm:text-[11px] font-mono text-slate-400">
                    <span className="text-cyan-300">{info.siteName}</span>
                    {info.author && <span>作者：{info.author}</span>}
                    {info.wordCountText && <span className="text-amber-300">字數：{info.wordCountText}</span>}
                    {info.chapterCount ? <span>章數：{info.chapterCount}</span> : null}
                  </div>
                  {info.intro && (
                    <p className="text-[11px] text-slate-400 mt-2 line-clamp-3">{info.intro}</p>
                  )}
                </div>

                <div className="grid sm:grid-cols-2 gap-2">
                  <div className="relative">
                    <input
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      type="email"
                      placeholder="Readmoo 帳號（Email）"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400/50"
                    />
                  </div>
                  <div className="relative">
                    <input
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      type={showPwd ? 'text' : 'password'}
                      placeholder="Readmoo 密碼"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 pr-9 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400/50"
                    />
                    <button
                      onClick={() => setShowPwd((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                    >
                      {showPwd ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
                <p className="text-[10px] text-slate-500 flex items-center gap-1">
                  <KeyRound className="h-3 w-3" />
                  帳密僅用在此次任務記憶體中，不儲存、不寫入紀錄。留空則只產生 EPUB 供下載。
                </p>

                <div className="flex gap-2">
                  <button
                    onClick={startImport}
                    disabled={loadingInfo}
                    className="flex-1 flex items-center justify-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 px-4 py-2.5 rounded-lg text-xs sm:text-sm font-bold transition-all active:scale-95"
                  >
                    <UploadCloud className="h-4 w-4" /> 開始導入
                  </button>
                  <button
                    onClick={() => { setInfo(null); setSelected(null); }}
                    className="px-3 sm:px-4 py-2.5 rounded-lg text-xs bg-white/5 hover:bg-white/10 border border-white/10 transition-all"
                  >
                    重新選擇
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---- 任務進度 ---- */}
        {job && (
          <div className="space-y-3">
            <div className="bg-white/5 border border-white/10 rounded-xl p-3 sm:p-4">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-xs sm:text-sm text-white font-bold truncate">{job.title || '導入中'}</span>
                <span
                  className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                    job.status === 'done'
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : job.status === 'error'
                        ? 'bg-red-500/15 text-red-300'
                        : 'bg-amber-500/15 text-amber-300'
                  }`}
                >
                  {job.stage}
                </span>
              </div>

              <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 ${
                    job.status === 'done' ? 'bg-emerald-400' : job.status === 'error' ? 'bg-red-400' : 'bg-amber-400'
                  }`}
                  style={{ width: `${progressValue}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] font-mono text-slate-500 mt-1.5">
                <span>已爬取 {job.crawled} 章</span>
                <span>{job.volumes.length ? `分卷 ${job.volumes.length} 冊` : ''}</span>
              </div>
            </div>

            {/* 分卷 & 下載 */}
            {job.volumes.length > 0 && (
              <div className="space-y-1.5">
                {job.volumes.map((v, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {v.uploaded ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                      ) : (
                        <FileDown className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      )}
                      <span className="text-[11px] text-slate-300 truncate">
                        {v.label}（{v.chapters} 章）{v.uploaded ? '・已上傳' : ''}
                      </span>
                    </div>
                    <a
                      href={v.downloadUrl}
                      className="flex items-center gap-1 text-[10px] text-cyan-300 hover:text-cyan-200 shrink-0"
                    >
                      <Download className="h-3 w-3" /> EPUB
                    </a>
                  </div>
                ))}
              </div>
            )}

            {job.error && (
              <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-[11px] text-amber-200">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{job.error}</span>
              </div>
            )}

            {/* log */}
            <div className="bg-black/40 border border-white/10 rounded-lg p-3 max-h-48 overflow-y-auto">
              <div className="font-mono text-[10px] leading-relaxed text-slate-400 space-y-0.5">
                {job.logs.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => { setJob(null); }}
                className="flex-1 bg-white/5 hover:bg-white/10 border border-white/10 px-4 py-2 rounded-lg text-xs transition-all"
              >
                導入了其他書
              </button>
              <button
                onClick={() => { reset(); onClose(); }}
                className="px-4 py-2 rounded-lg text-xs bg-white/5 hover:bg-white/10 border border-white/10 transition-all"
              >
                關閉
              </button>
            </div>
          </div>
        )}

        {/* ---- 上傳設定（DevTools cURL） ---- */}
        <div className="mt-4 pt-3 border-t border-white/10">
          <button
            onClick={() => setShowConfig((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-amber-300 transition-colors"
          >
            <Settings className="h-3.5 w-3.5" />
            自動上傳設定
            {cfgState?.configured ? (
              <span className="text-emerald-400 font-mono">✓ 已設定</span>
            ) : (
              <span className="text-red-400 font-mono">✗ 未設定（只會產生 EPUB）</span>
            )}
            {showConfig ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>

          {showConfig && (
            <div className="mt-2 space-y-2 bg-white/5 border border-white/10 rounded-lg p-3">
              {cfgState?.configured && (
                <div className="text-[10px] font-mono text-slate-400 break-all">
                  目前端點：<span className="text-emerald-300">{cfgState.url}</span>
                  <br />檔案欄位：<span className="text-emerald-300">{cfgState.fileField}</span>
                  {cfgState.hasStaticAuth && (
                    <>
                      <br />
                      <span className="text-amber-300">
                        ⚠ 錄製的請求原本帶有你的個人憑證（cookie / Bearer token），已自動剝除，改用每次登入 Readmoo 取得的 session
                      </span>
                    </>
                  )}
                </div>
              )}
              <p className="text-[10px] text-slate-500 leading-relaxed">
                設定步驟：瀏覽器開 Readmoo 網頁書櫃 →「文件」→ F12 開 Network →
                手動上傳一個小檔案 → 找到該筆請求 → 右鍵「複製為 cURL」→ 貼到下方儲存。
                之後每次導入，系統會用你當時輸入的帳密登入取得新 session，再把 EPUB 逐卷上傳。
              </p>
              <textarea
                value={curlText}
                onChange={(e) => setCurlText(e.target.value)}
                placeholder="curl 'https://...' -H 'x-csrf-token: ...' -F 'file=@xxx.epub' ..."
                rows={4}
                className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-[10px] font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400/50 resize-y"
              />
              <div className="flex gap-2">
                <button
                  onClick={saveConfig}
                  disabled={savingCfg || !curlText.trim()}
                  className="flex items-center gap-1 bg-amber-500 hover:bg-amber-400 text-slate-950 px-4 py-2 rounded-lg text-[11px] font-bold transition-all disabled:opacity-50"
                >
                  {savingCfg ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  儲存
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
