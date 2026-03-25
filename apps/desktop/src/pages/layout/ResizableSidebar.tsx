import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';

interface ResizableSidebarProps {
  children: ReactNode;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  storageKey?: string;
  side?: 'left' | 'right';
  onWidthChange?: (width: number) => void;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

function loadPersistedWidth(key: string, fallback: number): number {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch { /* ignore */ }
  return fallback;
}

export function ResizableSidebar({
  children,
  defaultWidth = 280,
  minWidth = 200,
  maxWidth = 480,
  storageKey = 'codex-sidebar-width',
  side = 'left',
  onWidthChange,
  collapsed,
  onCollapsedChange,
}: ResizableSidebarProps) {
  const [width, setWidth] = useState(() => loadPersistedWidth(storageKey, defaultWidth));
  const resizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const effectiveWidth = collapsed ? 0 : width;

  const updateWidth = useCallback((newWidth: number) => {
    const clamped = Math.min(Math.max(newWidth, minWidth), maxWidth);
    setWidth(clamped);
    onWidthChange?.(clamped);
    try { localStorage.setItem(storageKey, String(clamped)); } catch { /* ignore */ }
  }, [minWidth, maxWidth, storageKey, onWidthChange]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const delta = side === 'left'
        ? ev.clientX - startX.current
        : startX.current - ev.clientX;
      updateWidth(startWidth.current + delta);
    };

    const onMouseUp = () => {
      resizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [width, side, updateWidth]);

  const handleDoubleClick = useCallback(() => {
    updateWidth(defaultWidth);
  }, [defaultWidth, updateWidth]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        onCollapsedChange?.(!collapsed);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [collapsed, onCollapsedChange]);

  return (
    <div
      ref={sidebarRef}
      className={`resizable-sidebar resizable-sidebar--${side}${collapsed ? ' resizable-sidebar--collapsed' : ''}`}
      style={{ width: effectiveWidth, minWidth: collapsed ? 0 : minWidth }}
    >
      {!collapsed && children}
      <div
        className={`resize-handle resize-handle--${side}`}
        onMouseDown={handleResizeStart}
        onDoubleClick={handleDoubleClick}
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        tabIndex={0}
      />
    </div>
  );
}
