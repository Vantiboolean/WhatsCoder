import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  listAutomations,
  listAutomationRuns,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  type AutomationRow,
  type AutomationRunRow,
  type AutomationScheduleConfig,
  type AutomationTriggerSource,
  type AutomationStatus,
  type ScheduleMode,
  type Weekday,
} from '../lib/db';
import {
  ALL_WEEKDAYS,
  EXECUTION_STATE_LABELS,
  WORK_WEEKDAYS,
  MODE_LABELS,
  RUN_STATUS_LABELS,
  TRIGGER_SOURCE_LABELS,
  WEEKDAY_LABELS,
  makeSchedule,
  automationRowToScheduleConfig,
  computeNextRun,
  computeRetryDelaySeconds,
  formatScheduleSummary,
  formatTimestamp,
} from '../lib/automations';
import { DesktopEmptyState, DesktopPageShell } from './DesktopPageShell';

// ── Automation Templates (matching Codex originals) ──

export interface AutomationTemplate {
  id: string;
  name: string;
  prompt: string;
  iconLabel: string;
  scheduleConfig: AutomationScheduleConfig;
}

const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 'daily-bug-scan',
    name: 'Daily bug scan',
    prompt: 'Scan recent commits (since the last run, or last 24h) for likely bugs and propose minimal fixes.\n\nGrounding rules:\n- Use ONLY concrete repo evidence (commit SHAs, PRs, file paths, diffs, failing tests, CI signals).\n- Do NOT invent bugs; if evidence is weak, say so and skip.\n- Prefer the smallest safe fix; avoid refactors and unrelated cleanup.',
    iconLabel: '🐛',
    scheduleConfig: makeSchedule({ mode: 'daily', weekdays: ALL_WEEKDAYS, time: '09:00' }),
  },
  {
    id: 'weekly-release-notes',
    name: 'Weekly release notes',
    prompt: 'Draft weekly release notes from merged PRs (include links when available).\n\nScope & grounding:\n- Stay strictly within the repo history for the week; do not add extra sections beyond what the data supports.\n- Use PR numbers/titles; avoid claims about impact unless supported by PR description/tests/metrics in repo.',
    iconLabel: '📋',
    scheduleConfig: makeSchedule({ mode: 'weekly', weekdays: ['FR'], time: '09:00' }),
  },
  {
    id: 'daily-standup',
    name: 'Standup summary',
    prompt: 'Summarize yesterday\'s git activity for standup.\n\nGrounding rules:\n- Anchor statements to commits/PRs/files; do not speculate about intent or future work.\n- Keep it scannable and team-ready.',
    iconLabel: '💬',
    scheduleConfig: makeSchedule({ mode: 'weekdays', weekdays: WORK_WEEKDAYS, time: '09:00' }),
  },
  {
    id: 'nightly-ci-report',
    name: 'Nightly CI report',
    prompt: 'Summarize CI failures and flaky tests from the last CI window; suggest top fixes.\n\nGrounding rules:\n- Cite specific jobs, tests, error messages, or log snippets when available.\n- Avoid overconfident root-cause claims; separate "observed" vs "suspected."',
    iconLabel: '📡',
    scheduleConfig: makeSchedule({ mode: 'daily', weekdays: ALL_WEEKDAYS, time: '21:00' }),
  },
  {
    id: 'daily-classic-game',
    name: 'Daily classic game',
    prompt: 'Create a small classic game with minimal scope.\n\nConstraints:\n- Do NOT add extra features, styling systems, content, or new dependencies unless required.\n- Reuse existing repo tooling and patterns.',
    iconLabel: '⭐',
    scheduleConfig: makeSchedule({ mode: 'daily', weekdays: ALL_WEEKDAYS, time: '14:00' }),
  },
  {
    id: 'skill-progression-map',
    name: 'Skill progression map',
    prompt: 'From recent PRs and reviews, suggest next skills to deepen.\n\nGrounding rules:\n- Anchor each suggestion to concrete evidence (PR themes, review comments, recurring issues).\n- Avoid generic advice; make each recommendation actionable and specific.',
    iconLabel: '📊',
    scheduleConfig: makeSchedule({ mode: 'weekly', weekdays: ['FR'], time: '10:00' }),
  },
  {
    id: 'weekly-engineering-summary',
    name: 'Weekly engineering summary',
    prompt: 'Synthesize this week\'s PRs, rollouts, incidents, and reviews into a weekly update.\n\nGrounding rules:\n- Do not invent events; if data is missing, say that briefly.\n- Prefer concrete references (PR #, incident ID, rollout note, file path) where available.',
    iconLabel: '📄',
    scheduleConfig: makeSchedule({ mode: 'weekly', weekdays: ['FR'], time: '16:00' }),
  },
  {
    id: 'performance-regression-watch',
    name: 'Performance regression watch',
    prompt: 'Compare recent changes to benchmarks or traces and flag regressions early.\n\nGrounding rules:\n- Ground claims in measurable signals (benchmarks, traces, timings, flamegraphs).\n- If measurements are unavailable, state "No measurements found" rather than guessing.',
    iconLabel: '📈',
    scheduleConfig: makeSchedule({ mode: 'daily', weekdays: ALL_WEEKDAYS, time: '09:00' }),
  },
  {
    id: 'dependency-sdk-drift',
    name: 'Dependency and SDK drift',
    prompt: 'Flag outdated dependencies and SDK versions that may cause issues.\n\nGrounding rules:\n- Reference actual version numbers, changelogs, and security advisories.\n- Prioritize by severity and blast radius.',
    iconLabel: '✅',
    scheduleConfig: makeSchedule({ mode: 'daily', weekdays: ALL_WEEKDAYS, time: '11:00' }),
  },
  {
    id: 'test-gap-detection',
    name: 'Test gap detection',
    prompt: 'Identify code paths and modules with missing or insufficient test coverage.\n\nGrounding rules:\n- Point to specific files, functions, or branches.\n- Suggest concrete test cases, not vague "add more tests" advice.',
    iconLabel: '🧩',
    scheduleConfig: makeSchedule({ mode: 'daily', weekdays: ALL_WEEKDAYS, time: '15:00' }),
  },
  {
    id: 'pre-release-check',
    name: 'Pre-release check',
    prompt: 'Run a pre-release checklist: verify tests pass, dependencies are pinned, changelogs updated, and no known blockers remain.\n\nGrounding rules:\n- Be specific about what passed and what failed.\n- Link to relevant files or CI jobs.',
    iconLabel: '✅',
    scheduleConfig: makeSchedule({ mode: 'weekly', weekdays: ['TH'], time: '13:00' }),
  },
  {
    id: 'agents-docs-sync',
    name: 'Update AGENTS.md',
    prompt: 'Review recent code changes and update AGENTS.md to reflect the current project state.\n\nGrounding rules:\n- Only update sections that are actually stale.\n- Cite the commits or PRs that triggered each change.',
    iconLabel: '📝',
    scheduleConfig: makeSchedule({ mode: 'weekly', weekdays: ['FR'], time: '11:00' }),
  },
  {
    id: 'weekly-pr-summary',
    name: 'Weekly PR summary',
    prompt: 'Summarize all merged PRs from the past week with key changes and impact.\n\nGrounding rules:\n- Use PR numbers and titles.\n- Group by area (frontend, backend, infra, etc.) when possible.',
    iconLabel: '📰',
    scheduleConfig: makeSchedule({ mode: 'weekly', weekdays: ['MO'], time: '09:00' }),
  },
  {
    id: 'issue-triage',
    name: 'Issue triage',
    prompt: 'Triage open issues: categorize by severity, suggest assignees, and flag duplicates.\n\nGrounding rules:\n- Reference issue numbers and descriptions.\n- Be conservative with severity ratings.',
    iconLabel: '❗',
    scheduleConfig: makeSchedule({ mode: 'weekdays', weekdays: WORK_WEEKDAYS, time: '09:30' }),
  },
  {
    id: 'ci-monitor',
    name: 'CI monitor',
    prompt: 'Monitor CI pipeline status and report failures every 2 hours during work hours.\n\nGrounding rules:\n- Cite specific jobs, tests, error messages, or log snippets when available.\n- Avoid overconfident root-cause claims.',
    iconLabel: '🖥',
    scheduleConfig: makeSchedule({ mode: 'custom', weekdays: WORK_WEEKDAYS, time: '09:00', intervalHours: 2, customRrule: 'RRULE:FREQ=HOURLY;INTERVAL=2;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR' }),
  },
  {
    id: 'dependency-sweep',
    name: 'Dependency sweep',
    prompt: 'Scan all project dependencies for security vulnerabilities, outdated versions, and license issues.\n\nGrounding rules:\n- Reference actual CVEs and advisory URLs.\n- Prioritize by CVSS score.',
    iconLabel: '🔧',
    scheduleConfig: makeSchedule({ mode: 'custom', weekdays: ALL_WEEKDAYS, time: '09:00', intervalHours: 720, customRrule: 'RRULE:FREQ=HOURLY;INTERVAL=720;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR,SA,SU' }),
  },
  {
    id: 'performance-audit',
    name: 'Performance audit',
    prompt: 'Audit application performance: bundle sizes, load times, memory usage, and render performance.\n\nGrounding rules:\n- Use measurable metrics.\n- Compare against previous baselines when available.',
    iconLabel: '🧭',
    scheduleConfig: makeSchedule({ mode: 'weekly', weekdays: ['MO'], time: '14:00' }),
  },
  {
    id: 'changelog-update',
    name: 'Update changelog',
    prompt: 'Update the project changelog based on merged PRs and notable changes.\n\nGrounding rules:\n- Follow existing changelog format.\n- Group entries by type (Added, Changed, Fixed, Removed).',
    iconLabel: '✏️',
    scheduleConfig: makeSchedule({ mode: 'weekly', weekdays: ['FR'], time: '16:00' }),
  },
];

