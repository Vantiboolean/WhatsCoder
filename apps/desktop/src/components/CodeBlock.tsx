import { useState, useEffect, useRef, useCallback } from 'react';
import { highlightCode, type ShikiTheme } from '../lib/shikiHighlighter';

interface CodeBlockProps {
  code: string;
  language?: string;
  theme?: ShikiTheme;
  showLineNumbers?: boolean;
  className?: string;
}

export function CodeBlock({
  code,
  language = 'text',
  theme = 'github-dark',
  showLineNumbers = false,
  className,
}: CodeBlockProps) {
  const [html, setHtml] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let cancelled = false;
    highlightCode(code, language, theme).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => { cancelled = true; };
  }, [code, language, theme]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }, [code]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <div className={`code-block${className ? ` ${className}` : ''}`}>
      <div className="code-block-header">
        <span className="code-block-lang">{language}</span>
        <button className="code-block-copy" onClick={handleCopy} title="Copy code">
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 8 7 11 12 5" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M5 11H4a1.5 1.5 0 01-1.5-1.5v-6A1.5 1.5 0 014 2h6A1.5 1.5 0 0111.5 3.5V5" />
            </svg>
          )}
        </button>
      </div>
      {html ? (
        <div
          className={`code-block-body${showLineNumbers ? ' code-block-body--numbered' : ''}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="code-block-body code-block-fallback">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
