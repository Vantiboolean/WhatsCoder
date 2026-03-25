import { useState, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { SkillDetail } from '../lib/settingsHelpers';
import { DesktopEmptyState, DesktopPageShell } from './DesktopPageShell';

export type { SkillDetail };

export function SkillsView({ skills, onRefresh, windowControls }: { skills: SkillDetail[]; onRefresh?: () => void; windowControls?: ReactNode }) {
  const [search, setSearch] = useState('');
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  const filtered = search
    ? skills.filter(s => {
        const q = search.toLowerCase();
        return s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q) || (s.description?.toLowerCase().includes(q));
      })
    : skills;

  const grouped = useMemo(() => {
    const groups = new Map<string, SkillDetail[]>();
    for (const s of filtered) {
      const parts = s.path.replace(/\\/g, '/').split('/');
      const project = parts.length > 2 ? parts[parts.length - 3] : parts[0] || 'Project';
      if (!groups.has(project)) groups.set(project, []);
      groups.get(project)!.push(s);
    }
    return Array.from(groups.entries());
  }, [filtered]);

  return (
    <DesktopPageShell
      className="skills-panel"
      title="Skills"
      windowControls={windowControls}
      toolbar={(
        <div className="providers-toolbar providers-toolbar--spread">
          <div className="history-toolbar-search">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="7" cy="7" r="5" /><path d="M11 11l3.5 3.5" />
            </svg>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search skills..." />
            {search && (
              <button className="history-search-clear" onClick={() => setSearch('')}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
                </svg>
              </button>
            )}
          </div>
          {onRefresh && (
            <button className="providers-toolbar-btn" onClick={onRefresh}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 7a5.5 5.5 0 0 1 9.3-4" /><path d="M12.5 7a5.5 5.5 0 0 1-9.3 4" />
                <polyline points="11,1 11,4 8,4" /><polyline points="3,13 3,10 6,10" />
              </svg>
              Refresh
            </button>
          )}
        </div>
      )}
    >
      <div className="desktop-page-surface desktop-page-surface--scroll">
        <div className="providers-list">
          {filtered.length === 0 ? (
            <DesktopEmptyState
              icon={(
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="6" width="12" height="12" rx="3" /><rect x="22" y="6" width="12" height="12" rx="3" />
                  <rect x="6" y="22" width="12" height="12" rx="3" /><rect x="22" y="22" width="12" height="12" rx="3" />
                </svg>
              )}
              title={search ? 'No matching skills' : 'No skills found'}
              description={search ? 'Try a different search term.' : 'Create a SKILL.md in your project to surface reusable workflows here.'}
            />
          ) : (
            grouped.map(([project, items]) => (
              <div key={project} className="skills-group">
                <div className="skills-group-header">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
                  </svg>
                  <span>{project}</span>
                  <span className="skills-group-count">{items.length}</span>
                </div>
                {items.map((s, i) => {
                  const isExpanded = expandedSkill === `${project}-${i}`;
                  return (
                    <div
                      key={i}
                      className={`provider-card skill-provider-card${isExpanded ? ' provider-card--active' : ''}`}
                      onClick={() => setExpandedSkill(isExpanded ? null : `${project}-${i}`)}
                      style={{ cursor: 'pointer', flexDirection: 'column', alignItems: 'stretch' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div className="provider-card-icon" style={{ background: 'var(--accent-green-muted)', border: 'none' }}>
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--accent-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" />
                          </svg>
                        </div>
                        <div className="provider-card-info">
                          <div className="provider-card-name">{s.name}</div>
                          {s.description && !isExpanded && <div className="provider-card-url">{s.description}</div>}
                        </div>
                        {s.tags && s.tags.length > 0 && (
                          <span className="provider-card-badge">{s.tags[0]}</span>
                        )}
                        <svg className={`skill-card-chevron${isExpanded ? ' skill-card-chevron--open' : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 1.5l4 3.5-4 3.5" />
                        </svg>
                      </div>
                      {isExpanded && (
                        <div className="skill-card-detail">
                          <div className="skill-detail-row"><span className="skill-detail-label">Path</span><span className="skill-detail-value mono">{s.path}</span></div>
                          {s.description && <div className="skill-detail-row"><span className="skill-detail-label">Description</span><span className="skill-detail-value">{s.description}</span></div>}
                          {s.tags && s.tags.length > 0 && (
                            <div className="skill-detail-row"><span className="skill-detail-label">Tags</span><div className="skill-tags">{s.tags.map((t, ti) => <span key={ti} className="skill-tag">{t}</span>)}</div></div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </DesktopPageShell>
  );
}
