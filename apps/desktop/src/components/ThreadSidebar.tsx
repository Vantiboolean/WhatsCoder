import React, { memo, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { ConnectionState, ThreadSummary } from '@whats-coder/shared';


type SidebarView = 'threads' | 'settings' | 'automations' | 'skills' | 'usage' | 'providers' | 'history' | 'workspace';

type ThreadGroup = {
  folder: string;
  cwd: string;
  threads: ThreadSummary[];
};

type FolderMenuState = {
  cwd: string;
  x: number;
  y: number;
} | null;

type ThreadContextMenuState = {
  threadId: string;
  x: number;
  y: number;
} | null;

type Props = {
  width: number;
  onResizeStart: (event: React.MouseEvent<HTMLDivElement>) => void;
  connState: ConnectionState;
  sidebarView: SidebarView;
  onShowThreadHome: () => void;
  onOpenAutomations: () => void;
  onOpenSkills: () => void | Promise<void>;
  onOpenUsage: () => void;
  onOpenProviders: () => void;
  onOpenHistory: () => void;
  onOpenWorkspace: () => void;
  onOpenSettings: () => void;
  onAddProject: () => void | Promise<void>;
  showArchived: boolean;
  onToggleArchived: () => void;
  onRefreshThreads: () => void | Promise<void>;
  threadSearch: string;
  onThreadSearchChange: (value: string) => void;
  onClearThreadSearch: () => void;
  threadCount: number;
  pinnedThreads: ThreadSummary[];
  threadGroups: ThreadGroup[];
  pinnedThreadIds: ReadonlySet<string>;
  selectedThreadId: string | null;
  collapsedGroups: ReadonlySet<string>;
  collapsedThreadFamilies: ReadonlySet<string>;
  folderAlias: Readonly<Record<string, string>>;
  renamingFolder: string | null;
  onToggleGroup: (cwd: string) => void;
  onToggleThreadFamily: (threadId: string) => void;
  onRenameFolderStart: (cwd: string) => void;
  onSaveFolderAlias: (cwd: string, alias: string) => void;
  onCancelFolderRename: () => void;
  onSelectThread: (threadId: string) => void | Promise<void>;
  onOpenThreadContextMenu: (threadId: string, x: number, y: number) => void;
  onNewThreadInFolder: (cwd?: string) => void | Promise<void>;
  folderMenu: FolderMenuState;
  onToggleFolderMenu: (cwd: string, x: number, y: number) => void;
  onCloseFolderMenu: () => void;
  onOpenInExplorer: (cwd: string) => void | Promise<void>;
  onRemoveProject: (cwd: string) => void;
  onRemoveFolder: (cwd: string) => void;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMoreThreads: () => void | Promise<void>;
  threadContextMenu: ThreadContextMenuState;
  onCloseThreadContextMenu: () => void;
  onRenameThreadFromContext: (threadId: string) => void | Promise<void>;
  renamingThreadId: string | null;
  renamingThreadValue: string;
  onRenamingThreadValueChange: (value: string) => void;
  onSaveThreadRename: () => void;
  onCancelThreadRename: () => void;
  onPinThread: (threadId: string) => void;
  onForkThreadFromContext: (threadId: string) => void | Promise<void>;
  onArchiveThreadFromContext: (threadId: string) => void | Promise<void>;
  viewMode: 'project' | 'timeline';
  onViewModeChange: (mode: 'project' | 'timeline') => void;
  sortBy: 'updated' | 'created';
  onSortByChange: (sort: 'updated' | 'created') => void;
};

const INITIAL_THREAD_LIMIT = 10;

function getThreadGroupKey(group: ThreadGroup): string {
  return group.folder ? `group:${group.cwd}` : 'ungrouped';
}

function formatRelativeTime(unixSec: number, t: TFunction): string {
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return t('time.now');
  if (diff < 3600) return t('time.minutesShort', { count: Math.floor(diff / 60) });
  if (diff < 86400) return t('time.hoursShort', { count: Math.floor(diff / 3600) });
  if (diff < 604800) return t('time.daysShort', { count: Math.floor(diff / 86400) });
  return new Date(unixSec * 1000).toLocaleDateString();
}

function getContinuationProviderLabel(provider?: string | null): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return 'Previous';
}

type ThreadTreeNode = {
  thread: ThreadSummary;
  children: ThreadTreeNode[];
  descendantIds: string[];
  latestActivity: number;
};

