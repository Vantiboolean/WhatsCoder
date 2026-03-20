import { memo, useCallback, useRef } from 'react';
import { GitPanel } from './GitPanel';
import { FileExplorer } from './FileExplorer';
import { PromptsPanel } from './PromptsPanel';
import type { OverlayView } from './CodeViewer';

export type RightSidebarTab = 'git' | 'files' | 'prompts';

export const RightSidebar = memo(function RightSidebar({
  cwd,
  activeTab,
  onTabChange,
  onOverlayView,
  onInsertPrompt,
  width,
  onWidthChange,
}: {
  cwd: string | null;
  activeTab: RightSidebarTab;
  onTabChange: (tab: RightSidebarTab) => void;
  onOverlayView: (view: OverlayView) => void;
  onInsertPrompt: (text: string) => void;
  width: number;
  onWidthChange: (w: number) => void;
}) {
  const resizing = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = width;
    const onMouseMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const delta = resizeStartX.current - ev.clientX;
      onWidthChange(Math.min(Math.max(resizeStartWidth.current + delta, 240), 600));
    };
    const onMouseUp = () => {
      resizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [width, onWidthChange]);

  return (
    <aside className="right-sidebar" style={{ width }}>
      <div className="rs-resize-handle" onMouseDown={handleResizeStart} />
      <div className="rs-tabs">
        <button
          className={`rs-tab${activeTab === 'git' ? ' rs-tab--active' : ''}`}
          onClick={() => onTabChange('git')}
          title="Git"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="5" cy="4" r="2" />
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="6" r="2" />
            <path d="M5 6v4M10 6c-2 0-5 1-5 4" />
          </svg>
          <span>Git</span>
        </button>
        <button
          className={`rs-tab${activeTab === 'files' ? ' rs-tab--active' : ''}`}
          onClick={() => onTabChange('files')}
          title="Files"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
          </svg>
          <span>Files</span>
        </button>
        <button
          className={`rs-tab${activeTab === 'prompts' ? ' rs-tab--active' : ''}`}
          onClick={() => onTabChange('prompts')}
          title="Prompts"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 1.5h5l4 4V13a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 13V3A1.5 1.5 0 014 1.5z" />
            <path d="M9 1.5v4h4" />
            <line x1="5.5" y1="8.5" x2="10.5" y2="8.5" />
            <line x1="5.5" y1="11" x2="9" y2="11" />
          </svg>
          <span>Prompts</span>
        </button>
      </div>
      <div className="rs-content">
        {activeTab === 'git' && (
          <GitPanel cwd={cwd} onOverlayView={onOverlayView} />
        )}
        {activeTab === 'files' && (
          <FileExplorer cwd={cwd} onOverlayView={onOverlayView} />
        )}
        {activeTab === 'prompts' && (
          <PromptsPanel cwd={cwd} onInsertPrompt={onInsertPrompt} />
        )}
      </div>
    </aside>
  );
});
