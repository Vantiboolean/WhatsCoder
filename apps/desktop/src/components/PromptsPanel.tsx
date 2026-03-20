import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

type PromptItem = {
  name: string;
  path: string;
  content: string;
};

type PromptsList = {
  workspace: PromptItem[];
  general: PromptItem[];
};

export function PromptsPanel({
  cwd,
  onInsertPrompt,
}: {
  cwd: string | null;
  onInsertPrompt: (text: string) => void;
}) {
  const [prompts, setPrompts] = useState<PromptsList>({ workspace: [], general: [] });
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchPrompts = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<PromptsList>('list_prompts', { cwd: cwd || undefined });
      setPrompts(result);
    } catch { /* ignore */ }
    setLoading(false);
  }, [cwd]);

  useEffect(() => {
    fetchPrompts();
  }, [fetchPrompts]);

  const toggleExpand = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const filterPrompts = (items: PromptItem[]): PromptItem[] => {
    if (!search) return items;
    const lower = search.toLowerCase();
    return items.filter(
      (p) => p.name.toLowerCase().includes(lower) || p.content.toLowerCase().includes(lower)
    );
  };

  const filteredWorkspace = filterPrompts(prompts.workspace);
  const filteredGeneral = filterPrompts(prompts.general);

  const renderPromptItem = (prompt: PromptItem) => {
    const isExpanded = expandedPaths.has(prompt.path);
    return (
      <div key={prompt.path} className="pp-prompt-item">
        <div className="pp-prompt-row">
          <button className="pp-prompt-name" onClick={() => toggleExpand(prompt.path)}>
            <svg
              className={`pp-chevron${isExpanded ? ' pp-chevron--open' : ''}`}
              width="10" height="10" viewBox="0 0 10 10" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M3 1.5l4 3.5-4 3.5" />
            </svg>
            <span>{prompt.name}</span>
          </button>
          <button
            className="pp-send-btn"
            onClick={() => onInsertPrompt(prompt.content)}
            title="Send to chat"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 11L11 6 1 1v4l4 1-4 1z" />
            </svg>
            Send
          </button>
        </div>
        {isExpanded && (
          <div className="pp-prompt-content">
            <pre>{prompt.content}</pre>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="pp-container">
      <div className="pp-search">
        <svg className="pp-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="7" cy="7" r="5" />
          <path d="M11 11l3.5 3.5" />
        </svg>
        <input
          className="pp-search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search prompts..."
        />
        {search && (
          <button className="pp-search-clear" onClick={() => setSearch('')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
            </svg>
          </button>
        )}
      </div>

      {loading ? (
        <div className="pp-loading">Loading prompts...</div>
      ) : (
        <div className="pp-sections">
          <div className="pp-section">
            <div className="pp-section-header">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
              </svg>
              <span>Workspace Prompts</span>
              <span className="pp-count">{filteredWorkspace.length}</span>
            </div>
            {filteredWorkspace.length === 0 ? (
              <div className="pp-empty-section">
                {cwd ? 'No workspace prompts found' : 'No project selected'}
              </div>
            ) : (
              filteredWorkspace.map(renderPromptItem)
            )}
          </div>

          <div className="pp-section">
            <div className="pp-section-header">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 4v4l2.5 1.5" />
              </svg>
              <span>General Prompts</span>
              <span className="pp-count">{filteredGeneral.length}</span>
            </div>
            {filteredGeneral.length === 0 ? (
              <div className="pp-empty-section">No general prompts found</div>
            ) : (
              filteredGeneral.map(renderPromptItem)
            )}
          </div>
        </div>
      )}

      <div className="pp-hint">
        Prompts from <code>{cwd ? `${cwd}/.codex/prompts/` : '~/.codex/prompts/'}</code>
      </div>
    </div>
  );
}