function buildThreadForest(threads: ThreadSummary[]): ThreadTreeNode[] {
  if (threads.length === 0) {
    return [];
  }

  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const childrenByParent = new Map<string, ThreadSummary[]>();
  const roots: ThreadSummary[] = [];
  const sortByActivity = (a: ThreadSummary, b: ThreadSummary) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt);

  for (const thread of threads) {
    const sourceThreadId = thread.continuation?.sourceThreadId;
    if (sourceThreadId && byId.has(sourceThreadId)) {
      const siblings = childrenByParent.get(sourceThreadId) ?? [];
      siblings.push(thread);
      childrenByParent.set(sourceThreadId, siblings);
    } else {
      roots.push(thread);
    }
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort(sortByActivity);
  }

  const buildNode = (thread: ThreadSummary): ThreadTreeNode => {
    const children = (childrenByParent.get(thread.id) ?? []).map(buildNode);
    const descendantIds = [thread.id, ...children.flatMap((child) => child.descendantIds)];
    const latestActivity = Math.max(
      thread.updatedAt ?? thread.createdAt,
      ...children.map((child) => child.latestActivity),
    );
    return {
      thread,
      children,
      descendantIds,
      latestActivity,
    };
  };

  return roots
    .sort(sortByActivity)
    .map(buildNode)
    .sort((a, b) => b.latestActivity - a.latestActivity);
}

