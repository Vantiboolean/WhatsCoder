import { Fragment, memo, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import type { ThreadDetail } from '@whats-coder/shared';

type WindowControlsProps = {
  className?: string;
};

type GitInfo = {
  addedLines: number;
  removedLines: number;
} | null;

type ProviderTimelineEntry = {
  threadId: string;
  provider: 'claude' | 'codex' | 'unknown';
  label: string;
  compactedMessages: number | null;
};

type Props = {
  threadDetail: ThreadDetail | null;
  displayedThread: ThreadDetail;
  providerTimeline: ProviderTimelineEntry[];
  editingName: boolean;
  editNameValue: string;
  onEditNameValueChange: (value: string) => void;
  onConfirmRename: () => void | Promise<void>;
  onCancelRename: () => void;
  onStartRename: () => void;
  isProcessing: boolean;
  isShowingPreviousThreadWhileLoading: boolean;
  isSelectedThreadTurnsLoading: boolean;
  showRawJson: boolean;
  rightSidebarOpen: boolean;
  gitInfo: GitInfo;
  onInterrupt: () => void | Promise<void>;
  onResume: () => void | Promise<void>;
  onCommitChanges: () => void | Promise<void>;
  onForkThread: () => void | Promise<void>;
  onToggleRawJson: () => void;
  onRollbackLastTurn: () => void | Promise<void>;
  onArchiveThread: () => void | Promise<void>;
  onOpenContinuationSource?: (threadId: string) => void | Promise<void>;
  onToggleRightSidebar: () => void;
  WindowControlsComponent: ComponentType<WindowControlsProps>;
};

function getContinuationProviderLabel(provider?: string | null): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return 'Previous';
}