const TEMPLATE_SECTIONS = [
  { id: 'status-reports', titleKey: 'statusReports' as const, cardIds: ['daily-standup', 'weekly-engineering-summary', 'weekly-pr-summary'] },
  { id: 'release-prep', titleKey: 'releasePrep' as const, cardIds: ['weekly-release-notes', 'pre-release-check', 'changelog-update'] },
  { id: 'incidents-triage', titleKey: 'incidentsAndTriage' as const, cardIds: ['nightly-ci-report', 'ci-monitor', 'issue-triage'] },
  { id: 'code-quality', titleKey: 'codeQuality' as const, cardIds: ['daily-bug-scan', 'test-gap-detection', 'performance-regression-watch'] },
  { id: 'repo-maintenance', titleKey: 'repoMaintenance' as const, cardIds: ['dependency-sdk-drift', 'dependency-sweep', 'agents-docs-sync'] },
  { id: 'growth-exploration', titleKey: 'growthAndExploration' as const, cardIds: ['skill-progression-map', 'performance-audit'] },
];

const TEMPLATE_MAP = new Map(AUTOMATION_TEMPLATES.map(tpl => [tpl.id, tpl]));

// ── Types ──

type ViewMode = 'list' | 'detail' | 'create' | 'templates';

type AutomationProjectOption = {
  cwd: string;
  label: string;
};

