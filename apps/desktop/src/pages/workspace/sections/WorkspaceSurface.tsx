import type { ReactNode } from 'react';

export function WorkspaceSurface({
  title,
  description,
  action,
  className,
  icon,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`workspace-surface${className ? ` ${className}` : ''}`}>
      <div className="workspace-surface__header">
        <div className="workspace-surface__header-copy">
          {icon ? <span className="workspace-surface__icon">{icon}</span> : null}
          <div>
            <h3 className="workspace-surface__title">{title}</h3>
            <p className="workspace-surface__desc">{description}</p>
          </div>
        </div>
        {action ? <div className="workspace-surface__action">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
