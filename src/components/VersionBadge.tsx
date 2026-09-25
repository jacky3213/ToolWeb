import React, { useState } from 'react';
import { GitCommitHorizontal, Check } from 'lucide-react';

/**
 * Fixed bottom-right build badge — shows the git commit SHA the frontend was built from,
 * plus the build timestamp, so you can verify the deployed site is up to date.
 * Click to copy the commit SHA; click the hash to open the commit on GitHub.
 */
export const VersionBadge: React.FC = () => {
  const [copied, setCopied] = useState(false);

  if (typeof __APP_BUILD__ === 'undefined') return null;

  const { sha, time } = __APP_BUILD__;
  const commitUrl = sha !== 'dev'
    ? `https://github.com/jacky3213/ToolWeb/commit/${sha}`
    : undefined;

  const handleCopy = () => {
    navigator.clipboard.writeText(sha);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed bottom-3 right-3 z-40 flex items-center gap-1.5 bg-black/60 hover:bg-black/80 border border-white/10 rounded-full px-3 py-1.5 font-mono text-[10px] text-slate-400 backdrop-blur-sm transition-colors select-none">
      <GitCommitHorizontal className="h-3 w-3 text-cyan-500/80" />
      <span className="text-slate-500">build</span>
      {commitUrl ? (
        <a
          href={commitUrl}
          target="_blank"
          rel="noreferrer"
          className="text-cyan-400 hover:text-cyan-300 underline decoration-dotted underline-offset-2"
          title="在 GitHub 查看此 commit"
        >
          {sha}
        </a>
      ) : (
        <span className="text-cyan-400">{sha}</span>
      )}
      <span className="text-slate-600">·</span>
      <span title={`建置時間: ${time}`}>{time.split(' ')[0]}</span>
      <button
        onClick={handleCopy}
        className="text-slate-500 hover:text-white transition-colors"
        title="複製 commit SHA"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <GitCommitHorizontal className="h-3 w-3" />}
      </button>
    </div>
  );
};
