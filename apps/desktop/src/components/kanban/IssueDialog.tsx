import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  listKanbanComments,
  listKanbanIssueRuns,
  createKanbanComment,
  deleteKanbanComment,
  KANBAN_COLUMNS,
  type KanbanIssue,
  type KanbanStatus,
  type KanbanPriority,
  type KanbanComment,
  type KanbanIssueRun,
} from '../../lib/kanbanDb';
import { PRIORITY_I18N, EXECUTION_STATE_I18N, genId, formatDate, formatDateTime } from './kanban-helpers';

export function IssueDialog({
  issue,
  initialStatus,
  onSave,
  onCommentsChanged,
  onOpenExecution,
  onRerun,
  canExecute,
  onClose,
}: {
  issue: KanbanIssue | null;
  initialStatus?: KanbanStatus;
  onSave: (data: { title: string; description: string; priority: KanbanPriority; tags: string; status: KanbanStatus; startDate: string; dueDate: string }) => void;
  onCommentsChanged?: (issueId: string, count: number) => void;
  onOpenExecution?: (issue: KanbanIssue) => void;
  onRerun?: (issue: KanbanIssue) => void;
  canExecute?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(issue?.title ?? '');
  const [description, setDescription] = useState(issue?.description ?? '');
  const [priority, setPriority] = useState<KanbanPriority>(issue?.priority ?? 'medium');
  const [tags, setTags] = useState(issue?.tags ?? '');
  const [status, setStatus] = useState<KanbanStatus>(issue?.status ?? initialStatus ?? 'todo');
  const [startDate, setStartDate] = useState(issue?.start_date ?? '');
  const [dueDate, setDueDate] = useState(issue?.due_date ?? '');
  const [comments, setComments] = useState<KanbanComment[]>([]);
  const [runs, setRuns] = useState<KanbanIssueRun[]>([]);
  const [newComment, setNewComment] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (issue) {
      void listKanbanComments(issue.id).then(setComments);
      void listKanbanIssueRuns(issue.id, 8).then(setRuns);
    } else {
      setComments([]);
      setRuns([]);
    }
  }, [issue]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSave({ title: title.trim(), description: description.trim(), priority, tags: tags.trim(), status, startDate, dueDate });
  };

  const handleAddComment = async () => {
    if (!newComment.trim() || !issue) return;
    await createKanbanComment({ id: genId(), issueId: issue.id, content: newComment.trim() });
    setNewComment('');
    const updated = await listKanbanComments(issue.id);
    setComments(updated);
    onCommentsChanged?.(issue.id, updated.length);
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!issue) return;
    await deleteKanbanComment(commentId);
    const updated = await listKanbanComments(issue.id);
    setComments(updated);
    onCommentsChanged?.(issue.id, updated.length);
  };

  return (
    <div className="kanban-dialog-backdrop kanban-dialog-backdrop--sheet" onClick={onClose}>
      <form className="kanban-dialog kanban-dialog--sheet" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="kanban-dialog-header">
          <h3>
            {issue ? (
              <>
                {issue.issue_number > 0 && <span className="kanban-dialog-issue-num">#{issue.issue_number}</span>}
                {t('kanban.editIssue')}
              </>
            ) : t('kanban.newIssue')}
          </h3>
          <button type="button" className="kanban-dialog-close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>

        <div className="kanban-dialog-body">
          <label className="kanban-dialog-label">
            {t('kanban.issueTitle')}
            <input
              ref={titleRef}
              className="kanban-dialog-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('kanban.issueTitlePlaceholder')}
              required
            />
          </label>

          <label className="kanban-dialog-label">
            {t('kanban.description')}
            <textarea
              className="kanban-dialog-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('kanban.descriptionPlaceholder')}
              rows={4}
            />
          </label>

          <div className="kanban-dialog-row">
            <label className="kanban-dialog-label kanban-dialog-label--half">
              {t('kanban.status')}
              <select className="kanban-dialog-select" value={status} onChange={(e) => setStatus(e.target.value as KanbanStatus)}>
                {KANBAN_COLUMNS.map((col) => (
                  <option key={col.key} value={col.key}>{t(col.i18nKey)}</option>
                ))}
              </select>
            </label>

            <label className="kanban-dialog-label kanban-dialog-label--half">
              {t('kanban.priority')}
              <select className="kanban-dialog-select" value={priority} onChange={(e) => setPriority(e.target.value as KanbanPriority)}>
                {Object.entries(PRIORITY_I18N).map(([key, i18nKey]) => (
                  <option key={key} value={key}>{t(i18nKey)}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="kanban-dialog-row">
            <label className="kanban-dialog-label kanban-dialog-label--half">
              {t('kanban.startDate')}
              <input
                type="date"
                className="kanban-dialog-input"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </label>
            <label className="kanban-dialog-label kanban-dialog-label--half">
              {t('kanban.dueDate')}
              <input
                type="date"
                className="kanban-dialog-input"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </label>
          </div>

          <label className="kanban-dialog-label">
            {t('kanban.tags')}
            <input
              className="kanban-dialog-input"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t('kanban.tagsPlaceholder')}
            />
          </label>

          {issue?.last_run_status && (
            <div className="kanban-dialog-execution">
              <div className="kanban-dialog-comments-header">{t('kanban.execution')}</div>
              <div className="kanban-dialog-execution-meta">
                <span className={`kanban-card-run-state kanban-card-run-state--${issue.last_run_status.toLowerCase()}`}>
                  {t(EXECUTION_STATE_I18N[issue.last_run_status])}
                </span>
                {issue.last_run_at && (
                  <span className="kanban-dialog-execution-time">
                    {t('kanban.lastRunAt', { date: formatDateTime(issue.last_run_at) })}
                  </span>
                )}
                {issue.last_finished_at && (
                  <span className="kanban-dialog-execution-time">
                    {t('kanban.lastFinishedAt', { date: formatDateTime(issue.last_finished_at) })}
                  </span>
                )}
              </div>
              {issue.last_error && (
                <div className="kanban-dialog-execution-error">{issue.last_error}</div>
              )}
              {issue.last_result_summary && (
                <div className="kanban-dialog-execution-summary">
                  <div className="kanban-dialog-execution-summary-label">{t('kanban.lastResultSummary')}</div>
                  <div className="kanban-dialog-execution-summary-text">{issue.last_result_summary}</div>
                </div>
              )}
              <div className="kanban-dialog-run-history">
                <div className="kanban-dialog-execution-summary-label">{t('kanban.runHistory')}</div>
                {runs.length > 0 ? (
                  <div className="kanban-dialog-run-list">
                    {runs.map((run) => (
                      <div key={run.id} className="kanban-dialog-run-item">
                        <div className="kanban-dialog-run-item-top">
                          <span className={`kanban-card-run-state kanban-card-run-state--${run.status.toLowerCase()}`}>
                            {t(EXECUTION_STATE_I18N[run.status])}
                          </span>
                          <span className="kanban-dialog-execution-time">{formatDateTime(run.started_at)}</span>
                        </div>
                        {(run.result_summary || run.error_message) && (
                          <div className="kanban-dialog-run-item-text">
                            {run.result_summary ?? run.error_message}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="kanban-dialog-run-empty">{t('kanban.noRunHistory')}</div>
                )}
              </div>
            </div>
          )}

          {issue && (
            <div className="kanban-dialog-comments">
              <div className="kanban-dialog-comments-header">
                {t('kanban.comments')} ({comments.length})
              </div>
              {comments.length > 0 && (
                <div className="kanban-dialog-comments-list">
                  {comments.map((c) => (
                    <div key={c.id} className="kanban-dialog-comment">
                      <div className="kanban-dialog-comment-content">{c.content}</div>
                      <div className="kanban-dialog-comment-meta">
                        <span>{formatDate(c.created_at)}</span>
                        <button type="button" className="kanban-dialog-comment-delete" onClick={() => { void handleDeleteComment(c.id); }}>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <line x1="3" y1="3" x2="9" y2="9" /><line x1="9" y1="3" x2="3" y2="9" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="kanban-dialog-comment-add">
                <input
                  ref={commentInputRef}
                  className="kanban-dialog-input"
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder={t('kanban.addComment')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void handleAddComment(); }
                  }}
                />
                <button
                  type="button"
                  className="kanban-dialog-btn kanban-dialog-btn--secondary kanban-dialog-comment-send"
                  onClick={() => { void handleAddComment(); }}
                  disabled={!newComment.trim()}
                >
                  {t('kanban.send')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="kanban-dialog-footer">
          {issue && (
            <span className="kanban-dialog-meta">
              {t('kanban.created', { date: formatDate(issue.created_at) })}
              {issue.updated_at !== issue.created_at && ` · ${t('kanban.updated', { date: formatDate(issue.updated_at) })}`}
            </span>
          )}
          <div className="kanban-dialog-actions">
            {issue?.linked_thread_id && onOpenExecution && (
              <button
                type="button"
                className="kanban-dialog-btn kanban-dialog-btn--secondary"
                onClick={() => { onOpenExecution(issue); onClose(); }}
              >
                {t('kanban.viewExecution')}
              </button>
            )}
            {issue && canExecute && onRerun && (
              <button
                type="button"
                className="kanban-dialog-btn kanban-dialog-btn--secondary"
                onClick={() => { onRerun(issue); onClose(); }}
                disabled={issue.last_run_status === 'RUNNING'}
              >
                {t('kanban.rerun')}
              </button>
            )}
            <button type="button" className="kanban-dialog-btn kanban-dialog-btn--secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" className="kanban-dialog-btn kanban-dialog-btn--primary" disabled={!title.trim()}>
              {issue ? t('kanban.saveChanges') : t('kanban.createIssue')}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
