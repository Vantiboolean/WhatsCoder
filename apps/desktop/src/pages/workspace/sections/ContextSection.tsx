import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { previewWorkspaceText } from '../../../lib/workspace/workspaceSummary';
import type { WorkspaceContextItemRecord, WorkspaceContextKind } from '../../../lib/workspace/types';
import type { UseWorkspaceControllerResult } from '../../../lib/workspace/workspaceController';
import { WorkspaceSurface } from './WorkspaceSurface';

const CONTEXT_KIND_ORDER: WorkspaceContextKind[] = [
  'note',
  'image_ref',
  'prompt_ref',
  'file_ref',
  'thread_ref',
  'run_summary',
];

export function ContextSection({
  controller,
}: {
  controller: UseWorkspaceControllerResult;
}) {
  const { t } = useTranslation();
  const bundle = controller.bundle;

  const sortedItems = useMemo(
    () => (bundle?.contextItems ?? []).slice().sort((left, right) => left.sortOrder - right.sortOrder),
    [bundle?.contextItems],
  );

  if (!bundle) {
    return <div className="workspace-empty-hint">{t('workspacePage.noProjectsHint')}</div>;
  }

  const addContextItem = async (kind: WorkspaceContextKind) => {
    await controller.saveContextItem({
      kind,
      title: '',
      content: '',
      ref: null,
      source: null,
      sortOrder: sortedItems.length,
    });
  };

  const moveItem = async (itemId: string, direction: -1 | 1) => {
    const index = sortedItems.findIndex((item) => item.id === itemId);
    if (index < 0) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= sortedItems.length) return;
    const next = sortedItems.slice();
    const [item] = next.splice(index, 1);
    next.splice(targetIndex, 0, item);
    await controller.saveContextOrdering(next);
  };

  const prompts = [
    ...(controller.promptLibrary?.workspace ?? []).map((prompt) => ({ ...prompt, source: 'workspace' })),
    ...(controller.promptLibrary?.general ?? []).map((prompt) => ({ ...prompt, source: 'general' })),
  ];

  return (
    <div className="workspace-page-grid">
      <WorkspaceSurface
        title={t('workspacePage.contextItemsTitle')}
        description={t('workspacePage.contextItemsDesc')}
        className="workspace-surface--wide"
        icon={(
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 2.5h10a1 1 0 011 1v9a1 1 0 01-1 1H3a1 1 0 01-1-1v-9a1 1 0 011-1z" />
            <path d="M5 6h6" />
            <path d="M5 9h4" />
          </svg>
        )}
        action={(
          <div className="workspace-inline-actions workspace-inline-actions--wrap">
            {CONTEXT_KIND_ORDER.map((kind) => (
              <button key={kind} type="button" className="btn-secondary" onClick={() => void addContextItem(kind)}>
                {t(`workspacePage.contextKind${kind}` as const, { defaultValue: kind })}
              </button>
            ))}
          </div>
        )}
      >
        {sortedItems.length === 0 ? (
          <div className="workspace-empty-hint">{t('workspacePage.contextEmptyItems')}</div>
        ) : (
          <div className="workspace-context-list">
            {sortedItems.map((item) => {
              const threadRef = item.kind === 'thread_ref' ? item.ref : null;
              return (
              <ContextItemCard
                key={item.id}
                item={item}
                total={sortedItems.length}
                onMoveUp={() => void moveItem(item.id, -1)}
                onMoveDown={() => void moveItem(item.id, 1)}
                onDelete={() => void controller.deleteContextItem(item.id)}
                onSave={(patch) => void controller.saveContextItem({ ...item, ...patch, kind: item.kind })}
                onOpenThread={threadRef ? () => void controller.openThread(threadRef) : undefined}
              />
              );
            })}
          </div>
        )}
      </WorkspaceSurface>

      <WorkspaceSurface
        title={t('workspacePage.contextPromptLibraryTitle')}
        description={t('workspacePage.contextPromptLibraryDesc')}
        icon={(
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 2.5h8A1.5 1.5 0 0113.5 4v8A1.5 1.5 0 0112 13.5H4A1.5 1.5 0 012.5 12V4A1.5 1.5 0 014 2.5z" />
            <path d="M5 6h6" />
            <path d="M5 9h4" />
          </svg>
        )}
        action={(
          <button type="button" className="btn-secondary" onClick={() => void controller.refreshPromptLibrary()}>
            {t('workspacePage.contextRefreshPrompts')}
          </button>
        )}
      >
        {prompts.length === 0 ? (
          <div className="workspace-empty-hint">{t('workspacePage.contextEmptyPrompts')}</div>
        ) : (
          <div className="workspace-chain-list">
            {prompts.map((prompt) => (
              <button
                key={prompt.path}
                type="button"
                className="workspace-chain-row"
                onClick={() => void controller.saveContextItem({
                  kind: 'prompt_ref',
                  title: prompt.name,
                  content: prompt.content,
                  ref: prompt.path,
                  source: prompt.source,
                  sortOrder: sortedItems.length,
                })}
              >
                <div className="workspace-chain-row__left">
                  <span className="workspace-chain-row__label">{prompt.name}</span>
                  <span className="workspace-chain-row__hint">{prompt.source}</span>
                </div>
                <div className="workspace-chain-row__value">{previewWorkspaceText(prompt.content, prompt.path)}</div>
              </button>
            ))}
          </div>
        )}
      </WorkspaceSurface>

      <WorkspaceSurface
        title={t('workspacePage.contextFilesTitle')}
        description={t('workspacePage.contextFilesDesc')}
        icon={(
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 2.5h6l4 4v7A1.5 1.5 0 0111.5 15h-8A1.5 1.5 0 012 13.5V4A1.5 1.5 0 013.5 2.5z" />
            <path d="M9 2.5V6.5h4" />
          </svg>
        )}
        action={(
          <button type="button" className="btn-secondary" onClick={() => void controller.refreshProjectFolders()}>
            {t('workspacePage.contextRefreshFolders')}
          </button>
        )}
      >
        {controller.projectFolders.length === 0 ? (
          <div className="workspace-empty-hint">{t('workspacePage.contextEmptyFolders')}</div>
        ) : (
          <div className="workspace-compact-list">
            {controller.projectFolders.map((path) => (
              <div key={path} className="workspace-compact-list__row">
                <span>{previewWorkspaceText(path, path)}</span>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void controller.saveContextItem({
                    kind: 'file_ref',
                    title: previewWorkspaceText(path, path),
                    content: '',
                    ref: path,
                    source: 'project_folder',
                    sortOrder: sortedItems.length,
                  })}
                >
                  {t('workspacePage.contextUseAsFileRef')}
                </button>
              </div>
            ))}
          </div>
        )}
      </WorkspaceSurface>
    </div>
  );
}

