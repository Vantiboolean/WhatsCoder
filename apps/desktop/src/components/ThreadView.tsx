import { Component, type ErrorInfo, type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import type { ThreadDetail, ThreadItem, Turn } from '@codex-mobile/shared';
import { summarizeDesktopDynamicTool } from '../lib/dynamicTools';

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
  isTurnsLoading?: boolean;
  hideHeader?: boolean;
  showRawJson?: boolean;
  onToggleRawJson?: () => void;
  overrideIsProcessing?: boolean;
  onResend?: (text: string) => void;
};

type ThreadListItem = {
  key: string;
  item: ThreadItem;
};

function createTurnErrorItem(turn: Turn): ThreadListItem | null {
  if (!turn.error?.message) {
    return null;
  }

  const parts: string[] = [turn.error.message];
  if (turn.error.additionalDetails) {
    parts.push(turn.error.additionalDetails);
  }
  if (turn.error.codexErrorInfo && Object.keys(turn.error.codexErrorInfo).length > 0) {
    parts.push(JSON.stringify(turn.error.codexErrorInfo, null, 2));
  }

  return {
    key: `${turn.id}-error`,
    item: {
      type: '_turnError',
      id: `${turn.id}-error`,
      text: parts.join('\n\n'),
    },
  };
}

function collectVisibleThreadItems(turns: Turn[] | undefined, maxVisible: number): {
  totalCount: number;
  items: ThreadListItem[];
} {
  if (!turns?.length) {
    return { totalCount: 0, items: [] };
  }

  let totalCount = 0;
  const items: ThreadListItem[] = [];

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = turns[turnIndex];
    const turnItems = turn.items ?? [];
    const turnErrorItem = createTurnErrorItem(turn);

    totalCount += turnItems.length;
    if (turnErrorItem) {
      totalCount += 1;
    }

    if (items.length >= maxVisible) {
      continue;
    }

    if (turnErrorItem && items.length < maxVisible) {
      items.push(turnErrorItem);
    }

    for (let itemIndex = turnItems.length - 1; itemIndex >= 0 && items.length < maxVisible; itemIndex--) {
      const item = turnItems[itemIndex];
      items.push({ key: item.id, item });
    }
  }

  items.reverse();
  return { totalCount, items };
}

