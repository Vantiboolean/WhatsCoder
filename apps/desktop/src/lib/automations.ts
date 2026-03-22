/**
 * Schedule helpers for automations: `computeNextRun` picks the next Unix time from mode/weekday/time rules;
 * `computeRetryDelaySeconds` is exponential backoff from a base minute interval (attempt 1 = 1×, 2 = 2×, …).
 */
import type {
  AutomationExecutionState,
  AutomationRunStatus,
  AutomationTriggerSource,
  AutomationRow,
  AutomationScheduleConfig,
  ScheduleMode,
  Weekday,
} from './db';

export const ALL_WEEKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const WORK_WEEKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR'];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
};

export const MODE_LABELS: Record<ScheduleMode, string> = {
  daily: 'Every day',
  weekly: 'Weekly',
  weekdays: 'Weekdays',
  custom: 'Custom',
};

export const EXECUTION_STATE_LABELS: Record<AutomationExecutionState, string> = {
  RUNNING: 'Running',
  SUCCESS: 'Succeeded',
  FAILED: 'Failed',
  RETRYING: 'Retrying',
};

export const RUN_STATUS_LABELS: Record<AutomationRunStatus, string> = {
  RUNNING: 'Running',
  SUCCESS: 'Succeeded',
  FAILED: 'Failed',
};

export const TRIGGER_SOURCE_LABELS: Record<AutomationTriggerSource, string> = {
  manual: 'Manual',
  schedule: 'Schedule',
  retry: 'Retry',
};

export function makeSchedule(cfg: {
  mode: ScheduleMode;
  weekdays?: Weekday[];
  time: string;
  intervalHours?: number;
  customRrule?: string;
}): AutomationScheduleConfig {
  return {
    mode: cfg.mode,
    weekdays: cfg.weekdays ?? ALL_WEEKDAYS,
    time: cfg.time,
    intervalHours: cfg.intervalHours ?? 24,
    customRrule: cfg.customRrule ?? '',
  };
}

export function automationRowToScheduleConfig(
  row: Pick<
    AutomationRow,
    'schedule_mode' | 'schedule_weekdays' | 'schedule_time' | 'schedule_interval_hours' | 'schedule_custom_rrule'
  >,
): AutomationScheduleConfig {
  return {
    mode: row.schedule_mode,
    weekdays: row.schedule_weekdays.split(',').filter(Boolean) as Weekday[],
    time: row.schedule_time,
    intervalHours: row.schedule_interval_hours,
    customRrule: row.schedule_custom_rrule,
  };
}

export function formatScheduleSummary(cfg: AutomationScheduleConfig): string {
  const timeStr = cfg.time || '09:00';
  switch (cfg.mode) {
    case 'daily':
      return `Every day at ${timeStr}`;
    case 'weekdays':
      return `Weekdays at ${timeStr}`;
    case 'weekly': {
      const days = cfg.weekdays.map((day) => WEEKDAY_LABELS[day]).join(', ');
      return `Weekly on ${days} at ${timeStr}`;
    }
    case 'custom': {
      const days = cfg.weekdays.map((day) => WEEKDAY_LABELS[day]).join(', ');
      if (cfg.intervalHours && cfg.intervalHours < 24) {
        return `Every ${cfg.intervalHours}h starting at ${timeStr} on ${days}`;
      }
      if (cfg.intervalHours) {
        return `Every ${cfg.intervalHours}h at ${timeStr} on ${days}`;
      }
      return cfg.customRrule || `Custom schedule at ${timeStr}`;
    }
    default:
      return `At ${timeStr}`;
  }
}

/**
 * Custom mode with `intervalHours < 24` repeats inside each allowed day starting from `cfg.time`;
 * `intervalHours >= 24` advances in fixed hour increments from the configured anchor time.
 */