interface AutomationDraft {
  id: string | null;
  name: string;
  prompt: string;
  projectCwd: string | null;
  retryEnabled: boolean;
  retryMaxAttempts: number;
  retryBackoffMinutes: number;
  backgroundNotify: boolean;
  status: AutomationStatus;
  scheduleConfig: AutomationScheduleConfig;
  templateId: string | null;
}

const EMPTY_DRAFT: AutomationDraft = {
  id: null,
  name: '',
  prompt: '',
  projectCwd: null,
  retryEnabled: true,
  retryMaxAttempts: 2,
  retryBackoffMinutes: 15,
  backgroundNotify: true,
  status: 'ACTIVE',
  scheduleConfig: makeSchedule({ mode: 'daily', weekdays: ALL_WEEKDAYS, time: '09:00' }),
  templateId: null,
};

function summarizeProjectPath(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || cwd;
}

function describeAutomationError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return `${fallback}: ${error.message}`;
  }
  if (typeof error === 'string' && error.trim()) {
    return `${fallback}: ${error}`;
  }
  return fallback;
}

function rowToDraft(row: AutomationRow): AutomationDraft {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    projectCwd: row.project_cwd,
    retryEnabled: row.retry_enabled === 1,
    retryMaxAttempts: row.retry_max_attempts,
    retryBackoffMinutes: row.retry_backoff_minutes,
    backgroundNotify: row.background_notify === 1,
    status: row.status,
    scheduleConfig: automationRowToScheduleConfig(row),
    templateId: row.template_id,
  };
}

// ── Main Component ──

export interface AutomationsPanelProps {
  projects?: AutomationProjectOption[];
  activeProjectCwd?: string | null;
  onExecuteAutomation?: (
    automation: AutomationRow,
    options?: { revealThread?: boolean; toast?: boolean; triggerSource?: AutomationTriggerSource },
  ) => Promise<{ ok: boolean; threadId?: string; error?: string }>;
  onAutomationsChanged?: () => void | Promise<void>;
  onOpenThread?: (threadId: string) => void | Promise<void>;
  windowControls?: React.ReactNode;
}