function ContextItemCard({
  item,
  total,
  onMoveUp,
  onMoveDown,
  onDelete,
  onSave,
  onOpenThread,
}: {
  item: WorkspaceContextItemRecord;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onSave: (patch: Partial<WorkspaceContextItemRecord>) => void;
  onOpenThread?: () => void;
}) {
  const { t } = useTranslation();
  const showRefField = item.kind !== 'note' && item.kind !== 'run_summary';

  return (
    <article className="workspace-context-card">
      <div className="workspace-context-card__header">
        <div>
          <strong>{t(`workspacePage.contextKind${item.kind}` as const, { defaultValue: item.kind })}</strong>
          <span className="workspace-context-card__meta">{item.sortOrder + 1}/{total}</span>
        </div>
        <div className="workspace-inline-actions">
          <button type="button" className="btn-secondary" onClick={onMoveUp} disabled={item.sortOrder <= 0}>
            ↑
          </button>
          <button type="button" className="btn-secondary" onClick={onMoveDown} disabled={item.sortOrder >= total - 1}>
            ↓
          </button>
          {onOpenThread ? (
            <button type="button" className="btn-secondary" onClick={onOpenThread}>
              {t('workspacePage.contextOpenThread')}
            </button>
          ) : null}
          <button type="button" className="workspace-sidebar__reset-btn" onClick={onDelete}>
            {t('common.delete')}
          </button>
        </div>
      </div>

      <div className="workspace-field-grid">
        <label className="workspace-field">
          <span>{t('workspacePage.contextTitleLabel')}</span>
          <input value={item.title} onChange={(event) => onSave({ title: event.target.value })} />
        </label>
        <label className="workspace-field">
          <span>{t('workspacePage.contextSourceLabel')}</span>
          <input value={item.source ?? ''} onChange={(event) => onSave({ source: event.target.value || null })} />
        </label>
        {showRefField ? (
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.contextRefLabel')}</span>
            <input value={item.ref ?? ''} onChange={(event) => onSave({ ref: event.target.value || null })} />
          </label>
        ) : null}
        <label className="workspace-field workspace-field--full">
          <span>{t('workspacePage.contextContentLabel')}</span>
          <textarea
            value={item.content}
            onChange={(event) => onSave({ content: event.target.value })}
            rows={item.kind === 'prompt_ref' || item.kind === 'run_summary' ? 5 : 4}
          />
        </label>
      </div>
    </article>
  );
}