export function computeNextRun(cfg: AutomationScheduleConfig, now = new Date()): number {
  const [hoursRaw = '09', minutesRaw = '00'] = (cfg.time || '09:00').split(':');
  const hours = Number.parseInt(hoursRaw, 10) || 0;
  const minutes = Number.parseInt(minutesRaw, 10) || 0;
  const current = new Date(now);
  const target = new Date(current);
  target.setHours(hours, minutes, 0, 0);

  const jsWeekdayMap: Record<Weekday, number> = {
    SU: 0,
    MO: 1,
    TU: 2,
    WE: 3,
    TH: 4,
    FR: 5,
    SA: 6,
  };
  const allowedDays = new Set(cfg.weekdays.map((day) => jsWeekdayMap[day]));

  if (cfg.mode === 'custom' && cfg.intervalHours) {
    const intervalMs = Math.max(1, cfg.intervalHours) * 3600_000;
    if (cfg.intervalHours < 24) {
      if (allowedDays.has(current.getDay())) {
        const dayAnchor = new Date(current);
        dayAnchor.setHours(hours, minutes, 0, 0);
        let candidate = new Date(dayAnchor);

        if (candidate <= current) {
          const elapsedMs = current.getTime() - candidate.getTime();
          const steps = Math.floor(elapsedMs / intervalMs) + 1;
          candidate = new Date(candidate.getTime() + steps * intervalMs);
        }

        const sameDay =
          candidate.getFullYear() === current.getFullYear() &&
          candidate.getMonth() === current.getMonth() &&
          candidate.getDate() === current.getDate();

        if (sameDay && allowedDays.has(candidate.getDay())) {
          return Math.floor(candidate.getTime() / 1000);
        }
      }

      for (let offset = 1; offset <= 8; offset += 1) {
        const candidate = new Date(current);
        candidate.setDate(candidate.getDate() + offset);
        candidate.setHours(hours, minutes, 0, 0);
        if (allowedDays.has(candidate.getDay())) {
          return Math.floor(candidate.getTime() / 1000);
        }
      }
    } else {
      let candidate = new Date(current);
      candidate.setHours(hours, minutes, 0, 0);

      if (candidate <= current) {
        const elapsedMs = current.getTime() - candidate.getTime();
        const steps = Math.floor(elapsedMs / intervalMs) + 1;
        candidate = new Date(candidate.getTime() + steps * intervalMs);
      }

      for (let attempts = 0; attempts < 400; attempts += 1) {
        if (allowedDays.has(candidate.getDay())) {
          return Math.floor(candidate.getTime() / 1000);
        }
        candidate = new Date(candidate.getTime() + intervalMs);
      }
    }
  }

  if (target.getTime() > current.getTime() && allowedDays.has(target.getDay())) {
    return Math.floor(target.getTime() / 1000);
  }

  for (let offset = 1; offset <= 8; offset += 1) {
    const candidate = new Date(target);
    candidate.setDate(candidate.getDate() + offset);
    if (allowedDays.has(candidate.getDay())) {
      return Math.floor(candidate.getTime() / 1000);
    }
  }

  return Math.floor((current.getTime() + 86400_000) / 1000);
}

export function formatTimestamp(ts: number | null, now = new Date()): string {
  if (!ts) return '-';
  const date = new Date(ts * 1000);
  const diffMs = date.getTime() - now.getTime();
  const absDiffMs = Math.abs(diffMs);

  if (absDiffMs < 60_000) return diffMs > 0 ? 'in <1 min' : 'just now';
  if (absDiffMs < 3600_000) {
    const minutes = Math.floor(absDiffMs / 60_000);
    return diffMs > 0 ? `in ${minutes} min` : `${minutes} min ago`;
  }
  if (absDiffMs < 86400_000) {
    const hours = Math.floor(absDiffMs / 3600_000);
    return diffMs > 0 ? `in ${hours}h` : `${hours}h ago`;
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Exponential backoff: `baseMinutes * 60 * 2^(retryNumber - 1)`, clamped so zero/negative inputs do not break scheduling. */
export function computeRetryDelaySeconds(baseMinutes: number, retryNumber: number): number {
  const safeBaseMinutes = Math.max(1, baseMinutes || 1);
  const safeRetryNumber = Math.max(1, retryNumber || 1);
  return safeBaseMinutes * 60 * Math.pow(2, safeRetryNumber - 1);
}
