import React, { useEffect, useRef } from 'react';
import hljs from 'highlight.js';

export type OverlayView = {
  type: 'diff' | 'file';
  title: string;
  content: string;
  language?: string;
} | null;

function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby',
    css: 'css', scss: 'scss', html: 'html', json: 'json', yaml: 'yaml',
    yml: 'yaml', md: 'markdown', sql: 'sql', sh: 'bash', bash: 'bash',
    toml: 'toml', xml: 'xml', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin',
  };
  return map[ext] || 'plaintext';
}

function DiffViewer({ content }: { content: string }) {
  return (
    <div className="cv-diff-content">
      {content.split('\n').map((line, i) => {
        let cls = 'cv-diff-line';
        if (line.startsWith('+') && !line.startsWith('+++')) cls += ' cv-diff-added';
        else if (line.startsWith('-') && !line.startsWith('---')) cls += ' cv-diff-removed';
        else if (line.startsWith('@@')) cls += ' cv-diff-hunk';
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls += ' cv-diff-meta';
        return (
          <div key={i} className={cls}>
            <span className="cv-diff-line-num">{i + 1}</span>
            <span className="cv-diff-line-text">{line || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

function FileViewer({ content, language }: { content: string; language: string }) {
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.removeAttribute('data-highlighted');
      try { hljs.highlightElement(codeRef.current); } catch { /* ignore */ }
    }
  }, [content, language]);

  return (
    <div className="cv-file-content">
      <pre>
        <code ref={codeRef} className={`language-${language}`}>
          {content}
        </code>
      </pre>
    </div>
  );
}

export function CodeViewer({
  overlay,
  onClose,
  extraToolbarRight,
  sidebar,
}: {
  overlay: OverlayView;
  onClose: () => void;
  extraToolbarRight?: React.ReactNode;
  sidebar?: React.ReactNode;
}) {
  if (!overlay) return null;

  const lang = overlay.language || getLanguageFromPath(overlay.title);

  return (
    <div className="cv-container">
      <div className="cv-toolbar" data-tauri-drag-region>
        <div className="cv-toolbar-left">
          <button className="cv-back-btn" onClick={onClose} title="Back to chat">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
          <span className="cv-filename">{overlay.title}</span>
          <span className="cv-type-badge">{overlay.type === 'diff' ? 'DIFF' : lang.toUpperCase()}</span>
        </div>
        {extraToolbarRight && (
          <div className="cv-toolbar-right">{extraToolbarRight}</div>
        )}
      </div>
      <div className="cv-body-row">
        <div className="cv-body">
          {overlay.type === 'diff' ? (
            <DiffViewer content={overlay.content} />
          ) : (
            <FileViewer content={overlay.content} language={lang} />
          )}
        </div>
        {sidebar}
      </div>
    </div>
  );
}
