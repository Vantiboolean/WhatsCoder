import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { OverlayView } from './CodeViewer';

type GitFileStatus = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

type GitDetailedStatus = {
  branch: string;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
};

type CommitEntry = {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
};

function statusIcon(status: string): string {
  switch (status) {
    case 'modified': return 'M';
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'untracked': return '?';
    case 'conflict': return '!';
    default: return 'M';
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'added':
    case 'untracked': return 'var(--accent-green)';
    case 'deleted': return 'var(--status-error)';
    case 'conflict': return 'var(--status-warning)';
    default: return 'var(--status-info)';
  }
}

function fileName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString();
  } catch {
    return dateStr;
  }
}

export function GitPanel({
  cwd,
  onOverlayView,
}: {
  cwd: string | null;
  onOverlayView: (view: OverlayView) => void;
}) {
  const [status, setStatus] = useState<GitDetailedStatus | null>(null);
  const [log, setLog] = useState<CommitEntry[]>([]);
  const [commitMsg, setCommitMsg] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [activeSection, setActiveSection] = useState<'changes' | 'history'>('changes');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchingStatusRef = useRef(false);
  const fetchingLogRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    if (!cwd || fetchingStatusRef.current) return;
    fetchingStatusRef.current = true;
    try {
      const result = await invoke<GitDetailedStatus>('get_git_status_detailed', { cwd });
      setStatus(result);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      fetchingStatusRef.current = false;
    }
  }, [cwd]);

  const fetchLog = useCallback(async () => {
    if (!cwd || fetchingLogRef.current) return;
    fetchingLogRef.current = true;
    try {
      const result = await invoke<CommitEntry[]>('get_git_log', { cwd, limit: 50 });
      setLog(result);
    } catch { /* ignore */ }
    finally { fetchingLogRef.current = false; }
  }, [cwd]);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 15000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchStatus]);

  useEffect(() => {
    if (activeSection === 'history') fetchLog();
  }, [activeSection, fetchLog]);

  const handleViewFileDiff = async (file: GitFileStatus, staged: boolean) => {
    if (!cwd) return;
    try {
      const diff = await invoke<string>('get_git_diff', { cwd, filePath: file.path, staged });
      onOverlayView({
        type: 'diff',
        title: file.path,
        content: diff || '(no changes)',
      });
    } catch { /* ignore */ }
  };

  const handleViewCommitDiff = async (entry: CommitEntry) => {
    if (!cwd) return;
    try {
      const diff = await invoke<string>('get_git_commit_diff', { cwd, sha: entry.sha });
      onOverlayView({
        type: 'diff',
        title: `${entry.shortSha} - ${entry.message}`,
        content: diff || '(empty commit)',
      });
    } catch { /* ignore */ }
  };

  const handleStage = async (filePath: string) => {
    if (!cwd) return;
    try {
      await invoke('git_stage_file', { cwd, filePath });
      await fetchStatus();
    } catch { /* ignore */ }
  };

  const handleUnstage = async (filePath: string) => {
    if (!cwd) return;
    try {
      await invoke('git_unstage_file', { cwd, filePath });
      await fetchStatus();
    } catch { /* ignore */ }
  };

  const handleCommit = async () => {
    if (!cwd || !commitMsg.trim() || !status?.staged.length) return;
    setIsCommitting(true);
    try {
      await invoke('git_commit', { cwd, message: commitMsg.trim() });
      setCommitMsg('');
      await fetchStatus();
      await fetchLog();
    } catch (e) {
      setError(String(e));
    } finally {
      setIsCommitting(false);
    }
  };

  if (!cwd) {
    return (
      <div className="gp-empty">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <line x1="12" y1="1" x2="12" y2="9" />
          <line x1="12" y1="15" x2="12" y2="23" />
        </svg>
        <span>No project selected</span>
      </div>
    );
  }

  return (
    <div className="gp-container">
      {status && (
        <div className="gp-branch-row">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="5" cy="4" r="2" />
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="6" r="2" />
            <path d="M5 6v4M10 6c-2 0-5 1-5 4" />
          </svg>
          <span className="gp-branch-name">{status.branch}</span>
        </div>
      )}

      <div className="gp-section-tabs">
        <button
          className={`gp-section-tab${activeSection === 'changes' ? ' gp-section-tab--active' : ''}`}
          onClick={() => setActiveSection('changes')}
        >
          Changes
          {status && (status.staged.length + status.unstaged.length > 0) && (
            <span className="gp-badge">{status.staged.length + status.unstaged.length}</span>
          )}
        </button>
        <button
          className={`gp-section-tab${activeSection === 'history' ? ' gp-section-tab--active' : ''}`}
          onClick={() => { setActiveSection('history'); fetchLog(); }}
        >
          History
        </button>
      </div>

      {error && <div className="gp-error">{error}</div>}

      {activeSection === 'changes' && status && (
        <div className="gp-changes">
          {status.staged.length > 0 && (
            <div className="gp-file-section">
              <div className="gp-file-section-header">
                <span>Staged Changes</span>
                <span className="gp-count">{status.staged.length}</span>
              </div>
              {status.staged.map((f) => (
                <button key={`s-${f.path}`} className="gp-file-item" onClick={() => handleViewFileDiff(f, true)}>
                  <span className="gp-file-status" style={{ color: statusColor(f.status) }}>{statusIcon(f.status)}</span>
                  <span className="gp-file-name" title={f.path}>{fileName(f.path)}</span>
                  <span className="gp-file-path" title={f.path}>{f.path}</span>
                  <div className="gp-file-actions">
                    {f.additions > 0 && <span className="gp-stat-add">+{f.additions}</span>}
                    {f.deletions > 0 && <span className="gp-stat-del">-{f.deletions}</span>}
                    <button className="gp-action-btn" onClick={(e) => { e.stopPropagation(); handleUnstage(f.path); }} title="Unstage">
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="3" y1="6" x2="9" y2="6" /></svg>
                    </button>
                  </div>
                </button>
              ))}
            </div>
          )}

          {status.unstaged.length > 0 && (
            <div className="gp-file-section">
              <div className="gp-file-section-header">
                <span>Unstaged Changes</span>
                <span className="gp-count">{status.unstaged.length}</span>
              </div>
              {status.unstaged.map((f) => (
                <button key={`u-${f.path}`} className="gp-file-item" onClick={() => handleViewFileDiff(f, false)}>
                  <span className="gp-file-status" style={{ color: statusColor(f.status) }}>{statusIcon(f.status)}</span>
                  <span className="gp-file-name" title={f.path}>{fileName(f.path)}</span>
                  <span className="gp-file-path" title={f.path}>{f.path}</span>
                  <div className="gp-file-actions">
                    {f.additions > 0 && <span className="gp-stat-add">+{f.additions}</span>}
                    {f.deletions > 0 && <span className="gp-stat-del">-{f.deletions}</span>}
                    <button className="gp-action-btn" onClick={(e) => { e.stopPropagation(); handleStage(f.path); }} title="Stage">
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="6" y1="3" x2="6" y2="9" /><line x1="3" y1="6" x2="9" y2="6" /></svg>
                    </button>
                  </div>
                </button>
              ))}
            </div>
          )}

          {status.staged.length === 0 && status.unstaged.length === 0 && (
            <div className="gp-empty-changes">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="5,10 8,13 15,6" />
              </svg>
              <span>Working tree clean</span>
            </div>
          )}

          {status.staged.length > 0 && (
            <div className="gp-commit-section">
              <textarea
                className="gp-commit-input"
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                placeholder="Commit message..."
                rows={3}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    handleCommit();
                  }
                }}
              />
              <button
                className="gp-commit-btn"
                onClick={handleCommit}
                disabled={!commitMsg.trim() || isCommitting}
              >
                {isCommitting ? 'Committing...' : `Commit (${status.staged.length} file${status.staged.length > 1 ? 's' : ''})`}
              </button>
            </div>
          )}
        </div>
      )}

      {activeSection === 'history' && (
        <div className="gp-history">
          {log.length === 0 ? (
            <div className="gp-empty-changes">
              <span>No commits yet</span>
            </div>
          ) : (
            log.map((entry) => (
              <button key={entry.sha} className="gp-log-item" onClick={() => handleViewCommitDiff(entry)}>
                <div className="gp-log-header">
                  <span className="gp-log-sha">{entry.shortSha}</span>
                  <span className="gp-log-date">{formatDate(entry.date)}</span>
                </div>
                <div className="gp-log-message">{entry.message}</div>
                <div className="gp-log-author">{entry.author}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