export function AutomationsPanel({
  projects = [],
  activeProjectCwd = null,
  onExecuteAutomation,
  onAutomationsChanged,
  onOpenThread,
  windowControls,
}: AutomationsPanelProps) {
  const { t } = useTranslation();
  const defaultProjectCwd = activeProjectCwd ?? projects[0]?.cwd ?? null;
  const [automations, setAutomations] = useState<AutomationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [draft, setDraft] = useState<AutomationDraft>({ ...EMPTY_DRAFT, projectCwd: defaultProjectCwd });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runHistory, setRunHistory] = useState<AutomationRunRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(TEMPLATE_SECTIONS.map(s => s.id)));
  const [pageError, setPageError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await listAutomations();
      setAutomations(rows);
      setPageError(null);
    } catch (error) {
      setPageError(describeAutomationError(error, t('automations.loadFailed')));
    }
    setLoading(false);
  }, [t]);

  useEffect(() => { void refresh(); }, [refresh]);

  const selectedAutomation = useMemo(
    () => automations.find(a => a.id === selectedId) ?? null,
    [automations, selectedId],
  );
  const buildEmptyDraft = useCallback(
    () => ({ ...EMPTY_DRAFT, projectCwd: defaultProjectCwd }),
    [defaultProjectCwd],
  );
  const projectLabelByCwd = useMemo(() => new Map(projects.map((project) => [project.cwd, project.label])), [projects]);
  const getProjectLabel = useCallback(
    (cwd: string | null) => {
      if (!cwd) return t('automations.noProjectBinding');
      return projectLabelByCwd.get(cwd) ?? summarizeProjectPath(cwd);
    },
    [projectLabelByCwd, t],
  );
  const projectOptions = useMemo(() => {
    const next = [...projects];
    if (draft.projectCwd && !next.some((project) => project.cwd === draft.projectCwd)) {
      next.push({
        cwd: draft.projectCwd,
        label: t('automations.projectMissingPath', { path: summarizeProjectPath(draft.projectCwd) }),
      });
    }
    return next;
  }, [draft.projectCwd, projects, t]);
  const refreshHistory = useCallback(async (automationId: string | null) => {
    if (!automationId) {
      setHistoryLoading(false);
      setHistoryError(null);
      setRunHistory([]);
      return;
    }

    setHistoryLoading(true);
    try {
      const rows = await listAutomationRuns({ automationId, limit: 20 });
      setRunHistory(rows);
      setHistoryError(null);
    } catch (error) {
      setHistoryError(describeAutomationError(error, t('automations.loadRunHistoryFailed')));
    }
    setHistoryLoading(false);
  }, [t]);

  useEffect(() => {
    if (viewMode !== 'detail' || !selectedId) {
      setHistoryLoading(false);
      setHistoryError(null);
      setRunHistory([]);
      return;
    }
    void refreshHistory(selectedId);
  }, [refreshHistory, selectedId, viewMode]);
  useEffect(() => {
    const intervalId = setInterval(() => {
      void refresh();
      if (selectedId) {
        void refreshHistory(selectedId);
      }
    }, 15_000);

    return () => {
      clearInterval(intervalId);
    };
  }, [refresh, refreshHistory, selectedId]);

  // ── Handlers ──

  const handleCreateNew = useCallback(() => {
    setDraft(buildEmptyDraft());
    setSelectedId(null);
    setViewMode('create');
  }, [buildEmptyDraft]);

  const handleSelectTemplate = useCallback((tpl: AutomationTemplate) => {
    setDraft({
      id: null,
      name: tpl.name,
      prompt: tpl.prompt,
      projectCwd: defaultProjectCwd,
      retryEnabled: true,
      retryMaxAttempts: 2,
      retryBackoffMinutes: 15,
      backgroundNotify: true,
      status: 'ACTIVE',
      scheduleConfig: { ...tpl.scheduleConfig },
      templateId: tpl.id,
    });
    setViewMode('create');
  }, [defaultProjectCwd]);

  const handleSelectAutomation = useCallback((row: AutomationRow) => {
    setSelectedId(row.id);
    setDraft(rowToDraft(row));
    setViewMode('detail');
  }, []);

  const handleBack = useCallback(() => {
    setViewMode('list');
    setSelectedId(null);
    setDraft(buildEmptyDraft());
    setConfirmDeleteId(null);
  }, [buildEmptyDraft]);

  const handleSave = useCallback(async () => {
    if (!draft.name.trim() || !draft.prompt.trim()) return;
    setSaving(true);
    setPageError(null);
    try {
      if (draft.id) {
        const nextScheduledRunAt = draft.status === 'ACTIVE' ? computeNextRun(draft.scheduleConfig) : null;
        await updateAutomation({
          id: draft.id,
          name: draft.name.trim(),
          prompt: draft.prompt.trim(),
          projectCwd: draft.projectCwd,
          retryEnabled: draft.retryEnabled,
          retryMaxAttempts: draft.retryMaxAttempts,
          retryBackoffMinutes: draft.retryBackoffMinutes,
          backgroundNotify: draft.backgroundNotify,
          retryCount: 0,
          pendingRunKind: 'schedule',
          status: draft.status,
          scheduleConfig: draft.scheduleConfig,
          nextRunAt: nextScheduledRunAt,
          nextScheduledRunAt,
        });
      } else {
        const id = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await createAutomation({
          id,
          name: draft.name.trim(),
          prompt: draft.prompt.trim(),
          projectCwd: draft.projectCwd,
          retryEnabled: draft.retryEnabled,
          retryMaxAttempts: draft.retryMaxAttempts,
          retryBackoffMinutes: draft.retryBackoffMinutes,
          backgroundNotify: draft.backgroundNotify,
          status: 'ACTIVE',
          scheduleConfig: draft.scheduleConfig,
          templateId: draft.templateId ?? undefined,
        });
        const nextRun = computeNextRun(draft.scheduleConfig);
        await updateAutomation({
          id,
          nextRunAt: nextRun,
          nextScheduledRunAt: nextRun,
          pendingRunKind: 'schedule',
        });
      }
      await refresh();
      await onAutomationsChanged?.();
      handleBack();
    } catch (error) {
      setPageError(describeAutomationError(error, t('automations.saveFailed')));
    }
    setSaving(false);
  }, [draft, refresh, handleBack, onAutomationsChanged, t]);

  const handleToggleStatus = useCallback(async (row: AutomationRow) => {
    setPageError(null);
    try {
      const newStatus: AutomationStatus = row.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
      const cfg = automationRowToScheduleConfig(row);
      const nextScheduledRunAt = newStatus === 'ACTIVE' ? computeNextRun(cfg) : null;
      await updateAutomation({
        id: row.id,
        retryCount: 0,
        pendingRunKind: 'schedule',
        status: newStatus,
        nextRunAt: nextScheduledRunAt,
        nextScheduledRunAt,
      });
      await refresh();
      await onAutomationsChanged?.();
    } catch (error) {
      setPageError(describeAutomationError(error, t('automations.updateStatusFailed')));
    }
  }, [onAutomationsChanged, refresh, t]);

  const handleDelete = useCallback(async (id: string) => {
    setPageError(null);
    try {
      await deleteAutomation(id);
      await refresh();
      await onAutomationsChanged?.();
      setConfirmDeleteId(null);
      if (selectedId === id) handleBack();
    } catch (error) {
      setPageError(describeAutomationError(error, t('automations.deleteFailed')));
    }
  }, [handleBack, onAutomationsChanged, refresh, selectedId, t]);

  const handleRunNow = useCallback(async (row: AutomationRow) => {
    setRunningId(row.id);
    try {
      if (!onExecuteAutomation) return;

      await onExecuteAutomation(row, {
        revealThread: true,
        toast: true,
        triggerSource: 'manual',
      });
      await refresh();
      await refreshHistory(row.id);
      await onAutomationsChanged?.();
    } finally {
      setTimeout(() => setRunningId(null), 2000);
    }
  }, [onAutomationsChanged, onExecuteAutomation, refresh, refreshHistory]);

  const handleOpenLastThread = useCallback((threadId: string) => {
    if (!onOpenThread) return;
    void onOpenThread(threadId);
  }, [onOpenThread]);

  const toggleSection = useCallback((sectionId: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId); else next.add(sectionId);
      return next;
    });
  }, []);

  const canSave = draft.name.trim().length > 0 && draft.prompt.trim().length > 0;
  const retryPreview = useMemo(() => {
    if (!draft.retryEnabled) return null;
    const firstDelay = Math.round(computeRetryDelaySeconds(draft.retryBackoffMinutes, 1) / 60);
    const secondDelay = Math.round(computeRetryDelaySeconds(draft.retryBackoffMinutes, 2) / 60);
    if (draft.retryMaxAttempts <= 1) {
      return t('automations.retryPreviewOne', { minutes: firstDelay });
    }
    return t('automations.retryPreviewMany', {
      max: draft.retryMaxAttempts,
      first: firstDelay,
      second: secondDelay,
    });
  }, [draft.retryBackoffMinutes, draft.retryEnabled, draft.retryMaxAttempts, t]);
  const panelErrorBanner = pageError ? (
    <div className="automations-error-banner">
      <span>{pageError}</span>
    </div>
  ) : null;

  // ── Render ──

  if (viewMode === 'detail' || viewMode === 'create') {
    return (
      <DesktopPageShell
        className="automations-panel"
        bodyClassName="automations-panel__body automations-panel__body--editor"
        title={draft.id ? draft.name || t('common.edit') : t('automations.newAutomation')}
        windowControls={windowControls}
        actions={viewMode === 'detail' && draft.id ? (
          <>
            <button
              className="automations-action-btn automations-action-btn--run"
              onClick={() => { const row = automations.find(a => a.id === draft.id); if (row) void handleRunNow(row); }}
              disabled={runningId === draft.id}
              title={t('automations.runNow')}
            >
              {runningId === draft.id ? (
                <svg className="automations-spinner" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="20 14" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><polygon points="5,3 13,8 5,13"/></svg>
              )}
              {t('automations.runNow')}
            </button>
            {selectedAutomation?.last_thread_id && onOpenThread && (
              <button
                className="automations-action-btn"
                onClick={() => handleOpenLastThread(selectedAutomation.last_thread_id!)}
                title={t('automations.openThread')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3h7v7" />
                  <path d="M10.5 5.5L4.5 11.5" />
                  <path d="M3 6v7h7" />
                </svg>
                {t('automations.openThread')}
              </button>
            )}
            {draft.status === 'ACTIVE' ? (
              <button className="automations-action-btn" onClick={() => setDraft(d => ({ ...d, status: 'PAUSED' }))} title={t('automations.pause')}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="3" width="3" height="10" rx="0.5"/><rect x="9" y="3" width="3" height="10" rx="0.5"/></svg>
                {t('automations.pause')}
              </button>
            ) : (
              <button className="automations-action-btn automations-action-btn--resume" onClick={() => setDraft(d => ({ ...d, status: 'ACTIVE' }))} title={t('automations.resume')}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><polygon points="5,3 13,8 5,13"/></svg>
                {t('automations.resume')}
              </button>
            )}
            <button className="automations-action-btn automations-action-btn--danger" onClick={() => setConfirmDeleteId(draft.id)} title={t('common.delete')}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h10M5.5 5V3.5a1 1 0 011-1h3a1 1 0 011 1V5M6.5 7.5v4M9.5 7.5v4"/><path d="M4 5l.7 8.4a1 1 0 001 .9h4.6a1 1 0 001-.9L12 5"/></svg>
            </button>
          </>
        ) : null}
      >
        {panelErrorBanner}

        {confirmDeleteId && (
          <div className="automations-confirm-overlay">
            <div className="automations-confirm-card">
              <h3>{t('automations.deleteConfirm', { name: draft.name || t('automations.unnamedAutomation') })}</h3>
              <p>{t('automations.deleteWarning')}</p>
              <div className="automations-confirm-actions">
                <button className="btn-secondary" onClick={() => setConfirmDeleteId(null)}>{t('common.cancel')}</button>
                <button className="btn-danger" onClick={() => void handleDelete(confirmDeleteId)}>{t('automations.deleteAutomation')}</button>
              </div>
            </div>
          </div>
        )}

        <div className="desktop-page-surface desktop-page-surface--scroll">
          <div className="automations-editor">
            <form onSubmit={e => { e.preventDefault(); void handleSave(); }}>
            {/* Name */}
            <div className="automations-field">
              <label>{t('automations.name')}</label>
              <input
                value={draft.name}
                onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                placeholder={t('automations.promptPlaceholder')}
                autoFocus
              />
            </div>

            <div className="automations-field">
              <label>{t('automations.project')}</label>
              <select
                value={draft.projectCwd ?? ''}
                onChange={e => setDraft(d => ({ ...d, projectCwd: e.target.value || null }))}
                className="automations-select"
              >
                <option value="">{t('automations.noProjectBinding')}</option>
                {projectOptions.map(project => (
                  <option key={project.cwd} value={project.cwd}>{project.label}</option>
                ))}
              </select>
              <span className="automations-field-help">
                {projectOptions.length > 0
                  ? t('automations.projectHelpWhenProjects')
                  : t('automations.projectHelpNoProjects')}
              </span>
            </div>

            {/* Prompt */}
            <div className="automations-field">
              <label>{t('automations.promptLabel')}</label>
              <textarea
                value={draft.prompt}
                onChange={e => setDraft(d => ({ ...d, prompt: e.target.value }))}
                placeholder={t('automations.promptDesc')}
                rows={6}
              />
            </div>

            {/* Schedule Mode */}
            <div className="automations-field">
              <label>{t('automations.schedule')}</label>
              <div className="automations-schedule-grid">
                <select
                  value={draft.scheduleConfig.mode}
                  onChange={e => {
                    const mode = e.target.value as ScheduleMode;
                    setDraft(d => ({
                      ...d,
                      scheduleConfig: {
                        ...d.scheduleConfig,
                        mode,
                        weekdays: mode === 'weekdays' ? WORK_WEEKDAYS : mode === 'daily' ? ALL_WEEKDAYS : d.scheduleConfig.weekdays,
                      },
                    }));
                  }}
                  className="automations-select"
                >
                  {Object.entries(MODE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>

                <input
                  type="time"
                  value={draft.scheduleConfig.time}
                  onChange={e => setDraft(d => ({ ...d, scheduleConfig: { ...d.scheduleConfig, time: e.target.value } }))}
                  className="automations-time-input"
                />
              </div>
            </div>

            {/* Weekday picker (for weekly / custom) */}
            {(draft.scheduleConfig.mode === 'weekly' || draft.scheduleConfig.mode === 'custom') && (
              <div className="automations-field">
                <label>{t('automations.days')}</label>
                <div className="automations-weekday-picker">
                  {ALL_WEEKDAYS.map(day => {
                    const active = draft.scheduleConfig.weekdays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        className={`automations-weekday-btn${active ? ' automations-weekday-btn--active' : ''}`}
                        onClick={() => {
                          setDraft(d => {
                            const wds = d.scheduleConfig.weekdays;
                            const next = active ? wds.filter(w => w !== day) : [...wds, day];
                            return { ...d, scheduleConfig: { ...d.scheduleConfig, weekdays: next.length > 0 ? next : [day] } };
                          });
                        }}
                      >
                        {WEEKDAY_LABELS[day]}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Custom interval */}
            {draft.scheduleConfig.mode === 'custom' && (
              <div className="automations-field">
                <label>{t('automations.intervalHours')}</label>
                <input
                  type="number"
                  min={1}
                  value={draft.scheduleConfig.intervalHours ?? 24}
                  onChange={e => setDraft(d => ({ ...d, scheduleConfig: { ...d.scheduleConfig, intervalHours: parseInt(e.target.value) || 24 } }))}
                  className="automations-number-input"
                />
              </div>
            )}

            <div className="automations-section-card">
              <div className="automations-section-card-header">
                <h3>{t('automations.failureHandling')}</h3>
                <span>{t('automations.retryDesc')}</span>
              </div>
              <label className="automations-checkbox-row">
                <input
                  type="checkbox"
                  checked={draft.retryEnabled}
                  onChange={e => setDraft(d => ({ ...d, retryEnabled: e.target.checked }))}
                />
                <span>{t('automations.retryFailed')}</span>
              </label>
              {draft.retryEnabled && (
                <div className="automations-inline-grid">
                  <div className="automations-field">
                    <label>{t('automations.maxRetries')}</label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={draft.retryMaxAttempts}
                      onChange={e => setDraft(d => ({ ...d, retryMaxAttempts: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
                      className="automations-number-input"
                    />
                  </div>
                  <div className="automations-field">
                    <label>{t('automations.baseDelay')}</label>
                    <input
                      type="number"
                      min={1}
                      value={draft.retryBackoffMinutes}
                      onChange={e => setDraft(d => ({ ...d, retryBackoffMinutes: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
                      className="automations-number-input"
                    />
                  </div>
                </div>
              )}
              {retryPreview && <div className="automations-field-help">{retryPreview}</div>}
              <label className="automations-checkbox-row">
                <input
                  type="checkbox"
                  checked={draft.backgroundNotify}
                  onChange={e => setDraft(d => ({ ...d, backgroundNotify: e.target.checked }))}
                />
                <span>{t('automations.backgroundNotify')}</span>
              </label>
            </div>

            {/* Status indicator for existing automations */}
            {draft.id && selectedAutomation && (
              <>
                <div className="automations-meta-row">
                  <div className="automations-meta-item">
                    <span className="automations-meta-label">{t('automations.statusLabel')}</span>
                    <span className={`automations-status-badge automations-status-badge--${draft.status.toLowerCase()}`}>
                      {draft.status === 'ACTIVE' ? t('automations.active') : t('automations.paused')}
                    </span>
                  </div>
                  <div className="automations-meta-item">
                    <span className="automations-meta-label">{t('automations.lastResult')}</span>
                    <span className={`automations-run-state-badge${selectedAutomation.last_run_status ? ` automations-run-state-badge--${selectedAutomation.last_run_status.toLowerCase()}` : ''}`}>
                      {selectedAutomation.last_run_status ? EXECUTION_STATE_LABELS[selectedAutomation.last_run_status] : t('automations.neverRun')}
                    </span>
                  </div>
                  <div className="automations-meta-item">
                    <span className="automations-meta-label">{t('automations.project')}</span>
                    <span>{getProjectLabel(draft.projectCwd)}</span>
                  </div>
                  <div className="automations-meta-item">
                    <span className="automations-meta-label">{t('automations.nextRun')}</span>
                    <span>{draft.status === 'PAUSED' ? '-' : formatTimestamp(selectedAutomation.next_run_at)}</span>
                  </div>
                  <div className="automations-meta-item">
                    <span className="automations-meta-label">{t('automations.lastRun')}</span>
                    <span>{formatTimestamp(selectedAutomation.last_run_at)}</span>
                  </div>
                  {selectedAutomation.last_thread_id && onOpenThread && (
                    <div className="automations-meta-item">
                      <span className="automations-meta-label">{t('automations.lastThread')}</span>
                      <button
                        type="button"
                        className="automations-link-btn"
                        onClick={() => handleOpenLastThread(selectedAutomation.last_thread_id!)}
                      >
                        {t('automations.openThread')}
                      </button>
                    </div>
                  )}
                </div>
                {selectedAutomation.last_error && (
                  <div className="automations-error-banner">
                    <strong>{t('automations.lastError')}</strong>
                    <span>{selectedAutomation.last_error}</span>
                  </div>
                )}
              </>
            )}

            {/* Schedule summary */}
            <div className="automations-schedule-summary">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2.5 1.5"/></svg>
              <span>{formatScheduleSummary(draft.scheduleConfig)}</span>
            </div>

            {/* Actions */}
            <div className="automations-editor-actions">
              <button type="button" className="btn-secondary" onClick={handleBack}>{t('common.cancel')}</button>
              <button type="submit" className="btn-primary" disabled={!canSave || saving}>
                {saving ? t('composer.saving') : draft.id ? t('automations.saveChanges') : t('automations.createAutomation')}
              </button>
            </div>

            {draft.id && (
              <div className="automations-history">
                <div className="automations-section-card-header">
                  <h3>{t('automations.recentRuns')}</h3>
                  <span>{historyLoading ? t('common.loading') : t('automations.runHistoryCount', { count: runHistory.length })}</span>
                </div>
                {historyError && (
                  <div className="automations-error-banner">
                    <span>{historyError}</span>
                  </div>
                )}
                {historyLoading ? (
                  <div className="automations-history-empty">{t('automations.loadingRunHistory')}</div>
                ) : runHistory.length === 0 ? (
                  <div className="automations-history-empty">{t('automations.noRunsYet')}</div>
                ) : (
                  <div className="automations-history-list">
                    {runHistory.map(run => (
                      <div key={run.id} className="automations-history-item">
                        <div className="automations-history-main">
                          <span className={`automations-run-state-badge automations-run-state-badge--${run.status.toLowerCase()}`}>
                            {RUN_STATUS_LABELS[run.status]}
                          </span>
                          <span className="automations-history-meta">
                            {TRIGGER_SOURCE_LABELS[run.trigger_source]} · {t('automations.attemptLabel', { count: run.attempt_number })} · {formatTimestamp(run.started_at)}
                          </span>
                        </div>
                        <div className="automations-history-actions">
                          {run.thread_id && onOpenThread && (
                            <button
                              type="button"
                              className="automations-link-btn"
                              onClick={() => handleOpenLastThread(run.thread_id!)}
                            >
                              {t('automations.openThread')}
                            </button>
                          )}
                        </div>
                        {run.error_message && <div className="automations-history-error">{run.error_message}</div>}
                        {run.retry_scheduled_for && (
                          <div className="automations-history-retry">
                            {t('automations.retryScheduled')} {formatTimestamp(run.retry_scheduled_for)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            </form>
          </div>
        </div>
      </DesktopPageShell>
    );
  }

  // Templates view
  if (viewMode === 'templates') {
    return (
      <DesktopPageShell
        className="automations-panel"
        bodyClassName="automations-panel__body"
        title={t('automations.templates')}
        windowControls={windowControls}
      >
        {panelErrorBanner}
        <div className="desktop-page-surface desktop-page-surface--scroll">
          <div className="automations-templates-body">
          {TEMPLATE_SECTIONS.map(section => {
            const cards = section.cardIds.map(id => TEMPLATE_MAP.get(id)).filter(Boolean) as AutomationTemplate[];
            const isExpanded = expandedSections.has(section.id);
            return (
              <div key={section.id} className="automations-template-section">
                <button className="automations-template-section-header" onClick={() => toggleSection(section.id)}>
                  <span>{t(`automations.${section.titleKey}`)}</span>
                  <svg className={`automations-chevron${isExpanded ? ' automations-chevron--open' : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 1.5l4 3.5-4 3.5"/></svg>
                </button>
                {isExpanded && (
                  <div className="automations-template-grid">
                    {cards.map(tpl => (
                      <button
                        key={tpl.id}
                        className="automations-template-card"
                        onClick={() => handleSelectTemplate(tpl)}
                      >
                        <span className="automations-template-icon">{tpl.iconLabel}</span>
                        <div className="automations-template-info">
                          <div className="automations-template-name">{tpl.name}</div>
                          <div className="automations-template-schedule">{formatScheduleSummary(tpl.scheduleConfig)}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          </div>
        </div>
      </DesktopPageShell>
    );
  }

  // ── List View (default) ──

  return (
    <DesktopPageShell
      className="automations-panel"
      bodyClassName="automations-panel__body"
      title={t('automations.title')}
      windowControls={windowControls}
      actions={(
        <>
          <button className="automations-action-btn" onClick={() => setViewMode('templates')} title={t('automations.browseTemplates')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>
            {t('automations.templates')}
          </button>
          <button className="automations-action-btn automations-action-btn--primary" onClick={handleCreateNew}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
            {t('automations.newAutomation')}
          </button>
        </>
      )}
    >
      {panelErrorBanner}

      {loading ? (
        <div className="desktop-page-surface">
          <div className="automations-loading">
            <svg className="automations-spinner" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28 20"/></svg>
            <span>{t('common.loading')}</span>
          </div>
        </div>
      ) : automations.length === 0 ? (
        <div className="desktop-page-surface">
          <div className="automations-empty">
            <DesktopEmptyState
              icon={(
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="24" cy="24" r="16"/>
                  <path d="M24 16v8l6 3"/>
                </svg>
              )}
              title={t('automations.noAutomationsYet')}
              description={t('automations.noAutomationsDesc')}
              actions={(
                <>
                  <button className="btn-primary" onClick={() => setViewMode('templates')}>{t('automations.browseTemplates')}</button>
                  <button className="btn-secondary" onClick={handleCreateNew}>{t('automations.createFromScratch')}</button>
                </>
              )}
            />

            <div className="automations-quickstart">
              {TEMPLATE_SECTIONS.slice(0, 3).map(section => {
                const cards = section.cardIds.map(id => TEMPLATE_MAP.get(id)).filter(Boolean) as AutomationTemplate[];
                return (
                  <div key={section.id} className="automations-quickstart-section">
                    <h4>{t(`automations.${section.titleKey}`)}</h4>
                    <div className="automations-quickstart-grid">
                      {cards.map(tpl => (
                        <button key={tpl.id} className="automations-template-card automations-template-card--compact" onClick={() => handleSelectTemplate(tpl)}>
                          <span className="automations-template-icon">{tpl.iconLabel}</span>
                          <div className="automations-template-info">
                            <div className="automations-template-name">{tpl.name}</div>
                            <div className="automations-template-schedule">{formatScheduleSummary(tpl.scheduleConfig)}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="desktop-page-surface desktop-page-surface--scroll">
          <div className="automations-list">
            {automations.map(row => (
              <div
                key={row.id}
                className={`automations-row${selectedId === row.id ? ' automations-row--active' : ''}${row.status === 'PAUSED' ? ' automations-row--paused' : ''}`}
                onClick={() => handleSelectAutomation(row)}
              >
                <div className="automations-row-toggle" onClick={e => { e.stopPropagation(); void handleToggleStatus(row); }}>
                  <button className={`toggle-switch${row.status === 'ACTIVE' ? ' toggle-switch--on' : ''}`} title={row.status === 'ACTIVE' ? t('automations.pause') : t('automations.resume')}>
                    <span className="toggle-knob"/>
                  </button>
                </div>

                <div className="automations-row-info">
                  <div className="automations-row-name">{row.name}</div>
                  <div className="automations-row-subline">
                    {row.project_cwd && (
                      <span className="automations-project-badge">{getProjectLabel(row.project_cwd)}</span>
                    )}
                    {row.last_run_status && (
                      <span className={`automations-run-state-badge automations-run-state-badge--${row.last_run_status.toLowerCase()}`}>
                        {EXECUTION_STATE_LABELS[row.last_run_status]}
                      </span>
                    )}
                    <div className="automations-row-schedule">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 5.5v2.5l2 1.2"/></svg>
                      <span>{formatScheduleSummary(automationRowToScheduleConfig(row))}</span>
                    </div>
                  </div>
                  {row.last_error && (
                    <div className="automations-row-error" title={row.last_error}>{row.last_error}</div>
                  )}
                </div>

                <div className="automations-row-meta">
                  <div className="automations-row-meta-item">
                    <span className="automations-meta-label">{t('common.next')}</span>
                    <span>{row.status === 'PAUSED' ? '-' : formatTimestamp(row.next_run_at)}</span>
                  </div>
                  <div className="automations-row-meta-item">
                    <span className="automations-meta-label">{t('automations.last')}</span>
                    <span>{formatTimestamp(row.last_run_at)}</span>
                  </div>
                </div>

                <div className="automations-row-actions" onClick={e => e.stopPropagation()}>
                  {row.last_thread_id && onOpenThread && (
                    <button
                      className="automations-icon-btn"
                      onClick={() => handleOpenLastThread(row.last_thread_id!)}
                      title={t('automations.openThread')}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 3h7v7" />
                        <path d="M10.5 5.5L4.5 11.5" />
                        <path d="M3 6v7h7" />
                      </svg>
                    </button>
                  )}
                  <button
                    className="automations-icon-btn"
                    onClick={() => void handleRunNow(row)}
                    disabled={runningId === row.id}
                    title={t('automations.runNow')}
                  >
                    {runningId === row.id ? (
                      <svg className="automations-spinner" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="20 14"/></svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><polygon points="5,3 13,8 5,13"/></svg>
                    )}
                  </button>
                  <button className="automations-icon-btn automations-icon-btn--danger" onClick={() => {
                    if (confirmDeleteId === row.id) { void handleDelete(row.id); } else { setConfirmDeleteId(row.id); setTimeout(() => setConfirmDeleteId(null), 3000); }
                  }} title={confirmDeleteId === row.id ? t('automations.clickAgainToConfirm') : t('common.delete')}>
                    {confirmDeleteId === row.id ? (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--status-error)" strokeWidth="2" strokeLinecap="round"><path d="M3 8h10"/></svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h10M5.5 5V3.5a1 1 0 011-1h3a1 1 0 011 1V5M6.5 7.5v4M9.5 7.5v4"/><path d="M4 5l.7 8.4a1 1 0 001 .9h4.6a1 1 0 001-.9L12 5"/></svg>
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </DesktopPageShell>
  );
}