export const ThreadToolbar = memo(function ThreadToolbar({
  threadDetail,
  displayedThread,
  providerTimeline,
  editingName,
  editNameValue,
  onEditNameValueChange,
  onConfirmRename,
  onCancelRename,
  onStartRename,
  isProcessing,
  isShowingPreviousThreadWhileLoading,
  isSelectedThreadTurnsLoading,
  showRawJson,
  rightSidebarOpen,
  gitInfo,
  onInterrupt,
  onResume,
  onCommitChanges,
  onForkThread,
  onToggleRawJson,
  onRollbackLastTurn,
  onArchiveThread,
  onOpenContinuationSource,
  onToggleRightSidebar,
  WindowControlsComponent,
}: Props) {
  const { t } = useTranslation();
  const projectName = displayedThread.cwd
    ? displayedThread.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop()
    : null;
  const continuation = displayedThread.continuation;
  const continuationProviderLabel = continuation ? getContinuationProviderLabel(continuation.sourceProvider) : null;
  const continuationName = continuation?.sourceThreadName || continuation?.sourceThreadId || null;

  return (
    <div className="thread-toolbar" data-tauri-drag-region>
      <div className="thread-toolbar-left">
        <div className="thread-toolbar-title-group">
          {editingName ? (
            <div className="thread-rename-row">
              <input
                className="thread-rename-input"
                value={editNameValue}
                onChange={(event) => onEditNameValueChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void onConfirmRename();
                  }
                  if (event.key === 'Escape') {
                    onCancelRename();
                  }
                }}
                autoFocus
                placeholder={t('toolbar.threadNamePlaceholder')}
              />
              <button className="thread-rename-confirm" onClick={() => { void onConfirmRename(); }} title={t('common.save')}>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <path d="M2 6.5L5.2 9.5L11 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          ) : (
            <button
              className="thread-toolbar-title"
              onClick={onStartRename}
              title={t('toolbar.clickToRename')}
              disabled={!threadDetail || isShowingPreviousThreadWhileLoading}
            >
              {(isShowingPreviousThreadWhileLoading || isSelectedThreadTurnsLoading) && (
                <span className="thread-toolbar-loading-dot" />
              )}
              <span className="thread-toolbar-title-text">
                {displayedThread.name || displayedThread.preview || t('toolbar.newThread')}
              </span>
              {projectName && (
                <>
                  <span className="thread-toolbar-title-sep">/</span>
                  <span className="thread-toolbar-title-project">{projectName}</span>
                </>
              )}
            </button>
          )}
          {providerTimeline.length > 1 && (
            <div
              className="thread-toolbar-provider-timeline"
              title={providerTimeline.map((entry) => entry.label).join(' -> ')}
            >
              <span className="thread-toolbar-provider-timeline-label">Providers</span>
              {providerTimeline.map((entry, index) => (
                <Fragment key={`${entry.threadId}-${entry.provider}`}>
                  {index > 0 && <span className="thread-toolbar-provider-arrow">→</span>}
                  <span className={`thread-toolbar-provider-pill thread-toolbar-provider-pill--${entry.provider}`}>
                    {entry.label}
                  </span>
                  {typeof entry.compactedMessages === 'number' && entry.compactedMessages > 0 && (
                    <span className="thread-toolbar-provider-compact">C{entry.compactedMessages}</span>
                  )}
                </Fragment>
              ))}
            </div>
          )}
          {continuation && continuation.sourceThreadId && (
            <button
              className="thread-toolbar-handoff"
              onClick={() => { void onOpenContinuationSource?.(continuation.sourceThreadId); }}
              disabled={!onOpenContinuationSource}
              title={continuationName ? `${t('toolbar.openSourceThread')}: ${continuationName}` : t('toolbar.openSourceThread')}
            >
              <span className={`thread-toolbar-handoff-badge thread-toolbar-handoff-badge--${(continuation.sourceProvider ?? 'unknown').toLowerCase()}`}>
                {`${t('common.from')} ${continuationProviderLabel}`}
              </span>
              {continuationName && <span className="thread-toolbar-handoff-name">{continuationName}</span>}
              {typeof continuation.compactedMessages === 'number' && continuation.compactedMessages > 0 && (
                <span className="thread-toolbar-handoff-compact">
                  C{continuation.compactedMessages}
                </span>
              )}
            </button>
          )}
        </div>
      </div>
      <div className="thread-toolbar-drag" data-tauri-drag-region />
      <div className="thread-toolbar-right">
        {isProcessing ? (
          <button className="toolbar-btn toolbar-btn--stop" onClick={() => { void onInterrupt(); }} title={t('toolbar.stopAgent')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <rect x="3" y="3" width="8" height="8" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button
            className="toolbar-btn toolbar-btn--run"
            onClick={() => { void onResume(); }}
            title={t('toolbar.resumeThread')}
            disabled={!threadDetail || isShowingPreviousThreadWhileLoading || threadDetail.status?.type === 'active'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <path d="M3.5 2l8 5-8 5z" />
            </svg>
          </button>
        )}
        <button
          className="toolbar-btn toolbar-btn--commit"
          onClick={() => { void onCommitChanges(); }}
          title={t('toolbar.commitChanges')}
          disabled={isProcessing || !threadDetail || isShowingPreviousThreadWhileLoading}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="7" cy="7" r="2.5" />
            <line x1="7" y1="0" x2="7" y2="4.5" />
            <line x1="7" y1="9.5" x2="7" y2="14" />
          </svg>
          <span>{t('toolbar.commit')}</span>
        </button>
        <button
          className="toolbar-icon-btn"
          onClick={() => { void onForkThread(); }}
          title={t('toolbar.forkThread')}
          disabled={!threadDetail || isShowingPreviousThreadWhileLoading}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="5" cy="4" r="2" />
            <circle cx="11" cy="4" r="2" />
            <circle cx="8" cy="13" r="2" />
            <path d="M5 6v2c0 2 3 3 3 3M11 6v2c0 2-3 3-3 3" />
          </svg>
        </button>
        <button
          className="toolbar-icon-btn"
          onClick={onToggleRawJson}
          title={showRawJson ? t('toolbar.chatView') : t('toolbar.terminalOutput')}
          disabled={isShowingPreviousThreadWhileLoading}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <path d="M4.5 6l2.5 2-2.5 2" />
            <line x1="8.5" y1="10" x2="11.5" y2="10" />
          </svg>
        </button>
        <button
          className="toolbar-icon-btn"
          onClick={() => { void onRollbackLastTurn(); }}
          title={t('toolbar.undoLastTurn')}
          disabled={!threadDetail?.turns?.length || isShowingPreviousThreadWhileLoading}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8a5 5 0 019-3" />
            <path d="M13 8a5 5 0 01-9 3" />
            <polyline points="11,3 12,5 10,6" />
          </svg>
        </button>
        <button
          className="toolbar-icon-btn"
          onClick={() => { void onArchiveThread(); }}
          title={t('toolbar.archiveThread')}
          disabled={!threadDetail || isShowingPreviousThreadWhileLoading}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="12" height="3" rx="1" />
            <path d="M3 6v6a1 1 0 001 1h8a1 1 0 001-1V6" />
            <path d="M6.5 9h3" />
          </svg>
        </button>
        {gitInfo && (gitInfo.addedLines > 0 || gitInfo.removedLines > 0) && (
          <span className="toolbar-diff-stats">
            {gitInfo.addedLines > 0 && <span className="diff-added">+{gitInfo.addedLines.toLocaleString()}</span>}
            {gitInfo.removedLines > 0 && <span className="diff-removed">-{gitInfo.removedLines.toLocaleString()}</span>}
          </span>
        )}
        <button
          className={`toolbar-icon-btn${rightSidebarOpen ? ' toolbar-icon-btn--active' : ''}`}
          onClick={onToggleRightSidebar}
          title={rightSidebarOpen ? t('toolbar.closeSidebar') : t('toolbar.openSidebar')}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <line x1="10" y1="2.5" x2="10" y2="13.5" />
          </svg>
        </button>
        <div className="toolbar-divider" />
        <WindowControlsComponent />
      </div>
    </div>
  );
});
