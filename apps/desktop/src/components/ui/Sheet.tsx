import { useEffect, useRef, type ReactNode } from 'react';

type SheetSide = 'left' | 'right' | 'bottom';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  side?: SheetSide;
  title?: string;
  children: ReactNode;
  className?: string;
}

export function Sheet({ open, onClose, side = 'right', title, children, className }: SheetProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="ui-sheet-overlay" ref={overlayRef} onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}>
      <div className={`ui-sheet ui-sheet--${side}${className ? ` ${className}` : ''}`}>
        {title && (
          <div className="ui-sheet-header">
            <h2 className="ui-sheet-title">{title}</h2>
            <button className="ui-sheet-close" onClick={onClose} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="3" y1="3" x2="11" y2="11" /><line x1="11" y1="3" x2="3" y2="11" />
              </svg>
            </button>
          </div>
        )}
        <div className="ui-sheet-content">{children}</div>
      </div>
    </div>
  );
}
