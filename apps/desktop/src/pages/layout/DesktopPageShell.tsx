import type { CSSProperties, ReactNode } from 'react';

type DesktopPageShellProps = {
  title?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  windowControls?: ReactNode;
  segments?: unknown;
  eyebrow?: ReactNode;
  description?: ReactNode;
};

type DesktopEmptyStateProps = {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function DesktopPageShell({
  title,
  actions,
  toolbar,
  children,
  className,
  bodyClassName,
  windowControls,
}: DesktopPageShellProps) {
  return (
    <section className={`desktop-page-shell${className ? ` ${className}` : ''}`}>
      <header className="desktop-page-shell__header" data-tauri-drag-region>
        <div className="desktop-page-shell__header-left" data-tauri-drag-region>
          {title ? <span className="desktop-page-shell__header-title">{title}</span> : null}
          {actions ? <div className="desktop-page-shell__actions" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>{actions}</div> : null}
        </div>
        <div className="desktop-page-shell__header-drag" data-tauri-drag-region />
        {windowControls ? (
          <div className="desktop-page-shell__header-controls">
            {windowControls}
          </div>
        ) : null}
      </header>
      {toolbar ? <div className="desktop-page-shell__toolbar">{toolbar}</div> : null}
      <div className={`desktop-page-shell__body${bodyClassName ? ` ${bodyClassName}` : ''}`}>
        {children}
      </div>
    </section>
  );
}

export function DesktopEmptyState({
  icon,
  title,
  description,
  actions,
  className,
}: DesktopEmptyStateProps) {
  return (
    <div className={`desktop-empty-state${className ? ` ${className}` : ''}`}>
      {icon ? <div className="desktop-empty-state__icon">{icon}</div> : null}
      <div className="desktop-empty-state__content">
        <h3 className="desktop-empty-state__title">{title}</h3>
        {description ? (
          <p className="desktop-empty-state__description">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="desktop-empty-state__actions">{actions}</div> : null}
    </div>
  );
}