export const ThreadView = memo(function ThreadView({
  thread,
  isSending,
  isAgentActive,
  isTurnsLoading,
  hideHeader,
  showRawJson,
  onToggleRawJson,
  overrideIsProcessing,
  onResend,
}: Props) {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const [visiblePages, setVisiblePages] = useState(INITIAL_PAGES);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const prevThreadIdRef = useRef<string | null>(null);
  const isInitialLoadRef = useRef(true);

  useEffect(() => {
    if (prevThreadIdRef.current !== thread.id) {
      setVisiblePages(INITIAL_PAGES);
      setShowScrollBtn(false);
      prevThreadIdRef.current = thread.id;
      isInitialLoadRef.current = true;
    }
  }, [thread.id]);

  const maxVisible = visiblePages * PAGE_SIZE;
  const { totalCount: totalItemCount, items: visibleItems } = useMemo(
    () => collectVisibleThreadItems(thread.turns, maxVisible),
    [thread.turns, maxVisible],
  );
  const hiddenCount = Math.max(0, totalItemCount - visibleItems.length);

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
  const rawJson = useMemo(
    () => (showRawJson ? JSON.stringify(thread, null, 2) : ''),
    [showRawJson, thread],
  );

  useEffect(() => {
    const container = messagesRef.current;
    if (!container || showRawJson) {
      setShowScrollBtn(false);
      return;
    }

    const updateScrollButton = () => {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      setShowScrollBtn((prev) => {
        const next = distFromBottom > 120;
        return prev === next ? prev : next;
      });
    };

    updateScrollButton();
    container.addEventListener('scroll', updateScrollButton, { passive: true });
    return () => container.removeEventListener('scroll', updateScrollButton);
  }, [showRawJson, thread.id]);

  useEffect(() => {
    if (isInitialLoadRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
      isInitialLoadRef.current = false;
      setShowScrollBtn(false);
      return;
    }

    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowScrollBtn(false);
  }, [totalItemCount, isProcessing]);

  return (
    <div className="tv-container">
      {!hideHeader && (
        <div className="tv-header">
          <div className="tv-header-left">
            <div className="tv-title">{thread.name || thread.preview || t('thread.untitledThread')}</div>
            <div className="tv-meta">
              {t('thread.metaSummary', { turns: thread.turns?.length ?? 0, items: totalItemCount })} ·{' '}
              {new Date((thread.updatedAt ?? thread.createdAt) * 1000).toLocaleString()}
              {isProcessing && <span className="tv-processing">{t('thread.processing')}</span>}
              {!isProcessing && isTurnsLoading && <span className="tv-processing">{t('thread.loadingMessages')}</span>}
            </div>
          </div>
        </div>
      )}

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
          {rawJson}
        </pre>
      ) : (
        <div className="tv-messages" ref={messagesRef}>
          {hiddenCount > 0 && (
            <button className="tv-load-more" onClick={handleLoadMore}>
              {t('thread.loadEarlierMessages', { count: Math.min(PAGE_SIZE, hiddenCount), hidden: hiddenCount })}
            </button>
          )}
          {visibleItems.length === 0 ? (
            isTurnsLoading ? (
              <>
                {[1, 2, 3].map((row) => (
                  <div key={row} className="skeleton-row">
                    <div className="skeleton-avatar" />
                    <div className="skeleton-block" style={{ flex: 1 }}>
                      <div className={`skeleton-line skeleton-line--${row === 1 ? 'long' : row === 2 ? 'medium' : 'short'}`} />
                      <div className="skeleton-line skeleton-line--long" />
                      <div className="skeleton-line skeleton-line--medium" />
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <div className="tv-empty">{t('thread.noMessages')}</div>
            )
          ) : (
            visibleItems.map(({ key, item }) => <ItemRenderer key={key} item={item} onResend={onResend} />)
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
      {!showRawJson && showScrollBtn && (
        <button
          className="scroll-to-bottom-btn"
          onClick={() => {
            const container = messagesRef.current;
            if (container) {
              container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
            }
          }}
          title={t('thread.scrollToBottom')}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <line x1="7" y1="2" x2="7" y2="12" />
            <polyline points="3,8 7,12 11,8" />
          </svg>
          {t('thread.jumpToBottom')}
        </button>
      )}
    </div>
  );
});

function CopyableCode({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useTranslation();
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

  const lang = className.replace('language-', '').split(' ')[0];

  return (
    <>
      <div className="tv-code-header">
        {lang && <span className="tv-code-lang">{lang}</span>}
        <button className={`tv-code-copy${copied ? ' tv-code-copy--done' : ''}`} onClick={handleCopy} title={t('thread.copyCode')}>
          {copied ? (
            <><svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="2,6 5,9 10,3" /></svg> {t('common.copied')}</>
          ) : (
            <><svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.5" /><path d="M8 4V2.5A1.5 1.5 0 0 0 6.5 1h-4A1.5 1.5 0 0 0 1 2.5v4A1.5 1.5 0 0 0 2.5 8H4" /></svg> {t('common.copy')}</>
          )}
        </button>
      </div>
      <code ref={codeRef} className={`tv-md-code ${className}`}>
        {children}
      </code>
    </>
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

function renderToolResult(item: ThreadItem, t: TFunction): ReactNode {
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
          <img key={`img-${nodes.length}`} src={entry.imageUrl} alt={t('thread.toolResult')} style={{ maxWidth: '100%', maxHeight: 400, borderRadius: 4, display: 'block', marginBottom: 4 }} />
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

const ItemRenderer = memo(function ItemRenderer({ item, onResend }: { item: ThreadItem; onResend?: (text: string) => void }) {
  const { t } = useTranslation();
  switch (item.type) {
    case 'userMessage':
      return <UserMessage item={item} onResend={onResend} />;
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
      return <SystemInfo label={t('thread.contextCompacted')} />;
    case 'enteredReviewMode':
      return (
        <SystemInfo
          label={item.review ? `${t('thread.enteredReviewMode')} · ${item.review}` : t('thread.enteredReviewMode')}
        />
      );
    case 'exitedReviewMode':
      return (
        <SystemInfo
          label={item.review ? `${t('thread.exitedReviewMode')} · ${item.review}` : t('thread.exitedReviewMode')}
        />
      );
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
      return <TurnError message={item.text ?? t('thread.unknownError')} />;
    default:
      return <UnknownItem item={item} />;
  }
});

const UserMessage = memo(function UserMessage({ item, onResend }: { item: ThreadItem; onResend?: (text: string) => void }) {
  const { t } = useTranslation();
  const text = extractContentText(item.content);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const handleEdit = () => {
    if (onResend) {
      onResend(text);
    }
  };

  if (!text) {
    return null;
  }

  return (
    <div className="tv-user-row">
      <div className="tv-user-wrap">
        <div className="tv-user-bubble">
          <Markdown>{text}</Markdown>
        </div>
        <div className="tv-user-actions">
          <button
            className={`tv-user-action-btn${copied ? ' tv-user-action-btn--done' : ''}`}
            onClick={handleCopy}
            title={copied ? t('common.copied') : t('common.copy')}
          >
            {copied ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="2,6 5,9 10,3" /></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.5" /><path d="M8 4V2.5A1.5 1.5 0 0 0 6.5 1h-4A1.5 1.5 0 0 0 1 2.5v4A1.5 1.5 0 0 0 2.5 8H4" /></svg>
            )}
            <span>{copied ? t('common.copied') : t('common.copy')}</span>
          </button>
          {onResend && (
            <button className="tv-user-action-btn" onClick={handleEdit} title={t('thread.editAndResend')}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8.5 1.5a1.414 1.414 0 0 1 2 2L3.5 10.5l-3 .5.5-3z" />
              </svg>
              <span>{t('common.edit')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

const MAX_AGENT_LINES = 60;

const AgentMessage = memo(function AgentMessage({ item }: { item: ThreadItem }) {
  const { t } = useTranslation();
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
        <Markdown>{displayText}</Markdown>
        {isTruncated && (
          <button className="tv-expand-btn" onClick={() => setExpanded(true)}>
            {t('thread.expandAll', { count: lines.length })}
          </button>
        )}
      </div>
    </div>
  );
});

const Reasoning = memo(function Reasoning({ item }: { item: ThreadItem }) {
  const { t } = useTranslation();
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
        <span className="tv-reasoning-label">{t('thread.thinking')}</span>
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
              <summary className="tv-cmd-output-summary">{t('thread.rawReasoning')}</summary>
              <pre className="tv-cmd-output-pre">{content.join('\n\n')}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
});

function TruncatedOutput({ text }: { text: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const lines = text.split('\n');
  const truncated = lines.length > MAX_OUTPUT_LINES && !expanded;
  const displayText = truncated
    ? [...lines.slice(0, 20), `\n${t('thread.linesHidden', { count: lines.length - 40 })}\n`, ...lines.slice(-20)].join('\n')
    : text;

  return (
    <>
      <pre className="tv-cmd-output-pre">{displayText}</pre>
      {truncated && (
        <button className="tv-cmd-expand" onClick={() => setExpanded(true)}>
          {t('thread.showAllLines', { count: lines.length })}
        </button>
      )}
    </>
  );
}

const CommandExecution = memo(function CommandExecution({ item }: { item: ThreadItem }) {
  const { t } = useTranslation();
  const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
  const failed = item.exitCode != null && item.exitCode !== 0 || item.status === 'failed' || item.status === 'declined';
  const running = item.status === 'inProgress' || item.status === 'running';
  const badge = statusBadge(t, item.status);

  return (
    <div className={`tv-cmd${failed ? ' tv-cmd--failed' : ''}${running ? ' tv-tool--running' : ''}`}>
      <div className="tv-cmd-header">
        {running ? <span className="tv-cmd-spinner" /> : <span className="tv-cmd-prompt">$</span>}
        <code className="tv-cmd-text">{command || t('thread.commandExecution')}</code>
        {badge && <span className={`tv-tool-status ${badge.className}`}>{badge.label}</span>}
        {item.exitCode != null && <span className={`tv-cmd-exit ${item.exitCode === 0 ? 'tv-cmd-exit--ok' : 'tv-cmd-exit--fail'}`}>exit {item.exitCode}</span>}
        {item.durationMs != null && <span className="tv-cmd-duration">{(item.durationMs / 1000).toFixed(1)}s</span>}
      </div>
      {item.aggregatedOutput ? (
        <details className="tv-cmd-output" open={failed || running}>
          <summary className="tv-cmd-output-summary">
            {t('thread.output', { count: item.aggregatedOutput.split('\n').length })}
          </summary>
          <TruncatedOutput text={item.aggregatedOutput} />
        </details>
      ) : running ? (
        <div className="tv-cmd-output" style={{ padding: '4px 12px', color: 'var(--text-tertiary)', fontSize: 12 }}>
          {t('thread.running')}
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
  const { t } = useTranslation();
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
        <span className="tv-file-change-count">{t('thread.filesChanged', { count: changes.length })}</span>
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
          <summary className="tv-cmd-output-summary">{t('thread.liveDiffStream')}</summary>
          <TruncatedOutput text={item.aggregatedOutput} />
        </details>
      ) : null}
    </div>
  );
});

const PlanItem = memo(function PlanItem({ item }: { item: ThreadItem }) {
  const { t } = useTranslation();
  const text = extractText(item);
  if (!text) {
    return null;
  }

  return (
    <div className="tv-cmd">
      <div className="tv-cmd-header">
        <span className="tv-cmd-prompt">#</span>
        <code className="tv-cmd-text">{t('thread.plan')}</code>
      </div>
      <div className="tv-cmd-output" style={{ borderTop: '1px solid var(--border-subtle)', padding: '8px 12px' }}>
        <div className="tv-markdown-body">
          <Markdown>{text}</Markdown>
        </div>
      </div>
    </div>
  );
});

function toolCallIcon(type: string): { icon: string; color: string; className: string } {
  switch (type) {
    case 'mcpToolCall':     return { icon: '⚡', color: 'var(--accent-mcp, #a78bfa)',     className: 'tv-tool-icon--mcp' };
    case 'hook':            return { icon: '⚙',  color: 'var(--accent-hook, #60a5fa)',    className: 'tv-tool-icon--hook' };
    case 'collabAgentToolCall': return { icon: '🤝', color: 'var(--accent-collab, #34d399)', className: 'tv-tool-icon--collab' };
    case 'dynamicToolCall': return { icon: '🔧', color: 'var(--accent-dynamic, #f59e0b)', className: 'tv-tool-icon--dynamic' };
    case 'rawResponseItem': return { icon: '📋', color: 'var(--text-tertiary)',            className: 'tv-tool-icon--raw' };
    default:                return { icon: '@',  color: 'var(--text-secondary)',           className: '' };
  }
}

function toolCallLabel(item: ThreadItem): { primary: string; secondary: string | null } {
  const summary = item.tool ? summarizeDesktopDynamicTool(item.tool, item.arguments) : null;

  if (item.type === 'mcpToolCall') {
    return { primary: item.tool ?? 'tool', secondary: item.server ?? 'mcp' };
  }
  if (item.type === 'hook') {
    const eventName = (item.arguments as Record<string, unknown> | undefined)?.eventName;
    return { primary: typeof eventName === 'string' ? eventName : item.tool ?? 'hook', secondary: 'hook' };
  }
  if (item.type === 'collabAgentToolCall') {
    return { primary: item.tool ?? 'agent call', secondary: 'collab' };
  }
  if (item.type === 'dynamicToolCall') {
    return {
      primary: summary?.title ?? item.tool ?? 'dynamic tool',
      secondary: summary?.subtitle ?? null,
    };
  }
  if (item.type === 'rawResponseItem') {
    return { primary: item.tool ?? 'response', secondary: null };
  }
  return { primary: item.tool ?? item.type, secondary: null };
}

function toolCallBadges(item: ThreadItem): string[] {
  if (!item.tool) {
    return [];
  }

  return summarizeDesktopDynamicTool(item.tool, item.arguments)?.badges ?? [];
}

function statusBadge(t: TFunction, status: string | undefined): { label: string; className: string } | null {
  if (!status) return null;
  switch (status) {
    case 'completed':   return { label: t('thread.done'),            className: 'tv-status--ok' };
    case 'inProgress':  return { label: t('thread.statusRunning'),   className: 'tv-status--active' };
    case 'running':     return { label: t('thread.statusRunning'),   className: 'tv-status--active' };
    case 'streaming':   return { label: t('thread.statusStreaming'), className: 'tv-status--active' };
    case 'failed':      return { label: t('thread.failed'),          className: 'tv-status--fail' };
    case 'declined':    return { label: t('thread.declined'),        className: 'tv-status--warn' };
    case 'blocked':     return { label: t('thread.blocked'),         className: 'tv-status--warn' };
    case 'stopped':     return { label: t('thread.stopped'),        className: 'tv-status--warn' };
    default:            return { label: status,                      className: 'tv-status--default' };
  }
}

const ToolCall = memo(function ToolCall({ item }: { item: ThreadItem }) {
  const { t } = useTranslation();
  const { icon, color, className: iconClass } = toolCallIcon(item.type);
  const { primary, secondary } = toolCallLabel(item);
  const badges = toolCallBadges(item);
  const badge = statusBadge(t, item.status);
  const resultNode = renderToolResult(item, t);
  const argumentsText = stringifyJson(item.arguments);
  const isRunning = item.status === 'inProgress' || item.status === 'running' || item.status === 'streaming';
  const isFailed = item.status === 'failed' || item.success === false;

  return (
    <div className={`tv-tool${isFailed ? ' tv-tool--failed' : ''}${isRunning ? ' tv-tool--running' : ''}`}>
      <div className="tv-tool-header">
        <span className={`tv-tool-icon ${iconClass}`} style={{ color }}>{icon}</span>
        <div className="tv-tool-label">
          <div className="tv-tool-text">
            <code className="tv-tool-name">{primary}</code>
            {secondary && <span className="tv-tool-subtitle" title={secondary}>{secondary}</span>}
          </div>
        </div>
        <div className="tv-tool-meta">
          {badge && <span className={`tv-tool-status ${badge.className}`}>{badge.label}</span>}
          {item.durationMs != null && <span className="tv-tool-duration">{(item.durationMs / 1000).toFixed(1)}s</span>}
        </div>
      </div>
      {badges.length > 0 && (
        <div className="tv-tool-badges">
          {badges.map((entry) => (
            <span key={entry} className="tv-tool-badge">{entry}</span>
          ))}
        </div>
      )}
      {item.type === 'collabAgentToolCall' && (item.senderThreadId || (item.receiverThreadIds && item.receiverThreadIds.length > 0)) && (
        <div className="tv-tool-collab-info">
          {item.senderThreadId && <span>↗ from: <code>{item.senderThreadId}</code></span>}
          {item.receiverThreadIds && item.receiverThreadIds.length > 0 && <span>↘ to: <code>{item.receiverThreadIds.join(', ')}</code></span>}
        </div>
      )}
      {item.type === 'hook' && item.arguments != null && (() => {
        const args = item.arguments as Record<string, unknown>;
        const handlerType = typeof args.handlerType === 'string' ? args.handlerType : null;
        const scope = typeof args.scope === 'string' ? args.scope : null;
        const sourcePath = typeof args.sourcePath === 'string' ? args.sourcePath : null;
        if (!handlerType && !scope && !sourcePath) return null;
        return (
          <div className="tv-tool-hook-info">
            {handlerType && <span className="tv-tool-tag">{handlerType}</span>}
            {scope && <span className="tv-tool-tag">{scope}</span>}
            {sourcePath && <code className="tv-tool-path">{sourcePath}</code>}
          </div>
        );
      })()}
      {argumentsText && item.type !== 'hook' && (
        <details className="tv-tool-section">
          <summary className="tv-tool-section-header">{t('thread.arguments')}</summary>
          <pre className="tv-cmd-output-pre">{argumentsText}</pre>
        </details>
      )}
      {item.progressMessages && item.progressMessages.length > 0 && (
        <details className="tv-tool-section" open={isRunning}>
          <summary className="tv-tool-section-header">
            {isRunning ? t('thread.progress') : `${t('thread.progress')} (${item.progressMessages.length})`}
          </summary>
          <pre className="tv-cmd-output-pre">{item.progressMessages.join('\n')}</pre>
        </details>
      )}
      {resultNode && (
        <details className="tv-tool-section" open={isFailed || isRunning}>
          <summary className="tv-tool-section-header">{isFailed ? t('thread.resultFailed') : t('thread.result')}</summary>
          <div style={{ overflow: 'auto' }}>{resultNode}</div>
        </details>
      )}
      {item.error?.message && (
        <div className="tv-tool-error">
          <span className="tv-tool-error-icon">!</span>
          <span>{item.error.message}</span>
        </div>
      )}
    </div>
  );
});

function RealtimeAudioItem({ item }: { item: ThreadItem }) {
  const { t } = useTranslation();
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
        <code className="tv-cmd-text">{t('thread.realtimeAudio')}</code>
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
            <summary className="tv-cmd-output-summary">{t('thread.chunks')}</summary>
            <pre className="tv-cmd-output-pre">{item.progressMessages.join('\n')}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function WebSearchItem({ item }: { item: ThreadItem }) {
  const { t } = useTranslation();
  const detail = renderWebSearchAction(item);
  const badge = statusBadge(t, item.status);
  const actionType = item.action?.type;
  const actionIcon = actionType === 'search' ? '🔍' : actionType === 'open_page' ? '🌐' : actionType === 'find_in_page' ? '📄' : '🔍';

  return (
    <div className="tv-tool">
      <div className="tv-tool-header">
        <span className="tv-tool-icon" style={{ color: 'var(--accent-blue, #60a5fa)' }}>{actionIcon}</span>
        <div className="tv-tool-label">
          <code className="tv-tool-name">
            {actionType === 'search'
              ? t('thread.webSearch')
              : actionType === 'open_page'
                ? t('thread.openPage')
                : actionType === 'find_in_page'
                  ? t('thread.findInPage')
                  : t('thread.webSearch')}
          </code>
        </div>
        <div className="tv-tool-meta">
          {badge && <span className={`tv-tool-status ${badge.className}`}>{badge.label}</span>}
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '8px 12px' }}>
        {item.query && (
          <div style={{ marginBottom: detail ? 8 : 0 }}>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>{t('thread.query')}</div>
            <div className="tv-markdown-body" style={{ fontSize: 13 }}>
              <Markdown>{item.query}</Markdown>
            </div>
          </div>
        )}
        {detail && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>{t('thread.result')}</div>
            <div style={{ color: 'var(--text-primary)', fontSize: 13, fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{detail}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function ImageViewItem({ item }: { item: ThreadItem }) {
  const { t } = useTranslation();
  return (
    <div className="tv-agent-row">
      <div className="tv-agent-bubble">
        {item.path ? (
          <>
            <img
              src={item.path}
              alt={t('thread.imageViewAlt')}
              style={{ maxWidth: '100%', maxHeight: 400, borderRadius: 8 }}
              onError={(event) => {
                (event.target as HTMLImageElement).style.display = 'none';
              }}
            />
            <div style={{ marginTop: 8, color: 'var(--text-tertiary)', fontSize: 12 }}>{item.path}</div>
          </>
        ) : (
          <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('thread.imageViewed')}</span>
        )}
      </div>
    </div>
  );
}

function ImageGenerationItem({ item }: { item: ThreadItem }) {
  const { t } = useTranslation();
  return (
    <div className="tv-cmd">
      <div className="tv-cmd-header">
        <span className="tv-cmd-prompt">*</span>
        <code className="tv-cmd-text">{t('thread.imageGeneration')}</code>
        {item.status && <span className="tv-cmd-exit">{item.status}</span>}
      </div>
      <div className="tv-cmd-output" style={{ borderTop: '1px solid var(--border-subtle)', padding: '8px 12px' }}>
        {item.revisedPrompt && (
          <div style={{ marginBottom: 8 }}>
            <strong style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{t('thread.prompt')}</strong>
            <div style={{ color: 'var(--text-primary)', fontSize: 13 }}>{item.revisedPrompt}</div>
          </div>
        )}
        {item.path ? (
          <>
            <img
              src={item.path}
              alt={item.revisedPrompt ?? t('thread.generatedImage')}
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
