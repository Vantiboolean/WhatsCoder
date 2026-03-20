import { memo } from 'react';
import type { ConnectionState, ThreadSummary } from '@codex-mobile/shared';

type SidebarView = 'threads' | 'settings' | 'automations' | 'skills' | 'history';

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
  onOpenHistory: () => void;
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
  folderAlias: Readonly<Record<string, string>>;
  renamingFolder: string | null;
  onToggleGroup: (cwd: string) => void;
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
  onPinThread: (threadId: string) => void;
  onForkThreadFromContext: (threadId: string) => void | Promise<void>;
  onArchiveThreadFromContext: (threadId: string) => void | Promise<void>;
};

function formatRelativeTime(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

const ThreadRow = memo(function ThreadRow({
  thread,
  selected,
  pinned,
  ungrouped,
  onSelectThread,
  onOpenThreadContextMenu,
}: {
  thread: ThreadSummary;
  selected: boolean;
  pinned: boolean;
  ungrouped?: boolean;
  onSelectThread: (threadId: string) => void | Promise<void>;
  onOpenThreadContextMenu: (threadId: string, x: number, y: number) => void;
}) {
  return (
    <button
      className={`sidebar-thread-item${ungrouped ? ' sidebar-thread-item--ungrouped' : ''}${pinned ? ' thread-item--pinned' : ''}${selected ? ' sidebar-thread-item--active' : ''}`}
      onClick={() => { void onSelectThread(thread.id); }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenThreadContextMenu(thread.id, event.clientX, event.clientY);
      }}
    >
      <div className="sidebar-thread-info">
        <div className="sidebar-thread-name">
          {thread.status?.type === 'active' && <span className="active-dot" />}
          {thread.name || thread.preview || 'Untitled'}
        </div>
      </div>
      <span className="sidebar-thread-time">{formatRelativeTime(thread.updatedAt ?? thread.createdAt)}</span>
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
  onOpenHistory,
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
  folderAlias,
  renamingFolder,
  onToggleGroup,
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
  onPinThread,
  onForkThreadFromContext,
  onArchiveThreadFromContext,
}: Props) {
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
          New Thread
        </button>
        <button
          className={`sidebar-nav-btn${sidebarView === 'automations' ? ' sidebar-nav-btn--active' : ''}`}
          onClick={onOpenAutomations}
          disabled={connState !== 'connected'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2v4l2.5 1.5" />
            <circle cx="8" cy="8" r="6" />
          </svg>
          Automations
        </button>
        <button
          className={`sidebar-nav-btn${sidebarView === 'skills' ? ' sidebar-nav-btn--active' : ''}`}
          onClick={() => { void onOpenSkills(); }}
          disabled={connState !== 'connected'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="5" height="5" rx="1" />
            <rect x="9" y="2" width="5" height="5" rx="1" />
            <rect x="2" y="9" width="5" height="5" rx="1" />
            <rect x="9" y="9" width="5" height="5" rx="1" />
          </svg>
          Skills
        </button>
        <button
          className={`sidebar-nav-btn${sidebarView === 'history' ? ' sidebar-nav-btn--active' : ''}`}
          onClick={onOpenHistory}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="6" />
            <polyline points="8,5 8,8 10.5,10" />
          </svg>
          History
        </button>
      </nav>

      <div className="sidebar-divider" />

      <div className="sidebar-threads-header">
        <span className="sidebar-threads-label">Threads</span>
        <div className="sidebar-threads-actions">
          <button
            className="sidebar-icon-btn"
            onClick={() => { void onAddProject(); }}
            title="Add project folder"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
              <line x1="8" y1="8" x2="8" y2="12" />
              <line x1="6" y1="10" x2="10" y2="10" />
            </svg>
          </button>
          <button
            className={`sidebar-icon-btn${showArchived ? ' sidebar-icon-btn--active' : ''}`}
            onClick={onToggleArchived}
            title={showArchived ? 'Show active threads' : 'Show archived threads'}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="12" height="3" rx="1" />
              <path d="M3 6v6a1 1 0 001 1h8a1 1 0 001-1V6" />
              <path d="M6.5 9h3" />
            </svg>
          </button>
          <button
            className="sidebar-icon-btn"
            onClick={() => { void onRefreshThreads(); }}
            title="Refresh threads"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2.5 8a5.5 5.5 0 0 1 9.3-4" strokeLinecap="round" />
              <path d="M13.5 8a5.5 5.5 0 0 1-9.3 4" strokeLinecap="round" />
              <polyline points="12,2 12,5 9,5" strokeLinecap="round" strokeLinejoin="round" />
              <polyline points="4,14 4,11 7,11" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {connState === 'connected' && (
        <div className="sidebar-search">
          <svg className="sidebar-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11l3.5 3.5" />
          </svg>
          <input
            className="sidebar-search-input"
            value={threadSearch}
            onChange={(event) => onThreadSearchChange(event.target.value)}
            placeholder="Search threads... (Ctrl+K)"
          />
          {threadSearch && (
            <button className="sidebar-search-clear" onClick={onClearThreadSearch}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          )}
        </div>
      )}

      <div className="sidebar-thread-list">
        {threadCount === 0 && connState === 'connected' && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
            No threads yet.
          </div>
        )}

        {pinnedThreads.length > 0 && (
          <div className="thread-group">
            <div className="pinned-group-header">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828 1a1 1 0 01.707.293l4.172 4.172a1 1 0 010 1.414l-1.586 1.586a1 1 0 01-1.414 0l-.464-.464-2.828 2.828.929.929a1 1 0 010 1.414l-.707.707a1 1 0 01-1.414 0L7 12.243l-3.536 3.536a1 1 0 01-1.414-1.414L5.586 11 4.172 9.586a1 1 0 010-1.414l.707-.707a1 1 0 011.414 0l.929.929 2.828-2.828-.464-.464a1 1 0 010-1.414l1.586-1.586A1 1 0 019.828 1z"/></svg>
              已固定
            </div>
            {pinnedThreads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                selected={selectedThreadId === thread.id}
                pinned
                ungrouped
                onSelectThread={onSelectThread}
                onOpenThreadContextMenu={onOpenThreadContextMenu}
              />
            ))}
          </div>
        )}

        {threadGroups.map((group) => {
          if (!group.folder) {
            return group.threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                selected={selectedThreadId === thread.id}
                pinned={false}
                ungrouped
                onSelectThread={onSelectThread}
                onOpenThreadContextMenu={onOpenThreadContextMenu}
              />
            ));
          }

          const isCollapsed = collapsedGroups.has(group.cwd);
          const displayName = folderAlias[group.cwd] || group.folder;

          return (
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
                    title="New thread in this folder"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="6" y1="2" x2="6" y2="10" /><line x1="2" y1="6" x2="10" y2="6" /></svg>
                  </button>
                  <button
                    className="thread-group-action-btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleFolderMenu(group.cwd, event.clientX, event.clientY);
                    }}
                    title="More actions"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                      <circle cx="6" cy="2.5" r="1" /><circle cx="6" cy="6" r="1" /><circle cx="6" cy="9.5" r="1" />
                    </svg>
                  </button>
                </div>
              </div>
              {!isCollapsed && group.threads.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  selected={selectedThreadId === thread.id}
                  pinned={pinnedThreadIds.has(thread.id)}
                  onSelectThread={onSelectThread}
                  onOpenThreadContextMenu={onOpenThreadContextMenu}
                />
              ))}
            </div>
          );
        })}

        {nextCursor && (
          <button
            className="sidebar-load-more"
            onClick={() => { void onLoadMoreThreads(); }}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading...' : 'Load more threads'}
          </button>
        )}
      </div>

      {folderMenu && (
        <>
          <div className="ctx-backdrop" onClick={onCloseFolderMenu} />
          <div className="ctx-menu" style={{ top: folderMenu.y, left: Math.min(folderMenu.x, 220) }}>
            <button className="ctx-menu-item" onClick={() => { void onOpenInExplorer(folderMenu.cwd); }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
              </svg>
              Open in Explorer
            </button>
            <button className="ctx-menu-item" onClick={() => { void onNewThreadInFolder(folderMenu.cwd); onCloseFolderMenu(); }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 8h8M8 4v8" />
              </svg>
              New Thread
            </button>
            <div className="ctx-menu-sep" />
            <button className="ctx-menu-item" onClick={() => onRenameFolderStart(folderMenu.cwd)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.5 1.5l3 3L5 14H2v-3z" />
              </svg>
              Rename
            </button>
            <button className="ctx-menu-item ctx-menu-item--danger" onClick={() => onRemoveProject(folderMenu.cwd)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 5h10M5.5 5V3.5a1 1 0 011-1h3a1 1 0 011 1V5M6.5 7.5v4M9.5 7.5v4" />
                <path d="M4 5l.7 8.4a1 1 0 001 .9h4.6a1 1 0 001-.9L12 5" />
              </svg>
              Remove Project
            </button>
            <button className="ctx-menu-item ctx-menu-item--danger" onClick={() => onRemoveFolder(folderMenu.cwd)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 5h12" />
                <path d="M4 5v8a1 1 0 001 1h6a1 1 0 001-1V5" />
              </svg>
              Hide Until Refresh
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
              重命名
            </button>
            <button className="ctx-menu-item" onClick={() => onPinThread(threadContextMenu.threadId)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828 1a1 1 0 01.707.293l4.172 4.172a1 1 0 010 1.414l-1.586 1.586a1 1 0 01-1.414 0l-.464-.464-2.828 2.828.929.929a1 1 0 010 1.414l-.707.707a1 1 0 01-1.414 0L7 12.243l-3.536 3.536a1 1 0 01-1.414-1.414L5.586 11 4.172 9.586a1 1 0 010-1.414l.707-.707a1 1 0 011.414 0l.929.929 2.828-2.828-.464-.464a1 1 0 010-1.414l1.586-1.586A1 1 0 019.828 1z"/></svg>
              {pinnedThreadIds.has(threadContextMenu.threadId) ? '取消置顶' : '置顶'}
            </button>
            <button className="ctx-menu-item" onClick={() => { void onForkThreadFromContext(threadContextMenu.threadId); }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3a2 2 0 100 4 2 2 0 000-4zM11 3a2 2 0 100 4 2 2 0 000-4zM5 9a2 2 0 100 4 2 2 0 000-4zM5 7v2M11 7c0 2-2 3-4 3" /></svg>
              Fork
            </button>
            <div className="ctx-menu-divider" />
            <button className="ctx-menu-item ctx-menu-item--danger" onClick={() => { void onArchiveThreadFromContext(threadContextMenu.threadId); }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4h12v1.5a1 1 0 01-1 1H3a1 1 0 01-1-1V4zM4 6.5v6a1 1 0 001 1h6a1 1 0 001-1v-6" /><path d="M6.5 9h3" /></svg>
              归档
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
          Settings
        </button>
      </div>
      <div className="sidebar-resize-handle" onMouseDown={onResizeStart} />
    </aside>
  );
});