const ThreadRow = memo(function ThreadRow({
  thread,
  selected,
  pinned,
  ungrouped,
  depth = 0,
  hasChildren = false,
  isFamilyCollapsed = false,
  onToggleFamily,
  onSelectThread,
  onOpenThreadContextMenu,
  onArchiveThread,
  isRenaming,
  renameValue,
  onRenameValueChange,
  onSaveRename,
  onCancelRename,
}: {
  thread: ThreadSummary;
  selected: boolean;
  pinned: boolean;
  ungrouped?: boolean;
  depth?: number;
  hasChildren?: boolean;
  isFamilyCollapsed?: boolean;
  onToggleFamily?: () => void;
  onSelectThread: (threadId: string) => void | Promise<void>;
  onOpenThreadContextMenu: (threadId: string, x: number, y: number) => void;
  onArchiveThread: (threadId: string) => void | Promise<void>;
  isRenaming?: boolean;
  renameValue?: string;
  onRenameValueChange?: (value: string) => void;
  onSaveRename?: () => void;
  onCancelRename?: () => void;
}) {
  const { t } = useTranslation();
  const displayName = thread.name || t('sidebar.untitled');
  const continuation = thread.continuation;
  const continuationLabel = continuation ? getContinuationProviderLabel(continuation.sourceProvider) : null;
  const continuationName = continuation?.sourceThreadName || continuation?.sourceThreadId || null;
  const [confirmArchive, setConfirmArchive] = useState(false);
  const rowPaddingLeft = (ungrouped ? 12 : 24) + (depth * 14);
  const showTreeSpacer = hasChildren || depth > 0;
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) renameInputRef.current?.focus();
  }, [isRenaming]);

  const handleArchiveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmArchive) {
      void onArchiveThread(thread.id);
      setConfirmArchive(false);
    } else {
      setConfirmArchive(true);
    }
  };

  const handleToggleFamily = (event: React.MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onToggleFamily?.();
  };

  return (
    <button
      className={`sidebar-thread-item${ungrouped ? ' sidebar-thread-item--ungrouped' : ''}${pinned ? ' thread-item--pinned' : ''}${selected ? ' sidebar-thread-item--active' : ''}`}
      onClick={() => { void onSelectThread(thread.id); }}
      style={{ paddingLeft: rowPaddingLeft }}
      onMouseLeave={() => setConfirmArchive(false)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenThreadContextMenu(thread.id, event.clientX, event.clientY);
      }}
    >
      <div className="sidebar-thread-info">
        <div className="sidebar-thread-header">
          <div className="sidebar-thread-text">
            <div className="sidebar-thread-name">
              {showTreeSpacer && (
                hasChildren ? (
                  <span
                    className={`sidebar-thread-family-toggle${isFamilyCollapsed ? '' : ' sidebar-thread-family-toggle--open'}`}
                    onClick={handleToggleFamily}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    title={isFamilyCollapsed ? 'Expand family' : 'Collapse family'}
                    role="button"
                    aria-label={isFamilyCollapsed ? 'Expand family' : 'Collapse family'}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 1.5l4 3.5-4 3.5" />
                    </svg>
                  </span>
                ) : (
                  <span className="sidebar-thread-family-toggle sidebar-thread-family-toggle--spacer" aria-hidden="true" />
                )
              )}
              {thread.status?.type === 'active' && <span className="active-dot" />}
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  className="sidebar-thread-rename-input"
                  value={renameValue ?? ''}
                  onChange={e => onRenameValueChange?.(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); onSaveRename?.(); }
                    if (e.key === 'Escape') { e.preventDefault(); onCancelRename?.(); }
                  }}
                  onBlur={() => onSaveRename?.()}
                  onClick={e => e.stopPropagation()}
                  onMouseDown={e => e.stopPropagation()}
                  spellCheck={false}
                />
              ) : displayName}
            </div>
            {continuation && (
              <div className="sidebar-thread-handoff">
                <span className={`sidebar-thread-handoff-badge sidebar-thread-handoff-badge--${(continuation.sourceProvider ?? 'unknown').toLowerCase()}`}>
                  {`${t('common.from')} ${continuationLabel}`}
                </span>
                {continuationName && (
                  <span className="sidebar-thread-handoff-name" title={continuationName}>
                    {continuationName}
                  </span>
                )}
                {typeof continuation.compactedMessages === 'number' && continuation.compactedMessages > 0 && (
                  <span className="sidebar-thread-handoff-compact" title={`${continuation.compactedMessages} earlier messages were compacted during handoff`}>
                    C{continuation.compactedMessages}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="sidebar-thread-action">
            <span className="sidebar-thread-time">{formatRelativeTime(thread.updatedAt ?? thread.createdAt, t)}</span>
            <button
              className={`sidebar-thread-archive-btn${confirmArchive ? ' sidebar-thread-archive-btn--confirm' : ''}`}
              onClick={handleArchiveClick}
              title={confirmArchive ? t('sidebar.confirmArchive') : t('sidebar.archive')}
            >
              {confirmArchive ? (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="2,8 6,12 14,4" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 4h12v1.5a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" />
                  <path d="M4 6.5v6a1 1 0 001 1h6a1 1 0 001-1v-6" />
                  <path d="M6.5 9.5h3" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </button>
  );
});


export const ThreadSidebar = memo(function ThreadSidebar({
  width,
  onResizeStart,
  connState,
  sidebarView,
  onShowThreadHome,
  onOpenAutomations,
  onOpenSkills,
  onOpenUsage,
  onOpenProviders,
  onOpenHistory,
  onOpenWorkspace,
  onOpenSettings,
  onAddProject,
  showArchived,
  onToggleArchived,
  onRefreshThreads,
  threadSearch,
  onThreadSearchChange,
  onClearThreadSearch,
  threadCount,
  pinnedThreads,
  threadGroups,
  pinnedThreadIds,
  selectedThreadId,
  collapsedGroups,
  collapsedThreadFamilies,
  folderAlias,
  renamingFolder,
  onToggleGroup,
  onToggleThreadFamily,
  onRenameFolderStart,
  onSaveFolderAlias,
  onCancelFolderRename,
  onSelectThread,
  onOpenThreadContextMenu,
  onNewThreadInFolder,
  folderMenu,
  onToggleFolderMenu,
  onCloseFolderMenu,
  onOpenInExplorer,
  onRemoveProject,
  onRemoveFolder,
  nextCursor,
  loadingMore,
  onLoadMoreThreads,
  threadContextMenu,
  onCloseThreadContextMenu,
  onRenameThreadFromContext,
  renamingThreadId,
  renamingThreadValue,
  onRenamingThreadValueChange,
  onSaveThreadRename,
  onCancelThreadRename,
  onPinThread,
  onForkThreadFromContext,
  onArchiveThreadFromContext,
  viewMode,
  onViewModeChange,
  sortBy,
  onSortByChange,
}: Props) {
  const { t } = useTranslation();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [moreMenuPos, setMoreMenuPos] = useState<{ top: number; left: number } | null>(null);
  const moreMenuBtnRef = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [timelineVisibleThreadLimit, setTimelineVisibleThreadLimit] = useState(INITIAL_THREAD_LIMIT);
  const [groupVisibleThreadLimits, setGroupVisibleThreadLimits] = useState<Record<string, number>>({});

  const getVisibleThreadLimitForGroup = (group: ThreadGroup): number => {
    const key = getThreadGroupKey(group);
    return groupVisibleThreadLimits[key] ?? INITIAL_THREAD_LIMIT;
  };

  const handleLoadMoreGroupThreads = (group: ThreadGroup) => {
    const key = getThreadGroupKey(group);
    setGroupVisibleThreadLimits((prev) => ({
      ...prev,
      [key]: (prev[key] ?? INITIAL_THREAD_LIMIT) + INITIAL_THREAD_LIMIT,
    }));
  };

  const renderThreadForest = (
    threadsToRender: ThreadSummary[],
    options?: { ungrouped?: boolean; forcePinned?: boolean; showPinnedState?: boolean },
  ) => {
    const forest = buildThreadForest(threadsToRender);

    const renderNode = (node: ThreadTreeNode, depth = 0): React.ReactNode => {
      const containsSelected = selectedThreadId ? node.descendantIds.includes(selectedThreadId) : false;
      const isCollapsed = node.children.length > 0 && collapsedThreadFamilies.has(node.thread.id) && !containsSelected;

      return (
        <div key={node.thread.id} className="sidebar-thread-tree-node">
          <ThreadRow
            thread={node.thread}
            selected={selectedThreadId === node.thread.id}
            pinned={options?.forcePinned ?? (options?.showPinnedState === false ? false : pinnedThreadIds.has(node.thread.id))}
            ungrouped={options?.ungrouped}
            depth={depth}
            hasChildren={node.children.length > 0}
            isFamilyCollapsed={isCollapsed}
            onToggleFamily={() => onToggleThreadFamily(node.thread.id)}
            onSelectThread={onSelectThread}
            onOpenThreadContextMenu={onOpenThreadContextMenu}
            onArchiveThread={onArchiveThreadFromContext}
            isRenaming={renamingThreadId === node.thread.id}
            renameValue={renamingThreadId === node.thread.id ? renamingThreadValue : undefined}
            onRenameValueChange={onRenamingThreadValueChange}
            onSaveRename={onSaveThreadRename}
            onCancelRename={onCancelThreadRename}
          />
          {node.children.length > 0 && !isCollapsed && (
            <div className="sidebar-thread-children">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    };

    return forest.map((node) => renderNode(node));
  };

  return (
    <aside className="sidebar" style={{ width }}>
      <nav className="sidebar-nav">
        <button
          className="sidebar-nav-btn"
          onClick={onShowThreadHome}
          disabled={connState !== 'connected'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="8" y1="3" x2="8" y2="13" />
            <line x1="3" y1="8" x2="13" y2="8" />
          </svg>
          {t('sidebar.newThread')}
        </button>
        <button
          className={`sidebar-nav-btn${sidebarView === 'automations' ? ' sidebar-nav-btn--active' : ''}`}
          onClick={onOpenAutomations}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2v4l2.5 1.5" />
            <circle cx="8" cy="8" r="6" />
          </svg>
          {t('sidebar.automations')}
        </button>
        <button
          className={`sidebar-nav-btn${sidebarView === 'skills' ? ' sidebar-nav-btn--active' : ''}`}
          onClick={() => { void onOpenSkills(); }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="5" height="5" rx="1" />
            <rect x="9" y="2" width="5" height="5" rx="1" />
            <rect x="2" y="9" width="5" height="5" rx="1" />
            <rect x="9" y="9" width="5" height="5" rx="1" />
          </svg>
          {t('sidebar.skills')}
        </button>
        <button
          className={`sidebar-nav-btn${sidebarView === 'usage' ? ' sidebar-nav-btn--active' : ''}`}
          onClick={onOpenUsage}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="10" width="2.5" height="4" rx="0.5" />
            <rect x="6.75" y="6" width="2.5" height="8" rx="0.5" />
            <rect x="11.5" y="2" width="2.5" height="12" rx="0.5" />
          </svg>
          {t('sidebar.usage')}
        </button>
        <button
          className={`sidebar-nav-btn${sidebarView === 'providers' ? ' sidebar-nav-btn--active' : ''}`}
          onClick={onOpenProviders}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4h12M2 8h12M2 12h12" />
            <circle cx="5" cy="4" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="11" cy="8" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="7" cy="12" r="1.5" fill="currentColor" stroke="none" />
          </svg>
          {t('sidebar.providers')}
        </button>
        <button
          className={`sidebar-nav-btn${sidebarView === 'history' ? ' sidebar-nav-btn--active' : ''}`}
          onClick={onOpenHistory}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="6" />
            <polyline points="8,5 8,8 10.5,10" />
          </svg>
          {t('sidebar.history')}
        </button>
        <div className="sidebar-nav-group">
          <button
            className={`sidebar-nav-btn${sidebarView === 'workspace' ? ' sidebar-nav-btn--active' : ''}`}
            onClick={onOpenWorkspace}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2" width="5" height="5" rx="1" />
              <rect x="9" y="2" width="5" height="5" rx="1" />
              <rect x="2" y="9" width="5" height="5" rx="1" />
              <path d="M11.5 9.5h2.5" />
              <path d="M12.75 8.25v2.5" />
            </svg>
            {t('workspacePage.title')}
          </button>
        </div>
      </nav>

      <div className="sidebar-divider" />

      <div className="sidebar-threads-header">
        {searchOpen ? (
          <div className="sidebar-search-inline">
            <input
              ref={searchInputRef}
              className="sidebar-search-inline-input"
              value={threadSearch}
              onChange={(e) => onThreadSearchChange(e.target.value)}
              placeholder={t('sidebar.searchThreads')}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Escape') { setSearchOpen(false); onClearThreadSearch(); } }}
            />
            <button
              className="sidebar-icon-btn"
              onClick={() => { setSearchOpen(false); onClearThreadSearch(); }}
              title={t('sidebar.closeSearch')}
            >
              <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        ) : (
          <>
            <span className="sidebar-threads-label">{t('sidebar.threads')}</span>
            <div className="sidebar-threads-actions">
              <button
                className="sidebar-icon-btn"
                onClick={() => { void onAddProject(); }}
                title={t('sidebar.addProjectFolder')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
                  <line x1="8" y1="8" x2="8" y2="12" />
                  <line x1="6" y1="10" x2="10" y2="10" />
                </svg>
              </button>
              <div>
                <button
                  ref={moreMenuBtnRef}
                  className={`sidebar-icon-btn${moreMenuOpen ? ' sidebar-icon-btn--active' : ''}`}
                  onClick={() => {
                    if (!moreMenuOpen && moreMenuBtnRef.current) {
                      const rect = moreMenuBtnRef.current.getBoundingClientRect();
                      setMoreMenuPos({ top: rect.bottom + 4, left: Math.max(rect.right - 180, 8) });
                    }
                    setMoreMenuOpen(!moreMenuOpen);
                  }}
                  title={t('sidebar.moreOptions')}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="8" cy="3" r="1.3" />
                    <circle cx="8" cy="8" r="1.3" />
                    <circle cx="8" cy="13" r="1.3" />
                  </svg>
                </button>
                {moreMenuOpen && moreMenuPos && (
                  <>
                    <div className="ctx-backdrop" onClick={() => setMoreMenuOpen(false)} />
                    <div className="ctx-menu" style={{ top: moreMenuPos.top, left: moreMenuPos.left }}>
                      <div className="ctx-menu-group-label">{t('sidebar.viewLabel')}</div>
                      <button className={`ctx-menu-item${viewMode === 'project' ? ' ctx-menu-item--checked' : ''}`} onClick={() => { onViewModeChange('project'); setMoreMenuOpen(false); }}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
                        </svg>
                        {t('sidebar.viewByProject')}
                        {viewMode === 'project' && <svg className="ctx-menu-check" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6l2.5 2.5 4.5-5" /></svg>}
                      </button>
                      <button className={`ctx-menu-item${viewMode === 'timeline' ? ' ctx-menu-item--checked' : ''}`} onClick={() => { onViewModeChange('timeline'); setMoreMenuOpen(false); }}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 4h10M3 8h10M3 12h10" />
                        </svg>
                        {t('sidebar.viewByTime')}
                        {viewMode === 'timeline' && <svg className="ctx-menu-check" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6l2.5 2.5 4.5-5" /></svg>}
                      </button>

                      <div className="ctx-menu-sep" />
                      <div className="ctx-menu-group-label">{t('sidebar.sortLabel')}</div>
                      <button className={`ctx-menu-item${sortBy === 'updated' ? ' ctx-menu-item--checked' : ''}`} onClick={() => { onSortByChange('updated'); setMoreMenuOpen(false); }}>
                        {t('sidebar.sortUpdated')}
                        {sortBy === 'updated' && <svg className="ctx-menu-check" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6l2.5 2.5 4.5-5" /></svg>}
                      </button>
                      <button className={`ctx-menu-item${sortBy === 'created' ? ' ctx-menu-item--checked' : ''}`} onClick={() => { onSortByChange('created'); setMoreMenuOpen(false); }}>
                        {t('sidebar.sortCreated')}
                        {sortBy === 'created' && <svg className="ctx-menu-check" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6l2.5 2.5 4.5-5" /></svg>}
                      </button>

                      <div className="ctx-menu-sep" />
                      <button className={`ctx-menu-item${showArchived ? ' ctx-menu-item--checked' : ''}`} onClick={() => { onToggleArchived(); setMoreMenuOpen(false); }}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="3" width="12" height="3" rx="1" />
                          <path d="M3 6v6a1 1 0 001 1h8a1 1 0 001-1V6" />
                          <path d="M6.5 9h3" />
                        </svg>
                        {showArchived ? t('sidebar.hideArchived') : t('sidebar.showArchived')}
                      </button>
                      <button className="ctx-menu-item" onClick={() => { void onRefreshThreads(); setMoreMenuOpen(false); }}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                          <path d="M2.5 8a5.5 5.5 0 0 1 9.3-4" strokeLinecap="round" />
                          <path d="M13.5 8a5.5 5.5 0 0 1-9.3 4" strokeLinecap="round" />
                          <polyline points="12,2 12,5 9,5" strokeLinecap="round" strokeLinejoin="round" />
                          <polyline points="4,14 4,11 7,11" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {t('sidebar.refresh')}
                      </button>
                    </div>
                  </>
                )}
              </div>
              <button
                className={`sidebar-icon-btn${threadSearch ? ' sidebar-icon-btn--active' : ''}`}
                onClick={() => { setSearchOpen(true); }}
                title={t('sidebar.searchThreads')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="7" cy="7" r="5" />
                  <path d="M11 11l3.5 3.5" />
                </svg>
              </button>
            </div>
          </>
        )}
      </div>

      <div className="sidebar-thread-list">
        {threadCount === 0 && connState === 'connected' && (
          <div className="sidebar-thread-empty">
            {t('sidebar.noThreadsYet')}
          </div>
        )}

        {pinnedThreads.length > 0 && (
          <div className="thread-group">
            <div className="pinned-group-header">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828 1a1 1 0 01.707.293l4.172 4.172a1 1 0 010 1.414l-1.586 1.586a1 1 0 01-1.414 0l-.464-.464-2.828 2.828.929.929a1 1 0 010 1.414l-.707.707a1 1 0 01-1.414 0L7 12.243l-3.536 3.536a1 1 0 01-1.414-1.414L5.586 11 4.172 9.586a1 1 0 010-1.414l.707-.707a1 1 0 011.414 0l.929.929 2.828-2.828-.464-.464a1 1 0 010-1.414l1.586-1.586A1 1 0 019.828 1z"/></svg>
              {t('sidebar.pinned')}
            </div>
            {renderThreadForest(pinnedThreads, { ungrouped: true, forcePinned: true })}
          </div>
        )}

        {viewMode === 'timeline' ? (
          (() => {
            const allThreads = threadGroups.flatMap(g => g.threads);
            const pinnedSet = pinnedThreadIds;
            const unpinned = allThreads.filter(t => !pinnedSet.has(t.id));
            const sorted = [...unpinned].sort((a, b) => {
              const aTime = sortBy === 'created' ? (a.createdAt) : (a.updatedAt ?? a.createdAt);
              const bTime = sortBy === 'created' ? (b.createdAt) : (b.updatedAt ?? b.createdAt);
              return bTime - aTime;
            });
            const limited = sorted.slice(0, timelineVisibleThreadLimit);
            const hasMoreLocal = sorted.length > timelineVisibleThreadLimit;
            return (
              <>
                {renderThreadForest(limited, { ungrouped: true, showPinnedState: false })}
                {hasMoreLocal && (
                  <button
                    className="sidebar-load-more"
                    onClick={() => setTimelineVisibleThreadLimit((prev) => prev + INITIAL_THREAD_LIMIT)}
                  >
                    {t('sidebar.loadMoreThreads')} ({sorted.length - timelineVisibleThreadLimit})
                  </button>
                )}
              </>
            );
          })()
        ) : (() => {
          const hasMoreLocal = threadGroups.some((group) => group.threads.length > getVisibleThreadLimitForGroup(group));
          const elements: React.ReactNode[] = [];

          for (const group of threadGroups) {
            const visibleLimit = getVisibleThreadLimitForGroup(group);
            const groupThreads = group.threads.slice(0, visibleLimit);
            const hasMoreGroupThreads = group.threads.length > visibleLimit;

            if (!group.folder) {
              elements.push(
                <React.Fragment key="ungrouped">
                  {renderThreadForest(groupThreads, { ungrouped: true, showPinnedState: false })}
                  {hasMoreGroupThreads && (
                    <button
                      className="sidebar-load-more"
                      onClick={() => handleLoadMoreGroupThreads(group)}
                    >
                      {t('sidebar.loadMoreThreads')} ({group.threads.length - visibleLimit})
                    </button>
                  )}
                </React.Fragment>
              );
              continue;
            }

            const isCollapsed = collapsedGroups.has(group.cwd);
            const displayName = folderAlias[group.cwd] || group.folder;

            elements.push(
              <div key={group.cwd} className="thread-group">
                <div className="thread-group-header">
                  <button className="thread-group-toggle" onClick={() => onToggleGroup(group.cwd)}>
                    <svg
                      className={`thread-group-chevron${isCollapsed ? '' : ' thread-group-chevron--open'}`}
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 1.5l4 3.5-4 3.5" />
                    </svg>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
                    </svg>
                    {renamingFolder === group.cwd ? (
                      <input
                        className="thread-group-rename"
                        autoFocus
                        defaultValue={displayName}
                        onBlur={(event) => onSaveFolderAlias(group.cwd, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            onSaveFolderAlias(group.cwd, (event.target as HTMLInputElement).value);
                          }
                          if (event.key === 'Escape') {
                            onCancelFolderRename();
                          }
                        }}
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : (
                      <span className="thread-group-name">{displayName}</span>
                    )}
                  </button>
                  <div className="thread-group-actions">
                    <button
                      className="thread-group-action-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onNewThreadInFolder(group.cwd);
                      }}
                      title={t('sidebar.newThreadInFolder')}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="6" y1="2" x2="6" y2="10" /><line x1="2" y1="6" x2="10" y2="6" /></svg>
                    </button>
                    <button
                      className="thread-group-action-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleFolderMenu(group.cwd, event.clientX, event.clientY);
                      }}
                      title={t('sidebar.moreActions')}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                        <circle cx="6" cy="2.5" r="1" /><circle cx="6" cy="6" r="1" /><circle cx="6" cy="9.5" r="1" />
                      </svg>
                    </button>
                  </div>
                </div>
                {!isCollapsed && renderThreadForest(groupThreads)}
                {!isCollapsed && hasMoreGroupThreads && (
                  <button
                    className="sidebar-load-more"
                    onClick={() => handleLoadMoreGroupThreads(group)}
                  >
                    {t('sidebar.loadMoreThreads')} ({group.threads.length - visibleLimit})
                  </button>
                )}
              </div>
            );
          }

          return (
            <>
              {elements}
            </>
          );
        })()}

        {(() => {
          const hasLoadedThreads = threadGroups.some((group) => group.threads.length > 0);
          const hasMoreLocal = viewMode === 'timeline'
            ? threadGroups.flatMap((group) => group.threads).length > timelineVisibleThreadLimit
            : threadGroups.some((group) => group.threads.length > getVisibleThreadLimitForGroup(group));
          const canShowServerLoadMore = viewMode === 'timeline'
            ? hasLoadedThreads
            : threadGroups.some((group) => group.threads.length > INITIAL_THREAD_LIMIT);

          return !hasLoadedThreads || (!hasMoreLocal && canShowServerLoadMore) ? (
          nextCursor && (
            <button
              className="sidebar-load-more"
              onClick={() => { void onLoadMoreThreads(); }}
              disabled={loadingMore}
            >
              {loadingMore ? t('common.loading') : t('sidebar.loadMoreThreads')}
            </button>
          )
          ) : null;
        })()}
      </div>

      {folderMenu && (
        <>
          <div className="ctx-backdrop" onClick={onCloseFolderMenu} />
          <div className="ctx-menu" style={{ top: folderMenu.y, left: Math.min(folderMenu.x, 220) }}>
            <button className="ctx-menu-item" onClick={() => { void onOpenInExplorer(folderMenu.cwd); }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
              </svg>
              {t('sidebar.openInExplorer')}
            </button>
            <button className="ctx-menu-item" onClick={() => { void onNewThreadInFolder(folderMenu.cwd); onCloseFolderMenu(); }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 8h8M8 4v8" />
              </svg>
              {t('sidebar.newThread')}
            </button>
            <div className="ctx-menu-sep" />
            <button className="ctx-menu-item" onClick={() => onRenameFolderStart(folderMenu.cwd)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.5 1.5l3 3L5 14H2v-3z" />
              </svg>
              {t('sidebar.rename')}
            </button>
            <button className="ctx-menu-item ctx-menu-item--danger" onClick={() => onRemoveProject(folderMenu.cwd)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 5h10M5.5 5V3.5a1 1 0 011-1h3a1 1 0 011 1V5M6.5 7.5v4M9.5 7.5v4" />
                <path d="M4 5l.7 8.4a1 1 0 001 .9h4.6a1 1 0 001-.9L12 5" />
              </svg>
              {t('sidebar.removeProject')}
            </button>
            <button className="ctx-menu-item ctx-menu-item--danger" onClick={() => onRemoveFolder(folderMenu.cwd)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 5h12" />
                <path d="M4 5v8a1 1 0 001 1h6a1 1 0 001-1V5" />
              </svg>
              {t('sidebar.hideUntilRefresh')}
            </button>
          </div>
        </>
      )}

      {threadContextMenu && (
        <>
          <div className="ctx-backdrop" onClick={onCloseThreadContextMenu} />
          <div className="ctx-menu" style={{ top: Math.min(threadContextMenu.y, window.innerHeight - 200), left: Math.min(threadContextMenu.x, window.innerWidth - 180) }}>
            <button className="ctx-menu-item" onClick={() => { void onRenameThreadFromContext(threadContextMenu.threadId); }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3z" /></svg>
              {t('sidebar.rename')}
            </button>
            <button className="ctx-menu-item" onClick={() => onPinThread(threadContextMenu.threadId)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828 1a1 1 0 01.707.293l4.172 4.172a1 1 0 010 1.414l-1.586 1.586a1 1 0 01-1.414 0l-.464-.464-2.828 2.828.929.929a1 1 0 010 1.414l-.707.707a1 1 0 01-1.414 0L7 12.243l-3.536 3.536a1 1 0 01-1.414-1.414L5.586 11 4.172 9.586a1 1 0 010-1.414l.707-.707a1 1 0 011.414 0l.929.929 2.828-2.828-.464-.464a1 1 0 010-1.414l1.586-1.586A1 1 0 019.828 1z"/></svg>
              {pinnedThreadIds.has(threadContextMenu.threadId) ? t('sidebar.unpin') : t('sidebar.pin')}
            </button>
            <button className="ctx-menu-item" onClick={() => { void onForkThreadFromContext(threadContextMenu.threadId); }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3a2 2 0 100 4 2 2 0 000-4zM11 3a2 2 0 100 4 2 2 0 000-4zM5 9a2 2 0 100 4 2 2 0 000-4zM5 7v2M11 7c0 2-2 3-4 3" /></svg>
              {t('common.fork')}
            </button>
            <div className="ctx-menu-divider" />
            <button className="ctx-menu-item ctx-menu-item--danger" onClick={() => { void onArchiveThreadFromContext(threadContextMenu.threadId); }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4h12v1.5a1 1 0 01-1 1H3a1 1 0 01-1-1V4zM4 6.5v6a1 1 0 001 1h6a1 1 0 001-1v-6" /><path d="M6.5 9h3" /></svg>
              {t('sidebar.archive')}
            </button>
          </div>
        </>
      )}

      <div className="sidebar-footer">
        <button
          className={`sidebar-footer-btn${sidebarView === 'settings' ? ' sidebar-footer-btn--active' : ''}`}
          onClick={onOpenSettings}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="2.5" />
            <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M3.1 12.9l1.4-1.4M11.5 4.5l1.4-1.4" strokeLinecap="round" />
          </svg>
          {t('sidebar.settings')}
        </button>
      </div>
      <div className="sidebar-resize-handle" onMouseDown={onResizeStart} />
    </aside>
  );
});
