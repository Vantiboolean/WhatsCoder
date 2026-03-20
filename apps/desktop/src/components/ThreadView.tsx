import { Component, type ErrorInfo, type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import type { ThreadDetail, ThreadItem } from '@codex-mobile/shared';

const PAGE_SIZE = 50;
const INITIAL_PAGES = 2;
const MAX_OUTPUT_LINES = 50;

class MarkdownErrorBoundary extends Component<{ children: ReactNode; fallback: string }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.warn('Markdown render error:', err, info);
  }

  render() {
    if (this.state.hasError) {
      return <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{this.props.fallback}</pre>;
    }
    return this.props.children;
  }
}

type Props = {
  thread: ThreadDetail;
  isSending?: boolean;
  isAgentActive?: boolean;
  showRawJson?: boolean;
  onToggleRawJson?: () => void;
  overrideIsProcessing?: boolean;
};

type ThreadListItem = {
  item: ThreadItem;
  turnStatus: string;
  turnError?: string | null;
};

export function ThreadView({ thread, isSending, isAgentActive, showRawJson, onToggleRawJson, overrideIsProcessing }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const [visiblePages, setVisiblePages] = useState(INITIAL_PAGES);
  const prevThreadIdRef = useRef<string | null>(null);
  const isInitialLoadRef = useRef(true);

  useEffect(() => {
    if (prevThreadIdRef.current !== thread.id) {
      setVisiblePages(INITIAL_PAGES);
      prevThreadIdRef.current = thread.id;
      isInitialLoadRef.current = true;
    }
  }, [thread.id]);

  const allItems = useMemo(() => {
    const items: ThreadListItem[] = [];
    for (const turn of thread.turns ?? []) {
      for (const item of turn.items ?? []) {
        items.push({ item, turnStatus: turn.status, turnError: turn.error?.message ?? null });
      }
      if (turn.error?.message) {
        const parts: string[] = [turn.error.message];
        if (turn.error.additionalDetails) {
          parts.push(turn.error.additionalDetails);
        }
        if (turn.error.codexErrorInfo && Object.keys(turn.error.codexErrorInfo).length > 0) {
          parts.push(JSON.stringify(turn.error.codexErrorInfo, null, 2));
        }
        items.push({
          item: {
            type: '_turnError',
            id: `${turn.id}-error`,
            text: parts.join('\n\n'),
          },
          turnStatus: turn.status,
          turnError: turn.error.message,
        });
      }
    }
    return items;
  }, [thread.turns]);

  const maxVisible = visiblePages * PAGE_SIZE;
  const hiddenCount = Math.max(0, allItems.length - maxVisible);
  const visibleItems = hiddenCount > 0 ? allItems.slice(hiddenCount) : allItems;

  const handleLoadMore = useCallback(() => {
    const container = messagesRef.current;
    if (!container) {
      setVisiblePages((pages) => pages + 1);
      return;
    }

    const previousHeight = container.scrollHeight;
    const previousTop = container.scrollTop;
    setVisiblePages((pages) => pages + 1);
    requestAnimationFrame(() => {
      const nextHeight = container.scrollHeight;
      container.scrollTop = previousTop + (nextHeight - previousHeight);
    });
  }, []);

  const lastTurn = thread.turns?.[thread.turns.length - 1];
  const isProcessing = overrideIsProcessing ?? Boolean(isSending || isAgentActive || lastTurn?.status === 'inProgress');

  useEffect(() => {
    if (isInitialLoadRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
      isInitialLoadRef.current = false;
      return;
    }

    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [allItems.length, isProcessing]);

  return (
    <div className="tv-container">
      <div className="tv-header">
        <div className="tv-header-left">
          <div className="tv-title">{thread.name || thread.preview || 'Untitled Thread'}</div>
          <div className="tv-meta">
            {thread.turns?.length ?? 0} turns · {allItems.length} items ·{' '}
            {new Date((thread.updatedAt ?? thread.createdAt) * 1000).toLocaleString()}
            {isProcessing && <span className="tv-processing">Processing...</span>}
          </div>
        </div>
        {onToggleRawJson && (
          <div className="tv-header-actions">
            <button className="btn-small" onClick={onToggleRawJson}>
              {showRawJson ? 'Chat View' : 'Raw JSON'}
            </button>
          </div>
        )}
      </div>

      {showRawJson ? (
        <pre
          style={{
            flex: 1,
            overflow: 'auto',
            margin: 0,
            padding: '12px 20px',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            lineHeight: 1.6,
            color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'var(--bg-tertiary)',
          }}
        >
          {JSON.stringify(thread, null, 2)}
        </pre>
      ) : (
        <div className="tv-messages" ref={messagesRef}>
          {hiddenCount > 0 && (
            <button className="tv-load-more" onClick={handleLoadMore}>
              Load {Math.min(PAGE_SIZE, hiddenCount)} earlier messages ({hiddenCount} hidden)
            </button>
          )}
          {visibleItems.length === 0 ? (
            <div className="tv-empty">No messages in this thread yet. Send a message to start.</div>
          ) : (
            visibleItems.map(({ item }) => <ItemRenderer key={item.id} item={item} />)
          )}
          {isProcessing && (
            <div className="tv-agent-row">
              <div className="tv-typing-indicator">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

function CopyableCode({ children, className }: { children: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  const handleCopy = () => {
    const text = codeRef.current?.textContent ?? '';
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  if (!className) {
    return <code className="tv-md-inline-code">{children}</code>;
  }

  return (
    <code ref={codeRef} className={`tv-md-code ${className}`}>
      {children}
      <button className={`tv-code-copy${copied ? ' tv-code-copy--done' : ''}`} onClick={handleCopy} title="Copy code">
        {copied ? 'Done' : 'Copy'}
      </button>
    </code>
  );
}

const markdownComponents = {
  pre: (props: Record<string, unknown>) => <pre className="tv-md-pre">{props.children as ReactNode}</pre>,
  code: (props: Record<string, unknown>) => (
    <CopyableCode className={props.className as string | undefined}>{props.children as ReactNode}</CopyableCode>
  ),
  a: (props: Record<string, unknown>) => (
    <a href={props.href as string} target="_blank" rel="noopener noreferrer" className="tv-md-link">
      {props.children as ReactNode}
    </a>
  ),
  table: (props: Record<string, unknown>) => (
    <div className="tv-md-table-wrap">
      <table className="tv-md-table">{props.children as ReactNode}</table>
    </div>
  ),
};

const Markdown = memo(function Markdown({ children }: { children: string }) {
  const text = typeof children === 'string' ? children : String(children ?? '');
  if (!text) {
    return null;
  }

  return (
    <MarkdownErrorBoundary fallback={text}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents as never}>
        {text}
      </ReactMarkdown>
    </MarkdownErrorBoundary>
  );
});

function stringifyJson(value: unknown): string {
  if (value == null) {
    return '';
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractContentText(value: ThreadItem['content']): string {
  if (!value) {
    return '';
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.join('\n');
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        return entry.text ?? entry.path ?? entry.url ?? entry.imageUrl ?? '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

function extractToolContentText(item: ThreadItem): string {
  if (!item.contentItems || item.contentItems.length === 0) {
    return '';
  }

  return item.contentItems
    .map((entry) => entry.text ?? entry.imageUrl ?? '')
    .filter(Boolean)
    .join('\n');
}

function extractText(item: ThreadItem): string {
  return item.text ?? (extractContentText(item.content) || extractToolContentText(item));
}

function toSummaryList(summary: ThreadItem['summary']): string[] {
  if (!summary) {
    return [];
  }
  return Array.isArray(summary) ? summary.filter((entry) => typeof entry === 'string') : [summary];
}

function toReasoningContent(item: ThreadItem): string[] {
  if (!Array.isArray(item.content)) {
    return [];
  }
  return item.content.filter((entry): entry is string => typeof entry === 'string');
}

function renderToolResult(item: ThreadItem): ReactNode {
  const hasImages = item.contentItems?.some((e) => e.imageUrl);

  if (hasImages) {
    const nodes: ReactNode[] = [];
    const textParts: string[] = [];
    for (const entry of item.contentItems!) {
      if (entry.imageUrl) {
        if (textParts.length > 0) {
          nodes.push(<pre key={`text-${nodes.length}`} className="tv-cmd-output-pre">{textParts.join('\n')}</pre>);
          textParts.length = 0;
        }
        nodes.push(
          <img key={`img-${nodes.length}`} src={entry.imageUrl} alt="Tool result" style={{ maxWidth: '100%', maxHeight: 400, borderRadius: 4, display: 'block', marginBottom: 4 }} />
        );
      } else if (entry.text) {
        textParts.push(entry.text);
      }
    }
    if (textParts.length > 0) {
      nodes.push(<pre key={`text-${nodes.length}`} className="tv-cmd-output-pre">{textParts.join('\n')}</pre>);
    }
    if (item.result) {
      const resultText = stringifyJson(item.result);
      if (resultText) {
        nodes.push(<pre key={`result-${nodes.length}`} className="tv-cmd-output-pre">{resultText}</pre>);
      }
    }
    return nodes.length > 0 ? <>{nodes}</> : null;
  }

  if (item.result) {
    const text = stringifyJson(item.result);
    return text ? <pre className="tv-cmd-output-pre">{text}</pre> : null;
  }

  if (item.contentItems && item.contentItems.length > 0) {
    const textParts: string[] = [];
    for (const entry of item.contentItems) {
      if (entry.text) {
        textParts.push(entry.text);
      }
    }
    return textParts.length > 0 ? <pre className="tv-cmd-output-pre">{textParts.join('\n')}</pre> : null;
  }

  return null;
}

function getStructuredContent(item: ThreadItem): Record<string, unknown> | null {
  const structured = item.result?.structuredContent;
  if (!structured || typeof structured !== 'object') {
    return null;
  }

  return structured as Record<string, unknown>;
}

function formatByteCount(value: number | null): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function renderWebSearchAction(item: ThreadItem): string | null {
  const action = item.action;
  if (!action) {
    return null;
  }

  switch (action.type) {
    case 'search':
      return action.queries?.length ? action.queries.join(', ') : action.query ?? null;
    case 'open_page':
      return action.url ?? null;
    case 'find_in_page':
      return [action.url, action.pattern].filter(Boolean).join(' · ');
    default:
      return null;
  }
}

const ItemRenderer = memo(function ItemRenderer({ item }: { item: ThreadItem }) {
  switch (item.type) {
    case 'userMessage':
      return <UserMessage item={item} />;
    case 'agentMessage':
      return <AgentMessage item={item} />;
    case 'commandExecution':
      return <CommandExecution item={item} />;
    case 'fileChange':
      return <FileChange item={item} />;
    case 'reasoning':
      return <Reasoning item={item} />;
    case 'plan':
      return <PlanItem item={item} />;
    case 'contextCompaction':
      return <SystemInfo label="Context compacted" />;
    case 'enteredReviewMode':
      return <SystemInfo label={item.review ? `Entered review mode · ${item.review}` : 'Entered review mode'} />;
    case 'exitedReviewMode':
      return <SystemInfo label={item.review ? `Exited review mode · ${item.review}` : 'Exited review mode'} />;
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'hook':
    case 'collabAgentToolCall':
    case 'rawResponseItem':
      return <ToolCall item={item} />;
    case 'realtimeAudio':
      return <RealtimeAudioItem item={item} />;
    case 'webSearch':
      return <WebSearchItem item={item} />;
    case 'imageView':
      return <ImageViewItem item={item} />;
    case 'imageGeneration':
      return <ImageGenerationItem item={item} />;
    case '_turnError':
      return <TurnError message={item.text ?? 'Unknown error'} />;
    default:
      return <UnknownItem item={item} />;
  }
});

const UserMessage = memo(function UserMessage({ item }: { item: ThreadItem }) {
  const text = extractContentText(item.content);
  if (!text) {
    return null;
  }

  return (
    <div className="tv-user-row">
      <div className="tv-user-bubble">
        <Markdown>{text}</Markdown>
      </div>
    </div>
  );
});

const MAX_AGENT_LINES = 60;

const AgentMessage = memo(function AgentMessage({ item }: { item: ThreadItem }) {
  const text = extractText(item);
  const [expanded, setExpanded] = useState(false);
  if (!text) {
    return null;
  }

  const lines = text.split('\n');
  const isTruncated = lines.length > MAX_AGENT_LINES && !expanded;
  const displayText = isTruncated ? lines.slice(0, MAX_AGENT_LINES).join('\n') : text;

  return (
    <div className="tv-agent-row">
      <div className="tv-agent-bubble tv-markdown-body">
        {item.phase && (
          <div style={{ marginBottom: 8 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '2px 8px',
                borderRadius: 999,
                fontSize: 11,
                color: 'var(--text-secondary)',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {item.phase === 'commentary' ? 'Commentary' : item.phase === 'final_answer' ? 'Final' : item.phase}
            </span>
          </div>
        )}
        <Markdown>{displayText}</Markdown>
        {isTruncated && (
          <button className="tv-expand-btn" onClick={() => setExpanded(true)}>
            展开全部 ({lines.length} 行)
          </button>
        )}
      </div>
    </div>
  );
});

const Reasoning = memo(function Reasoning({ item }: { item: ThreadItem }) {
  const [open, setOpen] = useState(false);
  const summaries = toSummaryList(item.summary);
  const content = toReasoningContent(item);
  const previewSource = summaries.join(' ').trim() || content.join(' ').trim();

  if (!previewSource) {
    return null;
  }

  const preview = previewSource.length > 96 ? `${previewSource.slice(0, 96)}...` : previewSource;

  return (
    <div className="tv-reasoning">
      <button className="tv-reasoning-toggle" onClick={() => setOpen((value) => !value)}>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="currentColor"
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
        >
          <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="tv-reasoning-label">Thinking</span>
        {!open && <span className="tv-reasoning-preview">{preview}</span>}
      </button>
      {open && (
        <div className="tv-reasoning-content">
          {summaries.length > 0 && (
            <div className="tv-markdown-body">
              <Markdown>{summaries.join('\n\n')}</Markdown>
            </div>
          )}
          {content.length > 0 && (
            <details className="tv-cmd-output" open={summaries.length === 0}>
              <summary className="tv-cmd-output-summary">Raw reasoning</summary>
              <pre className="tv-cmd-output-pre">{content.join('\n\n')}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
});

function TruncatedOutput({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split('\n');
  const truncated = lines.length > MAX_OUTPUT_LINES && !expanded;
  const displayText = truncated
    ? [...lines.slice(0, 20), `\n... ${lines.length - 40} lines hidden ...\n`, ...lines.slice(-20)].join('\n')
    : text;

  return (
    <>
      <pre className="tv-cmd-output-pre">{displayText}</pre>
      {truncated && (
        <button className="tv-cmd-expand" onClick={() => setExpanded(true)}>
          Show all {lines.length} lines
        </button>
      )}
    </>
  );
}

const CommandExecution = memo(function CommandExecution({ item }: { item: ThreadItem }) {
  const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
  const failed = item.exitCode != null && item.exitCode !== 0 || item.status === 'failed' || item.status === 'declined';
  const running = item.status === 'inProgress' || item.status === 'running';

  return (
    <div className={`tv-cmd${failed ? ' tv-cmd--failed' : ''}`}>
      <div className="tv-cmd-header">
        {running ? <span className="tv-cmd-spinner" /> : <span className="tv-cmd-prompt">$</span>}
        <code className="tv-cmd-text">{command || 'Command execution'}</code>
        {item.status && (
          <span className={`tv-cmd-exit ${failed ? 'tv-cmd-exit--fail' : 'tv-cmd-exit--ok'}`}>{item.status}</span>
        )}
        {item.durationMs != null && <span className="tv-cmd-duration">{(item.durationMs / 1000).toFixed(1)}s</span>}
      </div>
      {item.aggregatedOutput ? (
        <details className="tv-cmd-output" open={failed || running}>
          <summary className="tv-cmd-output-summary">Output ({item.aggregatedOutput.split('\n').length} lines)</summary>
          <TruncatedOutput text={item.aggregatedOutput} />
        </details>
      ) : running ? (
        <div className="tv-cmd-output" style={{ padding: '4px 12px', color: 'var(--text-tertiary)', fontSize: 12 }}>
          Running...
        </div>
      ) : null}
    </div>
  );
});

const DiffView = memo(function DiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.split('\n'), [diff]);
  let oldLine = 0;
  let newLine = 0;

  return (
    <div className="tv-diff-view">
      {lines.map((line, index) => {
        const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)/);
        if (hunkMatch) {
          oldLine = parseInt(hunkMatch[1], 10);
          newLine = parseInt(hunkMatch[2], 10);
          return (
            <div key={index} className="tv-diff-hunk">
              {line}
            </div>
          );
        }

        if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) {
          return (
            <div key={index} className="tv-diff-meta">
              {line}
            </div>
          );
        }

        let className = 'tv-diff-line';
        let oldNum = '';
        let newNum = '';

        if (line.startsWith('+')) {
          className += ' tv-diff-line--add';
          newNum = String(newLine++);
        } else if (line.startsWith('-')) {
          className += ' tv-diff-line--del';
          oldNum = String(oldLine++);
        } else {
          oldNum = String(oldLine++);
          newNum = String(newLine++);
        }

        return (
          <div key={index} className={className}>
            <span className="tv-diff-gutter-old">{oldNum}</span>
            <span className="tv-diff-gutter-new">{newNum}</span>
            <span className="tv-diff-sign">{line.charAt(0) || ' '}</span>
            <span className="tv-diff-code">{line.slice(1)}</span>
          </div>
        );
      })}
    </div>
  );
});

const FileChange = memo(function FileChange({ item }: { item: ThreadItem }) {
  const changes = item.changes ?? [];
  const additions = changes.reduce(
    (sum, change) => sum + (change.diff?.split('\n').filter((line) => line.startsWith('+')).length ?? 0),
    0,
  );
  const deletions = changes.reduce(
    (sum, change) => sum + (change.diff?.split('\n').filter((line) => line.startsWith('-')).length ?? 0),
    0,
  );

  return (
    <div className="tv-file-change">
      <div className="tv-file-change-header">
        <span className="tv-cmd-prompt">+</span>
        <span className="tv-file-change-count">{changes.length} file{changes.length !== 1 ? 's' : ''} changed</span>
        {additions > 0 && <span className="tv-file-stat tv-file-stat--add">+{additions}</span>}
        {deletions > 0 && <span className="tv-file-stat tv-file-stat--del">-{deletions}</span>}
        {item.status && <span className="tv-cmd-exit">{item.status}</span>}
      </div>
      {changes.map((change, index) => (
        <div key={`${change.path}-${index}`} className="tv-file-item">
          <details className="tv-file-details">
            <summary className="tv-file-summary">
              <span className={`tv-file-kind tv-file-kind--${change.kind}`}>
                {change.kind === 'create' ? '+' : change.kind === 'delete' ? '-' : '~'}
              </span>
              <span className="tv-file-path">{change.path}</span>
            </summary>
            {change.diff ? <DiffView diff={change.diff} /> : null}
          </details>
        </div>
      ))}
      {item.aggregatedOutput ? (
        <details className="tv-cmd-output">
          <summary className="tv-cmd-output-summary">Live diff stream</summary>
          <TruncatedOutput text={item.aggregatedOutput} />
        </details>
      ) : null}
    </div>
  );
});

const PlanItem = memo(function PlanItem({ item }: { item: ThreadItem }) {
  const text = extractText(item);
  if (!text) {
    return null;
  }

  return (
    <div className="tv-cmd">
      <div className="tv-cmd-header">
        <span className="tv-cmd-prompt">#</span>
        <code className="tv-cmd-text">Plan</code>
      </div>
      <div className="tv-cmd-output" style={{ borderTop: '1px solid var(--border-subtle)', padding: '8px 12px' }}>
        <div className="tv-markdown-body">
          <Markdown>{text}</Markdown>
        </div>
      </div>
    </div>
  );
});

const ToolCall = memo(function ToolCall({ item }: { item: ThreadItem }) {
  const label =
    item.type === 'mcpToolCall'
      ? `${item.server ?? 'mcp'} / ${item.tool ?? 'tool'}`
      : item.type === 'hook'
      ? item.tool ?? 'hook'
      : item.type === 'collabAgentToolCall'
      ? item.tool ?? 'collab'
      : item.type === 'rawResponseItem'
      ? item.tool ?? 'raw response item'
      : item.tool ?? item.type;
  const resultNode = renderToolResult(item);
  const argumentsText = stringifyJson(item.arguments);

  return (
    <div className="tv-cmd">
      <div className="tv-cmd-header">
        <span className="tv-cmd-prompt">@</span>
        <code className="tv-cmd-text">{label}</code>
        {item.status && <span className="tv-cmd-exit">{item.status}</span>}
        {item.durationMs != null && <span className="tv-cmd-duration">{(item.durationMs / 1000).toFixed(1)}s</span>}
      </div>
      {item.type === 'collabAgentToolCall' && (item.senderThreadId || (item.receiverThreadIds && item.receiverThreadIds.length > 0)) && (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '2px 12px' }}>
          {item.senderThreadId && <span>from: {item.senderThreadId}</span>}
          {item.receiverThreadIds && item.receiverThreadIds.length > 0 && <span> → {item.receiverThreadIds.join(', ')}</span>}
        </div>
      )}
      {argumentsText && (
        <details className="tv-cmd-output">
          <summary className="tv-cmd-output-summary">Arguments</summary>
          <pre className="tv-cmd-output-pre">{argumentsText}</pre>
        </details>
      )}
      {item.progressMessages && item.progressMessages.length > 0 && (
        <details className="tv-cmd-output" open>
          <summary className="tv-cmd-output-summary">Progress</summary>
          <pre className="tv-cmd-output-pre">{item.progressMessages.join('\n')}</pre>
        </details>
      )}
      {resultNode && (
        <details className="tv-cmd-output" open={item.status === 'failed'}>
          <summary className="tv-cmd-output-summary">{item.success === false ? 'Result (failed)' : 'Result'}</summary>
          <div style={{ overflow: 'auto' }}>{resultNode}</div>
        </details>
      )}
      {item.error?.message && (
        <div className="tv-error">
          <span>!</span>
          <span>{item.error.message}</span>
        </div>
      )}
    </div>
  );
});

function RealtimeAudioItem({ item }: { item: ThreadItem }) {
  const meta = getStructuredContent(item);
  const totalChunks = typeof meta?.totalChunks === 'number' ? meta.totalChunks : null;
  const totalBytes = typeof meta?.totalBytes === 'number' ? meta.totalBytes : null;
  const sampleRate = typeof meta?.sampleRate === 'number' ? meta.sampleRate : null;
  const numChannels = typeof meta?.numChannels === 'number' ? meta.numChannels : null;
  const samplesPerChannel =
    typeof meta?.samplesPerChannel === 'number' ? meta.samplesPerChannel : null;
  const itemId = typeof meta?.itemId === 'string' ? meta.itemId : null;
  const stats = [
    totalChunks != null ? `${totalChunks} chunk${totalChunks === 1 ? '' : 's'}` : null,
    sampleRate != null ? `${sampleRate} Hz` : null,
    numChannels != null ? `${numChannels} ch` : null,
    samplesPerChannel != null ? `${samplesPerChannel} samples/ch` : null,
    formatByteCount(totalBytes),
  ].filter((entry): entry is string => Boolean(entry));

  return (
    <div className="tv-cmd">
      <div className="tv-cmd-header">
        <span className="tv-cmd-prompt">~</span>
        <code className="tv-cmd-text">Realtime audio</code>
        {item.status && <span className="tv-cmd-exit">{item.status}</span>}
      </div>
      <div className="tv-cmd-output" style={{ borderTop: '1px solid var(--border-subtle)', padding: '8px 12px' }}>
        {item.text && (
          <div style={{ color: 'var(--text-primary)', fontSize: 13, marginBottom: stats.length > 0 || itemId ? 8 : 0 }}>
            {item.text}
          </div>
        )}
        {stats.length > 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: itemId ? 8 : 0 }}>
            {stats.map((entry) => (
              <span key={entry}>{entry}</span>
            ))}
          </div>
        )}
        {itemId && (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 12, fontFamily: 'var(--font-mono)', marginBottom: item.progressMessages?.length ? 8 : 0 }}>
            itemId: {itemId}
          </div>
        )}
        {item.progressMessages && item.progressMessages.length > 0 && (
          <details className="tv-cmd-output" open>
            <summary className="tv-cmd-output-summary">Chunks</summary>
            <pre className="tv-cmd-output-pre">{item.progressMessages.join('\n')}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function WebSearchItem({ item }: { item: ThreadItem }) {
  const detail = renderWebSearchAction(item);

  return (
    <div className="tv-cmd">
      <div className="tv-cmd-header">
        <span className="tv-cmd-prompt">?</span>
        <code className="tv-cmd-text">Web search</code>
        {item.status && <span className="tv-cmd-exit">{item.status}</span>}
      </div>
      <div className="tv-cmd-output" style={{ borderTop: '1px solid var(--border-subtle)', padding: '8px 12px' }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <div>
            <strong style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Query</strong>
            <div className="tv-markdown-body" style={{ fontSize: 13 }}>
              <Markdown>{item.query ?? 'No query'}</Markdown>
            </div>
          </div>
          {detail && (
            <div>
              <strong style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Action</strong>
              <div style={{ color: 'var(--text-primary)', fontSize: 13 }}>{detail}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ImageViewItem({ item }: { item: ThreadItem }) {
  return (
    <div className="tv-agent-row">
      <div className="tv-agent-bubble">
        {item.path ? (
          <>
            <img
              src={item.path}
              alt="Image view"
              style={{ maxWidth: '100%', maxHeight: 400, borderRadius: 8 }}
              onError={(event) => {
                (event.target as HTMLImageElement).style.display = 'none';
              }}
            />
            <div style={{ marginTop: 8, color: 'var(--text-tertiary)', fontSize: 12 }}>{item.path}</div>
          </>
        ) : (
          <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Image viewed</span>
        )}
      </div>
    </div>
  );
}

function ImageGenerationItem({ item }: { item: ThreadItem }) {
  return (
    <div className="tv-cmd">
      <div className="tv-cmd-header">
        <span className="tv-cmd-prompt">*</span>
        <code className="tv-cmd-text">Image generation</code>
        {item.status && <span className="tv-cmd-exit">{item.status}</span>}
      </div>
      <div className="tv-cmd-output" style={{ borderTop: '1px solid var(--border-subtle)', padding: '8px 12px' }}>
        {item.revisedPrompt && (
          <div style={{ marginBottom: 8 }}>
            <strong style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Prompt</strong>
            <div style={{ color: 'var(--text-primary)', fontSize: 13 }}>{item.revisedPrompt}</div>
          </div>
        )}
        {item.path ? (
          <>
            <img
              src={item.path}
              alt={item.revisedPrompt ?? 'Generated image'}
              style={{ maxWidth: '100%', maxHeight: 400, borderRadius: 8, display: 'block', marginBottom: 4 }}
              onError={(event) => { (event.target as HTMLImageElement).style.display = 'none'; }}
            />
            <div style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{item.path}</div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function TurnError({ message }: { message: string }) {
  return (
    <div className="tv-error">
      <span>!</span>
      <span>{message}</span>
    </div>
  );
}

function SystemInfo({ label }: { label: string }) {
  return (
    <div className="tv-system">
      <span className="tv-system-line" />
      <span className="tv-system-label">{label}</span>
      <span className="tv-system-line" />
    </div>
  );
}

function UnknownItem({ item }: { item: ThreadItem }) {
  const text = extractText(item);
  if (!text) {
    return null;
  }

  return (
    <div className="tv-agent-row">
      <div className="tv-agent-bubble tv-markdown-body">
        <Markdown>{text}</Markdown>
      </div>
    </div>
  );
}
