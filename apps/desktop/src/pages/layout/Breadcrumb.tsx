import type { ReactNode } from 'react';

export interface BreadcrumbSegment {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
}

interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
  className?: string;
}

export function Breadcrumb({ segments, className }: BreadcrumbProps) {
  if (segments.length === 0) return null;

  return (
    <nav className={`breadcrumb${className ? ` ${className}` : ''}`} aria-label="Breadcrumb">
      <ol className="breadcrumb-list">
        {segments.map((seg, i) => (
          <li key={i} className="breadcrumb-item">
            {i > 0 && (
              <svg className="breadcrumb-separator" width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M2.5 1.5L5.5 4L2.5 6.5" />
              </svg>
            )}
            {seg.onClick ? (
              <button
                className={`breadcrumb-segment breadcrumb-segment--clickable${i === segments.length - 1 ? ' breadcrumb-segment--active' : ''}`}
                onClick={seg.onClick}
              >
                {seg.icon && <span className="breadcrumb-icon">{seg.icon}</span>}
                <span>{seg.label}</span>
              </button>
            ) : (
              <span className={`breadcrumb-segment${i === segments.length - 1 ? ' breadcrumb-segment--active' : ''}`}>
                {seg.icon && <span className="breadcrumb-icon">{seg.icon}</span>}
                <span>{seg.label}</span>
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
