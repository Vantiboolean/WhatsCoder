import React, { useEffect, useRef, useState, useCallback } from 'react';
import hljs from 'highlight.js';
import { invoke } from '@tauri-apps/api/core';

export type OverlayView = {
  type: 'diff' | 'file';
  title: string;
  content: string;
  language?: string;
  path?: string;
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

function FileEditor({
  content,
  onChange,
}: {
  content: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="cv-file-content cv-file-editor">
      <textarea
        className="cv-editor-textarea"
        value={content}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
    </div>
  );
}

export function CodeViewer({
  overlay,
  onClose,
  extraToolbarRight,
}: {
  overlay: NonNullable<OverlayView>;
  onClose: () => void;
  extraToolbarRight?: React.ReactNode;
}) {
  const lang = overlay.language ?? getLanguageFromPath(overlay.title);
  const canEdit = overlay.type === 'file' && Boolean(overlay.path);

  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(overlay.content);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');

  // Reset edit state when overlay changes
  useEffect(() => {
    setIsEditing(false);
    setEditContent(overlay.content);
    setSaveState('idle');
    setSaveError('');
  }, [overlay.path, overlay.title]);

  const handleEdit = useCallback(() => {
    setEditContent(overlay.content);
    setIsEditing(true);
    setSaveState('idle');
    setSaveError('');
  }, [overlay.content]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setSaveState('idle');
    setSaveError('');
  }, []);

  const handleSave = useCallback(async () => {
    if (!overlay.path) return;
    setSaveState('saving');
    setSaveError('');
    try {
      await invoke('write_file_content', { path: overlay.path, content: editContent });
      setSaveState('idle');
      setIsEditing(false);
    } catch (e) {
      setSaveState('error');
      setSaveError(String(e));
    }
  }, [overlay.path, editContent]);

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
          <span className="cv-type-badge cv-type-badge--mode">
            {isEditing ? 'EDITING' : (overlay.type === 'diff' ? 'DIFF' : lang.toUpperCase())}
          </span>
        </div>
        <div className="cv-toolbar-center">
          {saveState === 'error' && (
            <span className="cv-save-error" title={saveError}>保存失败</span>
          )}
        </div>
        <div className="cv-toolbar-right">
          {canEdit && !isEditing && (
            <button className="cv-edit-btn" onClick={handleEdit} title="Edit file">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.5 2.5a1.414 1.414 0 012 2L5 13H2v-3L11.5 2.5z" />
              </svg>
              <span>编辑</span>
            </button>
          )}
          {isEditing && (
            <>
              <button className="cv-save-btn" onClick={handleSave} disabled={saveState === 'saving'} title="Save file">
                {saveState === 'saving' ? (
                  <span>保存中…</span>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13 11v2.5A1.5 1.5 0 0111.5 15h-7A1.5 1.5 0 013 13.5V11" />
                      <path d="M8 1v8M5 6l3 3 3-3" />
                    </svg>
                    <span>保存</span>
                  </>
                )}
              </button>
              <button className="cv-cancel-btn" onClick={handleCancel} title="Cancel editing">
                <span>取消</span>
              </button>
            </>
          )}
          {extraToolbarRight}
        </div>
      </div>
      <div className="cv-body-row">
        <div className="cv-body">
          {overlay.type === 'diff' ? (
            <DiffViewer content={overlay.content} />
          ) : isEditing ? (
            <FileEditor content={editContent} onChange={setEditContent} />
          ) : (
            <FileViewer content={overlay.content} language={lang} />
          )}
        </div>
      </div>
    </div>
  );
}
