import type { ThreadSummary } from '@whats-coder/shared';
import type { ChatHistoryEntry } from '../lib/db';

export function HistoryPanel({
  entries,
  searchQuery,
  onSearchChange,
  threads,
  onSelectMessage,
}: {
  entries: ChatHistoryEntry[];
  searchQuery: string;
  onSearchChange: (q: string) => void;
  threads: ThreadSummary[];
  onSelectMessage: (msg: string) => void;
}) {
  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const todayTs = today.getTime() / 1000;
  const yesterdayTs = yesterday.getTime() / 1000;

  const grouped = entries.reduce<{ today: ChatHistoryEntry[]; yesterday: ChatHistoryEntry[]; earlier: ChatHistoryEntry[] }>(
    (acc, entry) => {
      if (entry.created_at >= todayTs) acc.today.push(entry);
      else if (entry.created_at >= yesterdayTs) acc.yesterday.push(entry);
      else acc.earlier.push(entry);
      return acc;
    },
    { today: [], yesterday: [], earlier: [] }
  );

  const threadMap = Object.fromEntries(threads.map(t => [t.id, t.name || t.preview || t.id]));

  const renderGroup = (label: string, items: ChatHistoryEntry[]) => {
    if (items.length === 0) return null;
    return (
      <div key={label} className="history-group">
        <div className="history-group-label">{label}</div>
        {items.map(entry => (
          <div key={entry.id} className="history-card" onClick={() => onSelectMessage(entry.message)}>
            <div className="history-card-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
              </svg>
            </div>
            <div className="history-card-info">
              <div className="history-card-msg">{entry.message.length > 80 ? `${entry.message.slice(0, 80)}...` : entry.message}</div>
              {entry.thread_id && threadMap[entry.thread_id] && (
                <div className="history-card-thread">{threadMap[entry.thread_id]}</div>
              )}
            </div>
            <div className="history-card-actions">
              <button className="history-action-btn" title="Use this message">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="6,3 14,8 6,13" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="providers-panel">
      <div className="providers-header" data-tauri-drag-region>
        <h2>History</h2>
      </div>

      <div className="providers-toolbar">
        <div className="history-toolbar-search">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="7" cy="7" r="5" /><path d="M11 11l3.5 3.5" />
          </svg>
          <input
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search history..."
          />
          {searchQuery && (
            <button className="history-search-clear" onClick={() => onSearchChange('')}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="providers-list">
        {entries.length === 0 ? (
          <div className="provider-empty-state">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="20" cy="20" r="14" />
              <path d="M20 12v8l5 3" />
            </svg>
            <div>暂无历史记录</div>
            <div>Your chat history will appear here.</div>
          </div>
        ) : (
          <>
            {renderGroup('今天', grouped.today)}
            {renderGroup('昨天', grouped.yesterday)}
            {renderGroup('更早', grouped.earlier)}
          </>
        )}
      </div>
    </div>
  );
}
