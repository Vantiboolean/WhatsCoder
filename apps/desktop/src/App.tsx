import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  CodexClient,
  type ConnectionState,
  type ThreadSummary,
  type ThreadDetail,
  type ThreadItem,
  type ModelInfo,
  type AccountInfo,
  type ApprovalDecision,
  type DynamicToolCallContentItem,
  type ChatgptAuthTokensRefreshReason,
  type ChatgptAuthTokensRefreshResponse,
} from '@codex-mobile/shared';
import { ThreadView } from './components/ThreadView';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getChatConfig, saveChatConfig, getSettingJson, setSettingJson, addChatMessage, getChatMessages, getAllChatHistory, searchChatHistory, type ChatHistoryEntry } from './lib/db';
import { invoke } from '@tauri-apps/api/core';
import { applyServerEventToThreadDetail, findThreadItem, mergeThreadDetailWithLocalState } from './state/threadState';
import { RightSidebar, type RightSidebarTab } from './components/RightSidebar';
import { CodeViewer, type OverlayView } from './components/CodeViewer';

type ReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh';
type ThemeMode = 'dark' | 'light' | 'system';

const appWindow = getCurrentWindow();

function WindowControls({ className }: { className?: string }) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    appWindow.isMaximized().then(setIsMaximized).catch(() => {});
    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized).catch(() => {});
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  return (
    <div className={`window-controls${className ? ` ${className}` : ''}`}>
      <button className="window-ctrl window-ctrl--minimize" onClick={() => appWindow.minimize()} title="Minimize">
        <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
      <button className="window-ctrl window-ctrl--maximize" onClick={() => appWindow.toggleMaximize()} title={isMaximized ? 'Restore' : 'Maximize'}>
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M2.5 2.5V1.5a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1h-1" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
        )}
      </button>
      <button className="window-ctrl window-ctrl--close" onClick={() => appWindow.close()} title="Close">
        <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" strokeWidth="1.2" /><line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
    </div>
  );
}

function CustomSelect({ value, options, onChange, title, compact }: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  title?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className={`csel${compact ? ' csel--compact' : ''}${open ? ' csel--open' : ''}`} ref={ref} title={title}>
      <button className="csel-trigger" onClick={() => setOpen(!open)}>
        <span className="csel-value">{current?.label ?? value}</span>
        <svg className="csel-chevron" width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 3l2 2 2-2" />
        </svg>
      </button>
      {open && (
        <div className="csel-menu">
          {options.map(o => (
            <button key={o.value} className={`csel-option${o.value === value ? ' csel-option--active' : ''}`} onClick={() => { onChange(o.value); setOpen(false); }}>
              {o.label}
              {o.value === value && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6l2.5 2.5 4.5-5" /></svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function usePersistedState<T>(key: string, defaultValue: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    getSettingJson<T>(key, defaultValue).then(sqlVal => {
      const localRaw = localStorage.getItem(key);
      const localVal = localRaw ? JSON.parse(localRaw) : null;
      if (JSON.stringify(sqlVal) !== JSON.stringify(localVal) && JSON.stringify(sqlVal) !== JSON.stringify(defaultValue)) {
        setValue(sqlVal);
        try { localStorage.setItem(key, JSON.stringify(sqlVal)); } catch { /* ignore */ }
      }
    }).catch(() => {});
  }, [key]);

  const set = useCallback((v: T) => {
    setValue(v);
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
    setSettingJson(key, v).catch(() => {});
  }, [key]);

  return [value, set];
}

function applyTheme(mode: ThemeMode) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
  if (resolved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

type ApprovalRequest = {
  requestId: number;
  method: string;
  threadId: string;
  turnId: string;
  itemId?: string;
  toolName?: string;
  command?: string;
  description?: string;
  kind?: 'exec' | 'permissions' | 'applyPatch' | 'mcpElicitation';
  diff?: string;
  permissions?: string[];
  rawPermissions?: Record<string, unknown>;
  availableDecisions?: unknown[];
};

type UserInputQuestion = {
  id: string;
  header?: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  allowNoneOfAbove?: boolean;
  isSecret?: boolean;
};

type UserInputRequest = {
  requestId: number;
  threadId: string;
  turnId: string;
  questions: UserInputQuestion[];
};

type McpElicitationOption = {
  value: string;
  label: string;
};

type McpElicitationField =
  | {
      kind: 'string';
      key: string;
      label: string;
      description?: string;
      required: boolean;
      format?: 'email' | 'uri' | 'date' | 'date-time';
      defaultValue?: string;
      minLength?: number;
      maxLength?: number;
    }
  | {
      kind: 'number';
      key: string;
      label: string;
      description?: string;
      required: boolean;
      integer: boolean;
      defaultValue?: number;
      minimum?: number;
      maximum?: number;
    }
  | {
      kind: 'boolean';
      key: string;
      label: string;
      description?: string;
      required: boolean;
      defaultValue?: boolean;
    }
  | {
      kind: 'singleSelect';
      key: string;
      label: string;
      description?: string;
      required: boolean;
      options: McpElicitationOption[];
      defaultValue?: string;
    }
  | {
      kind: 'multiSelect';
      key: string;
      label: string;
      description?: string;
      required: boolean;
      options: McpElicitationOption[];
      defaultValue?: string[];
      minItems?: number;
      maxItems?: number;
    };

type McpElicitationRequest =
  | {
      requestId: number;
      threadId: string;
      turnId: string | null;
      serverName: string;
      mode: 'form';
      message: string;
      fields: McpElicitationField[];
      meta?: unknown;
    }
  | {
      requestId: number;
      threadId: string;
      turnId: string | null;
      serverName: string;
      mode: 'url';
      message: string;
      url: string;
      elicitationId?: string;
      meta?: unknown;
    };

type DynamicToolCallRequest = {
  requestId: number;
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: unknown;
};

type AuthRefreshRequest = {
  requestId: number;
  reason: ChatgptAuthTokensRefreshReason;
  previousAccountId?: string | null;
};

type ApprovalPolicyValue = 'untrusted' | 'on-failure' | 'on-request' | 'never' | 'granular';
type SandboxModeValue = 'read-only' | 'workspace-write' | 'danger-full-access';
type AutonomyModeValue = 'suggest' | 'auto-edit' | 'full-auto' | 'custom';

type PendingMessage = {
  id: string;
  threadId: string;
  text: string;
};

type RateLimitWindowState = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

type CreditsSnapshotState = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
};

type RateLimitSnapshotState = {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  primary: RateLimitWindowState | null;
  secondary: RateLimitWindowState | null;
  credits: CreditsSnapshotState | null;
};

const AUTONOMY_PRESETS: Record<Exclude<AutonomyModeValue, 'custom'>, { approvalPolicy: ApprovalPolicyValue; sandboxMode: SandboxModeValue }> = {
  suggest: {
    approvalPolicy: 'untrusted',
    sandboxMode: 'read-only',
  },
  'auto-edit': {
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
  },
  'full-auto': {
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
  },
};

function formatRelativeTime(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

function folderName(cwd?: string): string {
  if (!cwd) return '';
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function toRateLimitWindow(value: unknown): RateLimitWindowState | null {
  if (!isObject(value) || typeof value.usedPercent !== 'number') {
    return null;
  }

  return {
    usedPercent: value.usedPercent,
    windowDurationMins: toNullableNumber(value.windowDurationMins),
    resetsAt: toNullableNumber(value.resetsAt),
  };
}

function toCreditsSnapshot(value: unknown): CreditsSnapshotState | null {
  if (!isObject(value) || typeof value.hasCredits !== 'boolean' || typeof value.unlimited !== 'boolean') {
    return null;
  }

  return {
    hasCredits: value.hasCredits,
    unlimited: value.unlimited,
    balance: toOptionalString(value.balance),
  };
}

function toRateLimitSnapshot(value: unknown): RateLimitSnapshotState | null {
  if (!isObject(value)) {
    return null;
  }

  return {
    limitId: toOptionalString(value.limitId),
    limitName: toOptionalString(value.limitName),
    planType: toOptionalString(value.planType),
    primary: toRateLimitWindow(value.primary),
    secondary: toRateLimitWindow(value.secondary),
    credits: toCreditsSnapshot(value.credits),
  };
}

function flattenPermissionLabels(profile: unknown): string[] {
  if (!isObject(profile)) {
    return [];
  }

  const labels: string[] = [];
  const network = isObject(profile.network) ? profile.network : null;
  const fileSystem = isObject(profile.fileSystem) ? profile.fileSystem : null;
  const macos = isObject(profile.macos) ? profile.macos : null;

  if (network && network.enabled === true) {
    labels.push('network');
  }

  if (fileSystem && Array.isArray(fileSystem.roots) && fileSystem.roots.length > 0) {
    labels.push(
      ...fileSystem.roots
        .filter((root): root is string => typeof root === 'string')
        .map((root) => `fs:${root}`),
    );
  }

  if (macos) {
    labels.push('macos');
  }

  return labels;
}

function getConfigRoot(config: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!config) {
    return null;
  }

  if (isObject(config.config)) {
    return config.config;
  }

  return config;
}

function getConfigOrigins(config: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!config || !isObject(config.origins)) {
    return null;
  }

  return config.origins;
}

function getBooleanConfigValue(config: Record<string, unknown> | null, path: string): boolean | undefined {
  const value = getConfigValue(config, path);
  return typeof value === 'boolean' ? value : undefined;
}

function getStringConfigValue(config: Record<string, unknown> | null, path: string): string | undefined {
  const value = getConfigValue(config, path);
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function hasConfigOrigin(config: Record<string, unknown> | null, path: string): boolean {
  const origins = getConfigOrigins(config);
  return !!origins && path in origins;
}

function getConfigOriginFile(config: Record<string, unknown> | null, path: string): string | null {
  const origins = getConfigOrigins(config);
  if (!origins) {
    return null;
  }

  const entry = origins[path];
  if (!isObject(entry) || !isObject(entry.name)) {
    return null;
  }

  return typeof entry.name.file === 'string' && entry.name.file.trim().length > 0 ? entry.name.file : null;
}

function hasLegacyCollabFeature(config: Record<string, unknown> | null): boolean {
  return hasConfigOrigin(config, 'features.collab') || typeof getBooleanConfigValue(config, 'features.collab') === 'boolean';
}

function isLegacyCollabConfigError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('collab') && normalized.includes('deprecated') && normalized.includes('multi_agent');
}

function extractLegacyCollabConfigPathFromError(message: string): string | null {
  const normalized = message.replace(/\r?\n/g, ' ');
  const patterns = [
    /([A-Za-z]:[\\/][^"'`]*?config\.toml)/i,
    /(\/[^"'`]*?config\.toml)/i,
    /(~\/[^"'`]*?config\.toml)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (typeof match?.[1] === 'string' && match[1].trim().length > 0) {
      return match[1].trim().replace(/\\/g, '/');
    }
  }

  return null;
}

function getLegacyCollabConfigPath(config: Record<string, unknown> | null, fallbackPath?: string | null): string {
  const rawPath = (
    getConfigOriginFile(config, 'features.collab') ??
    getConfigOriginFile(config, 'features.multi_agent') ??
    fallbackPath ??
    '~/.codex/config.toml'
  );
  return rawPath.replace(/\\/g, '/');
}

function toUserInputQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((question): UserInputQuestion | null => {
      if (!isObject(question) || typeof question.id !== 'string' || typeof question.question !== 'string') {
        return null;
      }

      const options = Array.isArray(question.options)
        ? question.options.reduce<Array<{ label: string; description?: string }>>((acc, option) => {
            if (!isObject(option) || typeof option.label !== 'string') {
              return acc;
            }

            acc.push({
              label: option.label,
              description: typeof option.description === 'string' ? option.description : undefined,
            });
            return acc;
          }, [])
        : undefined;

      return {
        id: question.id,
        header: typeof question.header === 'string' ? question.header : undefined,
        question: question.question,
        options,
        allowNoneOfAbove: question.isOther === true,
        isSecret: question.isSecret === true,
      };
    })
    .filter((question): question is UserInputQuestion => question != null);
}

function humanizeFieldKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function toMcpOptions(schema: Record<string, unknown>): McpElicitationOption[] {
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf
      .map((option) => {
        if (!isObject(option) || typeof option.const !== 'string') {
          return null;
        }

        return {
          value: option.const,
          label: typeof option.title === 'string' ? option.title : option.const,
        };
      })
      .filter((entry): entry is McpElicitationOption => entry != null);
  }

  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf
      .map((option) => {
        if (!isObject(option) || typeof option.const !== 'string') {
          return null;
        }

        return {
          value: option.const,
          label: typeof option.title === 'string' ? option.title : option.const,
        };
      })
      .filter((entry): entry is McpElicitationOption => entry != null);
  }

  if (Array.isArray(schema.enum)) {
    const values = toStringList(schema.enum);
    const labels = Array.isArray(schema.enumNames) ? schema.enumNames : [];

    return values.map((value, index) => ({
      value,
      label: typeof labels[index] === 'string' ? String(labels[index]) : value,
    }));
  }

  return [];
}

function toMcpElicitationFields(schema: unknown): McpElicitationField[] {
  if (!isObject(schema) || schema.type !== 'object' || !isObject(schema.properties)) {
    return [];
  }

  const requiredKeys = new Set(toStringList(schema.required));
  const properties = Object.entries(schema.properties);

  return properties.flatMap(([key, property]): McpElicitationField[] => {
    if (!isObject(property) || typeof property.type !== 'string') {
      return [];
    }

    const label = typeof property.title === 'string' ? property.title : humanizeFieldKey(key);
    const description = typeof property.description === 'string' ? property.description : undefined;
    const required = requiredKeys.has(key);

    if (property.type === 'string') {
      const options = toMcpOptions(property);
      if (options.length > 0) {
        return [
          {
            kind: 'singleSelect',
            key,
            label,
            description,
            required,
            options,
            defaultValue: typeof property.default === 'string' ? property.default : undefined,
          },
        ];
      }

      return [
        {
          kind: 'string',
          key,
          label,
          description,
          required,
          format:
            property.format === 'email' || property.format === 'uri' || property.format === 'date' || property.format === 'date-time'
              ? property.format
              : undefined,
          defaultValue: typeof property.default === 'string' ? property.default : undefined,
          minLength: toOptionalNumber(property.minLength),
          maxLength: toOptionalNumber(property.maxLength),
        },
      ];
    }

    if (property.type === 'number' || property.type === 'integer') {
      return [
        {
          kind: 'number',
          key,
          label,
          description,
          required,
          integer: property.type === 'integer',
          defaultValue: toOptionalNumber(property.default),
          minimum: toOptionalNumber(property.minimum),
          maximum: toOptionalNumber(property.maximum),
        },
      ];
    }

    if (property.type === 'boolean') {
      return [
        {
          kind: 'boolean',
          key,
          label,
          description,
          required,
          defaultValue: typeof property.default === 'boolean' ? property.default : undefined,
        },
      ];
    }

    if (property.type === 'array' && isObject(property.items)) {
      const options = toMcpOptions(property.items);
      if (options.length === 0) {
        return [];
      }

      return [
        {
          kind: 'multiSelect',
          key,
          label,
          description,
          required,
          options,
          defaultValue: toStringList(property.default),
          minItems: toOptionalNumber(property.minItems),
          maxItems: toOptionalNumber(property.maxItems),
        },
      ];
    }

    return [];
  });
}

function toMcpElicitationRequest(requestId: number, params: Record<string, unknown>): McpElicitationRequest | null {
  const threadId = typeof params.threadId === 'string' ? params.threadId : null;
  const turnId = typeof params.turnId === 'string' ? params.turnId : null;
  const serverName = typeof params.serverName === 'string' ? params.serverName : null;
  const mode = params.mode;
  const message = typeof params.message === 'string' ? params.message : '';

  if (!threadId || !serverName || (mode !== 'form' && mode !== 'url')) {
    return null;
  }

  if (mode === 'form') {
    return {
      requestId,
      threadId,
      turnId,
      serverName,
      mode: 'form',
      message,
      fields: toMcpElicitationFields(params.requestedSchema),
      meta: params._meta,
    };
  }

  if (typeof params.url !== 'string') {
    return null;
  }

  return {
    requestId,
    threadId,
    turnId,
    serverName,
    mode: 'url',
    message,
    url: params.url,
    elicitationId: typeof params.elicitationId === 'string' ? params.elicitationId : undefined,
    meta: params._meta,
  };
}

function stringifyForDisplay(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type McpDraftValue = string | string[] | boolean;

function getMcpFieldInitialValue(field: McpElicitationField): McpDraftValue {
  switch (field.kind) {
    case 'string':
      return field.defaultValue ?? '';
    case 'number':
      return field.defaultValue != null ? String(field.defaultValue) : '';
    case 'boolean':
      return field.defaultValue ?? false;
    case 'singleSelect':
      return field.defaultValue ?? '';
    case 'multiSelect':
      return field.defaultValue ?? [];
  }
}

function isMcpFieldValueValid(field: McpElicitationField, value: McpDraftValue | undefined): boolean {
  switch (field.kind) {
    case 'string':
      return field.required ? typeof value === 'string' && value.trim().length > 0 : true;
    case 'number':
      if (typeof value !== 'string' || value.trim().length === 0) {
        return !field.required;
      }
      return Number.isFinite(Number(value));
    case 'boolean':
      return typeof value === 'boolean';
    case 'singleSelect':
      return field.required ? typeof value === 'string' && value.length > 0 : true;
    case 'multiSelect': {
      if (!Array.isArray(value)) {
        return !field.required;
      }

      if (field.required && value.length === 0) {
        return false;
      }

      if (field.minItems != null && value.length < field.minItems) {
        return false;
      }

      if (field.maxItems != null && value.length > field.maxItems) {
        return false;
      }

      return true;
    }
  }
}

function buildMcpElicitationContent(
  fields: McpElicitationField[],
  draft: Record<string, McpDraftValue>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};

  for (const field of fields) {
    const value = draft[field.key];

    switch (field.kind) {
      case 'string':
      case 'singleSelect': {
        if (typeof value === 'string' && value.trim().length > 0) {
          content[field.key] = value.trim();
        }
        break;
      }
      case 'number': {
        if (typeof value === 'string' && value.trim().length > 0) {
          content[field.key] = field.integer ? Math.trunc(Number(value)) : Number(value);
        }
        break;
      }
      case 'boolean':
        if (typeof value === 'boolean') {
          content[field.key] = value;
        }
        break;
      case 'multiSelect':
        if (Array.isArray(value) && value.length > 0) {
          content[field.key] = value;
        }
        break;
    }
  }

  return content;
}

type ThreadGroup = {
  folder: string;
  cwd: string;
  threads: ThreadSummary[];
};

export function App() {
  const clientRef = useRef(new CodexClient());
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const [url, setUrl] = usePersistedState('codex-ws-url', 'ws://127.0.0.1:4500');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isAgentActive, setIsAgentActive] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'error' | 'info' } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [reasoning, setReasoning] = usePersistedState<ReasoningLevel>('codex-reasoning', 'high');
  const [theme, setTheme] = usePersistedState<ThemeMode>('codex-theme', 'dark');
  const [codexConfig, setCodexConfig] = useState<Record<string, unknown> | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [showRawJson, setShowRawJson] = useState(false);
  const [inputText, setInputText] = useState('');
  const [threadSearch, setThreadSearch] = useState('');
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [accountInfo, setAccountInfo] = useState<AccountInfo>(null);
  const [rateLimits, setRateLimits] = useState<RateLimitSnapshotState | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');
  const [sidebarView, setSidebarView] = useState<'threads' | 'settings' | 'automations' | 'skills' | 'history'>('threads');
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const sidebarResizing = useRef(false);
  const sidebarResizeStartX = useRef(0);
  const sidebarResizeStartWidth = useRef(0);
  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarResizing.current = true;
    sidebarResizeStartX.current = e.clientX;
    sidebarResizeStartWidth.current = sidebarWidth;
    const onMouseMove = (ev: MouseEvent) => {
      if (!sidebarResizing.current) return;
      const delta = ev.clientX - sidebarResizeStartX.current;
      setSidebarWidth(Math.min(Math.max(sidebarResizeStartWidth.current + delta, 160), 520));
    };
    const onMouseUp = () => {
      sidebarResizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);
  const [showArchived, setShowArchived] = useState(false);
  const [folderMenu, setFolderMenu] = useState<{ cwd: string; x: number; y: number } | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [folderAlias, setFolderAlias] = usePersistedState<Record<string, string>>('codex-folder-aliases', {});
  const [skills, setSkills] = useState<Array<{ name: string; path: string }>>([]);
  const [mcpServers, setMcpServers] = useState<Array<{ name: string; status: string }>>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [turnStartTime, setTurnStartTime] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [messageHistory, setMessageHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [userInputRequests, setUserInputRequests] = useState<UserInputRequest[]>([]);
  const [mcpElicitationRequests, setMcpElicitationRequests] = useState<McpElicitationRequest[]>([]);
  const [dynamicToolCallRequests, setDynamicToolCallRequests] = useState<DynamicToolCallRequest[]>([]);
  const [authRefreshRequests, setAuthRefreshRequests] = useState<AuthRefreshRequest[]>([]);
  const [contextUsage, setContextUsage] = useState<{ percent: number; usedTokens: number } | null>(null);
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSuggestions, setShowSuggestions] = usePersistedState('codex-show-suggestions', true);
  const [activeProjectCwd, setActiveProjectCwd] = useState<string | null>(null);
  const [isThreadLoading, setIsThreadLoading] = useState(false);
  const [threadLoadError, setThreadLoadError] = useState<string | null>(null);
  const [lastResolvedThreadDetail, setLastResolvedThreadDetail] = useState<ThreadDetail | null>(null);
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const projectDropdownRef = useRef<HTMLDivElement>(null);
  const [autonomyMode, setAutonomyMode] = useState<AutonomyModeValue>('suggest');
  const [isUpdatingAutonomy, setIsUpdatingAutonomy] = useState(false);
  const [gitInfo, setGitInfo] = useState<{ branch: string; isDirty: boolean; addedLines: number; removedLines: number; ahead: number; behind: number; lastCommitSha?: string; lastCommitMsg?: string } | null>(null);

  const [attachedImages, setAttachedImages] = useState<Array<{ dataUrl: string; name: string }>>([]);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [historyEntries, setHistoryEntries] = useState<import('./lib/db').ChatHistoryEntry[]>([]);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [pinnedThreads, setPinnedThreads] = usePersistedState<string[]>('codex-pinned-threads', []);
  const [threadCtxMenu, setThreadCtxMenu] = useState<{ threadId: string; x: number; y: number } | null>(null);

  const [rightSidebarOpen, setRightSidebarOpen] = usePersistedState('codex-right-sidebar-open', false);
  const [rightSidebarTab, setRightSidebarTab] = usePersistedState<RightSidebarTab>('codex-right-sidebar-tab', 'git');
  const [rightSidebarWidth, setRightSidebarWidth] = usePersistedState('codex-right-sidebar-width', 320);
  const [overlayView, setOverlayView] = useState<OverlayView>(null);
  const [addedProjects, setAddedProjects] = usePersistedState<string[]>('codex-added-projects', []);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedThreadRef = useRef<string | null>(null);
  const threadDetailRef = useRef<ThreadDetail | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeTurnIdRef = useRef<string | null>(null);
  const pendingDeltaEventsRef = useRef<Array<{ method: string; params: Record<string, unknown> }>>([]);
  const deltaFlushScheduledRef = useRef(false);
  const showArchivedRef = useRef(showArchived);
  const lastAutoFlushedPendingIdRef = useRef<string | null>(null);
  const threadsRef = useRef<ThreadSummary[]>([]);
  const sidebarViewRef = useRef(sidebarView);
  const skillsRef = useRef<Array<{ name: string; path: string }>>([]);
  const isComposingRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { selectedThreadRef.current = selectedThread; }, [selectedThread]);
  useEffect(() => { threadDetailRef.current = threadDetail; }, [threadDetail]);
  useEffect(() => {
    if (threadDetail) {
      setLastResolvedThreadDetail(threadDetail);
    }
  }, [threadDetail]);
  useEffect(() => { showArchivedRef.current = showArchived; }, [showArchived]);
  useEffect(() => { lastAutoFlushedPendingIdRef.current = null; }, [selectedThread]);
  useEffect(() => { threadsRef.current = threads; }, [threads]);
  useEffect(() => { sidebarViewRef.current = sidebarView; }, [sidebarView]);
  useEffect(() => { skillsRef.current = skills; }, [skills]);
  useEffect(() => { setShowRawJson(false); setOverlayView(null); }, [selectedThread, sidebarView]);

  // Toast 自动消失
  useEffect(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    if (!toast) return;
    const ms = toast.type === 'error' ? 6000 : 3000;
    toastTimerRef.current = setTimeout(() => setToast(null), ms);
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); };
  }, [toast]);

  // History 面板：切换到 history tab 时加载数据
  useEffect(() => {
    if (sidebarView !== 'history') return;
    const load = async () => {
      if (historySearchQuery.trim()) {
        const result = await searchChatHistory(historySearchQuery.trim());
        setHistoryEntries(result);
      } else {
        const result = await getAllChatHistory();
        setHistoryEntries(result);
      }
    };
    void load();
  }, [sidebarView, historySearchQuery]);

  // 滚动到底按钮：监听消息列表滚动
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBtn(distFromBottom > 120);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [selectedThread]);

  useEffect(() => {
    if (!selectedThread) {
      setMessageHistory([]);
      setHistoryIdx(-1);
      return;
    }
    getChatMessages(selectedThread, 50).then(msgs => {
      setMessageHistory([...msgs].reverse());
      setHistoryIdx(-1);
    }).catch(() => {});
  }, [selectedThread]);

  useEffect(() => {
    if (!projectDropdownOpen) return;
    const close = (e: MouseEvent) => {
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(e.target as Node)) setProjectDropdownOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [projectDropdownOpen]);

  useEffect(() => {
    if (!selectedThread || !selectedModel) return;
    saveChatConfig({ thread_id: selectedThread, model: selectedModel, reasoning }).catch(() => {});
  }, [selectedThread, selectedModel, reasoning]);

  useEffect(() => {
    if (!isAgentActive && !isSending) {
      setTurnStartTime(null);
      return;
    }
    if (!turnStartTime) setTurnStartTime(Date.now());
    const timer = setInterval(() => {
      setElapsedSec(turnStartTime ? Math.floor((Date.now() - turnStartTime) / 1000) : 0);
    }, 1000);
    return () => clearInterval(timer);
  }, [isAgentActive, isSending, turnStartTime]);

  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (theme === 'system') applyTheme('system'); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  useEffect(() => {
    setAutonomyMode(deriveAutonomyModeFromConfig(codexConfig));
  }, [codexConfig]);

  useEffect(() => {
    const title = threadDetail
      ? `${threadDetail.name || threadDetail.preview || 'Thread'} – Codex`
      : 'Codex Desktop';
    appWindow.setTitle(title).catch(() => {});
  }, [threadDetail?.id, threadDetail?.name, threadDetail?.preview]);

  useEffect(() => {
    isPermissionGranted().then(async (granted) => {
      if (!granted) {
        await requestPermission();
      }
    }).catch(() => {});
  }, []);

  const threadGroups = useMemo<ThreadGroup[]>(() => {
    const searchLower = threadSearch.toLowerCase();
    const projectFiltered = addedProjects.length > 0
      ? threads.filter((t) => {
          if (!t.cwd) return true;
          const normalizedCwd = t.cwd.replace(/\\/g, '/').replace(/\/$/, '');
          return addedProjects.some(p => normalizedCwd === p.replace(/\\/g, '/').replace(/\/$/, ''));
        })
      : threads;

    const filtered = searchLower
      ? projectFiltered.filter((t) => {
          const name = (t.name || t.preview || '').toLowerCase();
          const folder = folderName(t.cwd).toLowerCase();
          return name.includes(searchLower) || folder.includes(searchLower);
        })
      : projectFiltered;

    const grouped = new Map<string, ThreadSummary[]>();
    const ungrouped: ThreadSummary[] = [];

    for (const t of filtered) {
      if (t.cwd) {
        const key = t.cwd;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(t);
      } else {
        ungrouped.push(t);
      }
    }

    const groups: ThreadGroup[] = [];
    for (const [cwd, items] of grouped) {
      groups.push({ folder: folderName(cwd), cwd, threads: items });
    }
    groups.sort((a, b) => {
      const aTime = Math.max(...a.threads.map(t => t.updatedAt ?? t.createdAt));
      const bTime = Math.max(...b.threads.map(t => t.updatedAt ?? t.createdAt));
      return bTime - aTime;
    });
    if (ungrouped.length > 0) {
      groups.push({ folder: '', cwd: '', threads: ungrouped });
    }
    return groups;
  }, [threads, threadSearch, addedProjects]);

  const refreshAccountInfo = useCallback(async () => {
    try {
      const { account } = await clientRef.current.readAccount();
      setAccountInfo(account);
      return account;
    } catch {
      setAccountInfo(null);
      return null;
    }
  }, []);

  const refreshMcpServers = useCallback(async () => {
    try {
      const result = await clientRef.current.listMcpServers() as { data?: Array<{ name: string; status: string }> };
      setMcpServers(result?.data ?? []);
      return result?.data ?? [];
    } catch {
      setMcpServers([]);
      return null;
    }
  }, []);

  const refreshSkills = useCallback(async () => {
    try {
      const cwds = [...new Set(
        threadsRef.current
          .map((thread) => thread.cwd)
          .filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0),
      )];
      const result = await clientRef.current.listSkills(cwds.length > 0 ? cwds : ['.']) as {
        skills?: Array<{ name: string; path: string }>;
      };
      setSkills(result?.skills ?? []);
      return result?.skills ?? [];
    } catch {
      setSkills([]);
      return null;
    }
  }, []);

  useEffect(() => {
    const projectCwds = threadGroups.filter((group) => group.cwd && group.folder).map((group) => group.cwd);

    if (threadDetail?.cwd) {
      if (activeProjectCwd !== threadDetail.cwd) {
        setActiveProjectCwd(threadDetail.cwd);
      }
      return;
    }

    if (projectCwds.length === 0) {
      if (activeProjectCwd !== null) {
        setActiveProjectCwd(null);
      }
      return;
    }

    if (!activeProjectCwd || !projectCwds.includes(activeProjectCwd)) {
      setActiveProjectCwd(projectCwds[0]);
    }
  }, [activeProjectCwd, threadDetail?.cwd, threadGroups]);

  useEffect(() => {
    const cwd = threadDetail?.cwd || (threadGroups.length > 0 ? threadGroups[0]?.cwd : null);
    if (!cwd) return;
    const fetchGitInfo = async () => {
      try {
        const info = await invoke<{ branch: string; isDirty: boolean; addedLines: number; removedLines: number; ahead: number; behind: number; lastCommitSha?: string; lastCommitMsg?: string }>('get_git_info', { cwd });
        setGitInfo(info);
      } catch { /* ignore */ }
    };
    fetchGitInfo();
    const interval = setInterval(fetchGitInfo, 10000);
    return () => clearInterval(interval);
  }, [threadDetail?.cwd, threadGroups]);

  const refreshThreadDetail = useCallback(async (threadId: string) => {
    try {
      const result = await clientRef.current.readThread(threadId, true);
      const merged = mergeThreadDetailWithLocalState(threadDetailRef.current, result);
      if (selectedThreadRef.current === threadId) {
        setThreadDetail(merged);
        setIsAgentActive(merged.status?.type === 'active');
      }
      return merged;
    } catch {
      return null;
    }
  }, []);

  const startPolling = useCallback((threadId: string) => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    const poll = async () => {
      if (selectedThreadRef.current !== threadId) return;
      const detail = await refreshThreadDetail(threadId);
      if (!detail) return;
      const isActive = detail.status?.type === 'active';
      const lastTurn = detail.turns?.[detail.turns.length - 1];
      if (isActive || lastTurn?.status === 'inProgress') {
        pollTimerRef.current = setTimeout(poll, 2000);
      }
    };
    pollTimerRef.current = setTimeout(poll, 1500);
  }, [refreshThreadDetail]);

  const applySelectedThreadEvent = useCallback((method: string, params: Record<string, unknown>) => {
    const selectedId = selectedThreadRef.current;
    if (!selectedId) {
      return;
    }

    const threadId =
      typeof params.threadId === 'string'
        ? params.threadId
        : isObject(params.thread) && typeof params.thread.id === 'string'
        ? params.thread.id
        : undefined;

    if (!threadId || threadId !== selectedId) {
      return;
    }

    setThreadDetail((prev) => applyServerEventToThreadDetail(prev, method, params));
  }, []);

  useEffect(() => {
    return () => { if (pollTimerRef.current) clearTimeout(pollTimerRef.current); };
  }, []);

  useEffect(() => {
    const client = clientRef.current;
    const unsub = client.onStateChange((state) => setConnState(state));
    const unsubNotif = client.onNotification((method, params) => {
      const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
      const selectedId = selectedThreadRef.current;
      const isSelectedThread = !!threadId && threadId === selectedId;

      if (method === 'thread/started' && isObject(params.thread)) {
        const thread = params.thread as ThreadSummary;
        setThreads((prev) => [thread, ...prev.filter((entry) => entry.id !== thread.id)]);
      }

      if (method === 'thread/status/changed') {
        if (threadId) {
          setThreads((prev) =>
            prev.map((thread) =>
              thread.id === threadId ? { ...thread, status: params.status as ThreadSummary['status'] } : thread,
            ),
          );
        }

        applySelectedThreadEvent(method, params);

        if (isSelectedThread && isObject(params.status)) {
          const isActive = params.status.type === 'active';
          setIsAgentActive(isActive);
          if (threadId && isActive) {
            startPolling(threadId);
          }
        }
      }

      const isDeltaEvent =
        method === 'item/agentMessage/delta' ||
        method === 'item/plan/delta' ||
        method === 'command/exec/outputDelta' ||
        method === 'item/reasoning/summaryTextDelta' ||
        method === 'item/reasoning/summaryPartAdded' ||
        method === 'item/reasoning/textDelta' ||
        method === 'item/commandExecution/outputDelta' ||
        method === 'item/commandExecution/terminalInteraction' ||
        method === 'item/fileChange/outputDelta' ||
        method === 'item/mcpToolCall/progress' ||
        method === 'thread/realtime/outputAudio/delta';

      const isStructuralEvent =
        method === 'thread/name/updated' ||
        method === 'turn/started' ||
        method === 'turn/completed' ||
        method === 'hook/started' ||
        method === 'hook/completed' ||
        method === 'turn/diff/updated' ||
        method === 'item/started' ||
        method === 'item/completed' ||
        method === 'rawResponseItem/completed' ||
        method === 'turn/plan/updated' ||
        method === 'thread/realtime/started' ||
        method === 'thread/realtime/itemAdded' ||
        method === 'thread/realtime/error' ||
        method === 'thread/realtime/closed' ||
        method === 'thread/compacted' ||
        method === 'error';

      if (isStructuralEvent) {
        applySelectedThreadEvent(method, params);
      } else if (isDeltaEvent && isSelectedThread) {
        pendingDeltaEventsRef.current.push({ method, params });
        if (!deltaFlushScheduledRef.current) {
          deltaFlushScheduledRef.current = true;
          requestAnimationFrame(() => {
            deltaFlushScheduledRef.current = false;
            const events = pendingDeltaEventsRef.current;
            if (events.length === 0) return;
            pendingDeltaEventsRef.current = [];
            const selectedId = selectedThreadRef.current;
            if (!selectedId) return;
            setThreadDetail((prev) => {
              let state = prev;
              for (const ev of events) {
                state = applyServerEventToThreadDetail(state, ev.method, ev.params);
              }
              return state;
            });
          });
        }
      }

      if (method === 'turn/started') {
        const turn = isObject(params.turn) ? params.turn : null;
        if (turn && typeof turn.id === 'string') {
          activeTurnIdRef.current = turn.id;
        }
        if (isSelectedThread) {
          setIsAgentActive(true);
          if (threadId) {
            startPolling(threadId);
          }
        }
      }

      if (method === 'turn/completed') {
        const turn = isObject(params.turn) ? params.turn : null;
        const turnStatus = turn && typeof turn.status === 'string' ? turn.status : 'completed';
        activeTurnIdRef.current = null;

        if (isSelectedThread) {
          setIsAgentActive(false);
        }

        appWindow
          .isFocused()
          .then((focused) => {
            if (!focused) {
              sendNotification({
                title: 'Codex',
                body: `Turn ${turnStatus}`,
              });
            }
          })
          .catch(() => {});
      }

      if (method === 'thread/tokenUsage/updated' && isSelectedThread && isObject(params.tokenUsage)) {
        const tokenUsage = params.tokenUsage;
        const total = isObject(tokenUsage.total) && typeof tokenUsage.total.totalTokens === 'number'
          ? tokenUsage.total.totalTokens
          : 0;
        const modelContextWindow =
          typeof tokenUsage.modelContextWindow === 'number' ? tokenUsage.modelContextWindow : null;

        if (modelContextWindow && modelContextWindow > 0) {
          const percent = Math.max(0, Math.min(100, Math.round((1 - total / modelContextWindow) * 100)));
          setContextUsage({ percent, usedTokens: total });
        }
      }

      if (method === 'serverRequest/resolved') {
        const requestId = typeof params.requestId === 'number' ? params.requestId : null;
        if (requestId != null) {
          setApprovals((prev) => prev.filter((request) => request.requestId !== requestId));
          setUserInputRequests((prev) => prev.filter((request) => request.requestId !== requestId));
          setMcpElicitationRequests((prev) => prev.filter((request) => request.requestId !== requestId));
          setDynamicToolCallRequests((prev) => prev.filter((request) => request.requestId !== requestId));
          setAuthRefreshRequests((prev) => prev.filter((request) => request.requestId !== requestId));
        }
      }

      if (method === 'thread/name/updated' || method === 'thread/archived' || method === 'thread/unarchived') {
        clientRef.current
          .listThreads({ limit: 50, archived: showArchivedRef.current })
          .then((result) => {
            setThreads(result.data);
            setNextCursor(result.nextCursor);
          })
          .catch(() => {});

        if (threadId && threadId === selectedThreadRef.current) {
          const shouldClearSelection =
            (method === 'thread/archived' && !showArchivedRef.current) ||
            (method === 'thread/unarchived' && showArchivedRef.current);

          if (shouldClearSelection) {
            setSelectedThread(null);
            setThreadDetail(null);
            setIsAgentActive(false);
          }
        }
      }

      if (method === 'thread/closed') {
        if (threadId) {
          setThreads((prev) => prev.filter((thread) => thread.id !== threadId));
          setPendingMessages((prev) => prev.filter((message) => message.threadId !== threadId));
        }

        if (threadId && threadId === selectedThreadRef.current) {
          setSelectedThread(null);
          setThreadDetail(null);
          setIsAgentActive(false);
        }
      }

      if (method === 'account/updated') {
        void refreshAccountInfo();
      }

      if (method === 'account/login/completed') {
        const success = params.success === true;
        const errorMessage = typeof params.error === 'string' ? params.error : null;
        if (success) {
          void refreshAccountInfo();
          setToast({ msg: 'Account login completed.', type: 'info' });
        } else if (errorMessage) {
          setToast({ msg: `Account login failed: ${errorMessage}`, type: 'error' });
        }
      }

      if (method === 'hook/completed' && isObject(params.run)) {
        const status = typeof params.run.status === 'string' ? params.run.status : 'completed';
        const eventName = typeof params.run.eventName === 'string' ? params.run.eventName : 'hook';
        if (status === 'failed' || status === 'blocked' || status === 'stopped') {
          const statusMessage =
            typeof params.run.statusMessage === 'string' && params.run.statusMessage
              ? `: ${params.run.statusMessage}`
              : '';
          setToast({ msg: `Hook ${eventName} ${status}${statusMessage}`, type: 'error' });
        }
      }

      if (method === 'account/rateLimits/updated') {
        const snapshot = toRateLimitSnapshot(params.rateLimits);
        if (snapshot) {
          setRateLimits(snapshot);
        }
      }

      if (method === 'mcpServer/oauthLogin/completed') {
        const serverName = typeof params.name === 'string' ? params.name : 'MCP server';
        const success = params.success === true;
        const errorMessage = typeof params.error === 'string' ? params.error : null;
        void refreshMcpServers();
        setToast({
          msg: success
            ? `MCP OAuth completed for ${serverName}.`
            : `MCP OAuth failed for ${serverName}${errorMessage ? `: ${errorMessage}` : ''}`,
          type: success ? 'info' : 'error',
        });
      }

      if (method === 'skills/changed') {
        if (sidebarViewRef.current === 'skills' || skillsRef.current.length > 0) {
          void refreshSkills();
        }
        setToast({ msg: 'Local skills changed. Skill metadata refreshed.', type: 'info' });
      }

      if (method === 'error' && isObject(params.error) && typeof params.error.message === 'string') {
        setToast({
          msg: params.willRetry === true ? `Agent error, retrying: ${params.error.message}` : `Agent error: ${params.error.message}`,
          type: 'error',
        });
      }

      if (method === 'model/rerouted') {
        const fromModel = typeof params.fromModel === 'string' ? params.fromModel : 'unknown';
        const toModel = typeof params.toModel === 'string' ? params.toModel : 'unknown';
        const reason = typeof params.reason === 'string' ? params.reason : null;
        setToast({
          msg: `Model rerouted: ${fromModel} -> ${toModel}${reason ? ` (${reason})` : ''}.`,
          type: 'info',
        });
      }

      if (method === 'deprecationNotice' && typeof params.summary === 'string') {
        const details = typeof params.details === 'string' && params.details.trim() ? ` ${params.details.trim()}` : '';
        setToast({ msg: `${params.summary}${details}`, type: 'info' });
      }

      if (method === 'configWarning' && typeof params.summary === 'string') {
        const details = typeof params.details === 'string' && params.details.trim() ? ` ${params.details.trim()}` : '';
        const path = typeof params.path === 'string' ? ` (${params.path})` : '';
        setToast({ msg: `${params.summary}${path}${details}`, type: 'error' });
      }

      if (method === 'app/list/updated' && Array.isArray(params.data)) {
        setToast({ msg: `App list updated (${params.data.length} app${params.data.length === 1 ? '' : 's'}).`, type: 'info' });
      }

      if (method === 'fuzzyFileSearch/sessionUpdated') {
        const query = typeof params.query === 'string' ? params.query : 'search';
        const count = Array.isArray(params.files) ? params.files.length : 0;
        setToast({ msg: `Fuzzy search "${query}" updated (${count} result${count === 1 ? '' : 's'}).`, type: 'info' });
      }

      if (method === 'fuzzyFileSearch/sessionCompleted') {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : 'unknown';
        setToast({ msg: `Fuzzy search session completed (${sessionId}).`, type: 'info' });
      }

      if (method === 'thread/realtime/started') {
        const sessionId = typeof params.sessionId === 'string' && params.sessionId ? ` (${params.sessionId})` : '';
        setToast({ msg: `Realtime session started${sessionId}.`, type: 'info' });
      }

      if (method === 'thread/realtime/error' && typeof params.message === 'string') {
        setToast({ msg: `Realtime error: ${params.message}`, type: 'error' });
      }

      if (method === 'thread/realtime/closed') {
        const reason = typeof params.reason === 'string' && params.reason ? `: ${params.reason}` : '';
        setToast({ msg: `Realtime session closed${reason}`, type: 'info' });
      }

      if (method === 'windows/worldWritableWarning') {
        const count = Array.isArray(params.samplePaths) ? params.samplePaths.length : 0;
        const extraCount = typeof params.extraCount === 'number' ? params.extraCount : 0;
        const suffix = extraCount > 0 ? ` (+${extraCount} more)` : '';
        const failedScan = params.failedScan === true ? ' Scan incomplete.' : '';
        setToast({ msg: `World-writable Windows paths detected (${count}${suffix}).${failedScan}`, type: 'error' });
      }

      if (method === 'windowsSandbox/setupCompleted') {
        const mode = typeof params.mode === 'string' ? params.mode : 'windows-sandbox';
        const success = params.success === true;
        const errorMessage = typeof params.error === 'string' ? params.error : null;
        setToast({
          msg: success ? `Windows sandbox setup completed (${mode}).` : `Windows sandbox setup failed (${mode})${errorMessage ? `: ${errorMessage}` : ''}`,
          type: success ? 'info' : 'error',
        });
      }
    });
    const unsubRequest = client.onServerRequest((request) => {
      const params = (request.params ?? {}) as Record<string, unknown>;

      if (request.method === 'item/commandExecution/requestApproval' || request.method === 'execCommandApproval') {
        const approval: ApprovalRequest = {
          requestId: request.id,
          method: request.method,
          threadId: typeof params.threadId === 'string' ? params.threadId : '',
          turnId: typeof params.turnId === 'string' ? params.turnId : '',
          itemId: typeof params.itemId === 'string' ? params.itemId : undefined,
          toolName: typeof params.toolName === 'string' ? params.toolName : undefined,
          command: typeof params.command === 'string' ? params.command : undefined,
          description:
            typeof params.reason === 'string'
              ? params.reason
              : typeof params.description === 'string'
              ? params.description
              : undefined,
          kind: 'exec',
          permissions: flattenPermissionLabels(params.additionalPermissions),
          rawPermissions: isObject(params.additionalPermissions) ? params.additionalPermissions : undefined,
          availableDecisions: Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined,
        };
        setApprovals((prev) => [...prev.filter((entry) => entry.requestId !== approval.requestId), approval]);
        return;
      }

      if (request.method === 'item/fileChange/requestApproval' || request.method === 'applyPatchApproval') {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        const turnId = typeof params.turnId === 'string' ? params.turnId : '';
        const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
        const threadItem = findThreadItem(threadDetailRef.current, turnId, itemId);
        const diff =
          typeof params.diff === 'string'
            ? params.diff
            : threadItem?.changes
                ?.map((change) => change.diff)
                .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
                .join('\n\n');

        const approval: ApprovalRequest = {
          requestId: request.id,
          method: request.method,
          threadId,
          turnId,
          itemId,
          description:
            typeof params.reason === 'string'
              ? params.reason
              : typeof params.description === 'string'
              ? params.description
              : undefined,
          kind: 'applyPatch',
          diff,
        };
        setApprovals((prev) => [...prev.filter((entry) => entry.requestId !== approval.requestId), approval]);
        return;
      }

      if (request.method === 'item/permissions/requestApproval') {
        const approval: ApprovalRequest = {
          requestId: request.id,
          method: request.method,
          threadId: typeof params.threadId === 'string' ? params.threadId : '',
          turnId: typeof params.turnId === 'string' ? params.turnId : '',
          itemId: typeof params.itemId === 'string' ? params.itemId : undefined,
          description: typeof params.reason === 'string' ? params.reason : undefined,
          kind: 'permissions',
          permissions: flattenPermissionLabels(params.permissions),
          rawPermissions: isObject(params.permissions) ? params.permissions : {},
        };
        setApprovals((prev) => [...prev.filter((entry) => entry.requestId !== approval.requestId), approval]);
        return;
      }

      if (request.method === 'item/tool/requestUserInput') {
        const questions = toUserInputQuestions(params.questions);
        const req: UserInputRequest = {
          requestId: request.id,
          threadId: typeof params.threadId === 'string' ? params.threadId : '',
          turnId: typeof params.turnId === 'string' ? params.turnId : '',
          questions,
        };
        setUserInputRequests((prev) => [...prev.filter((entry) => entry.requestId !== req.requestId), req]);
        return;
      }

      if (request.method === 'mcpServer/elicitation/request') {
        const elicitation = toMcpElicitationRequest(request.id, params);
        if (!elicitation) {
          void clientRef.current
            .rejectServerRequest(request.id, 'Invalid MCP elicitation request payload', -32602)
            .catch(() => {});
          return;
        }

        setMcpElicitationRequests((prev) => [
          ...prev.filter((entry) => entry.requestId !== elicitation.requestId),
          elicitation,
        ]);
        return;
      }

      if (request.method === 'item/tool/call') {
        const toolCall =
          typeof params.threadId === 'string' &&
          typeof params.turnId === 'string' &&
          typeof params.callId === 'string' &&
          typeof params.tool === 'string'
            ? {
                requestId: request.id,
                threadId: params.threadId,
                turnId: params.turnId,
                callId: params.callId,
                tool: params.tool,
                arguments: params.arguments,
              }
            : null;

        if (!toolCall) {
          void clientRef.current
            .rejectServerRequest(request.id, 'Invalid dynamic tool call payload', -32602)
            .catch(() => {});
          return;
        }

        setDynamicToolCallRequests((prev) => [
          ...prev.filter((entry) => entry.requestId !== toolCall.requestId),
          toolCall,
        ]);
        return;
      }

      if (request.method === 'account/chatgptAuthTokens/refresh') {
        const reason = params.reason === 'unauthorized' ? params.reason : null;
        if (!reason) {
          void clientRef.current
            .rejectServerRequest(request.id, 'Invalid ChatGPT auth refresh payload', -32602)
            .catch(() => {});
          return;
        }

        setAuthRefreshRequests((prev) => [
          ...prev.filter((entry) => entry.requestId !== request.id),
          {
            requestId: request.id,
            reason,
            previousAccountId:
              typeof params.previousAccountId === 'string' ? params.previousAccountId : null,
          },
        ]);
        return;
      }

      void clientRef.current
        .rejectServerRequest(request.id, `Unsupported desktop client request: ${request.method}`, -32601)
        .catch(() => {});
      setToast({ msg: `Unsupported request from Codex: ${request.method}`, type: 'error' });
    });
    return () => { unsub(); unsubNotif(); unsubRequest(); };
  }, [applySelectedThreadEvent, refreshAccountInfo, refreshMcpServers, refreshSkills, startPolling]);

  const refreshCodexConfig = useCallback(async () => {
    try {
      const config = await clientRef.current.readConfig() as Record<string, unknown>;
      setCodexConfig(config);
      return config;
    } catch {
      return null;
    }
  }, []);

  const resolveLegacyCollabConfigPath = useCallback(async (options?: {
    configSnapshot?: Record<string, unknown> | null;
    fallbackPath?: string | null;
    force?: boolean;
  }): Promise<string | null> => {
    const snapshot = options?.configSnapshot ?? codexConfig ?? await refreshCodexConfig();
    if (!options?.force && (!snapshot || !hasLegacyCollabFeature(snapshot))) {
      return null;
    }

    return getLegacyCollabConfigPath(snapshot, options?.fallbackPath);
  }, [codexConfig, refreshCodexConfig]);

  const startThreadWithConfigRecovery = useCallback(async (params?: { cwd?: string }) => {
    try {
      return await clientRef.current.startThread(params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isLegacyCollabConfigError(msg)) {
        throw err;
      }

      const configPath = await resolveLegacyCollabConfigPath({
        fallbackPath: extractLegacyCollabConfigPathFromError(msg),
        force: true,
      });
      throw new Error(
        configPath
          ? `请删除 ${configPath} 中已废弃的 [features].collab，只保留 [features].multi_agent。`
          : '请删除用户本地 config.toml 中已废弃的 [features].collab，只保留 [features].multi_agent。',
      );
    }
  }, [resolveLegacyCollabConfigPath]);

  const writeConfigValueWithFallback = useCallback(async (primaryKey: string, fallbackKey: string | null, value: unknown) => {
    try {
      await clientRef.current.writeConfigValue(primaryKey, value);
    } catch (primaryErr) {
      if (!fallbackKey) throw primaryErr;
      await clientRef.current.writeConfigValue(fallbackKey, value);
    }
  }, []);

  const handleAutonomyModeChange = useCallback(async (nextMode: string) => {
    if (isUpdatingAutonomy) return;
    if (nextMode === 'custom') {
      setToast({ msg: 'Custom mode reflects a non-standard approval/sandbox combination. Edit config.toml if you need a bespoke setup.', type: 'info' });
      return;
    }
    if (!(nextMode in AUTONOMY_PRESETS)) return;
    if (nextMode === autonomyMode) return;

    const preset = AUTONOMY_PRESETS[nextMode as Exclude<AutonomyModeValue, 'custom'>];
    const previousMode = autonomyMode;

    setAutonomyMode(nextMode as AutonomyModeValue);
    setIsUpdatingAutonomy(true);
    try {
      await writeConfigValueWithFallback('approval_policy', 'approvalPolicy', preset.approvalPolicy);
      await writeConfigValueWithFallback('sandbox_mode', 'sandboxMode', preset.sandboxMode);
      const refreshedConfig = await refreshCodexConfig();
      setAutonomyMode(deriveAutonomyModeFromConfig(refreshedConfig));
      setToast({
        msg: `Permission mode updated to ${formatAutonomyModeLabel(nextMode as AutonomyModeValue)}.`,
        type: 'info',
      });
    } catch (err) {
      const refreshedConfig = await refreshCodexConfig();
      setAutonomyMode(refreshedConfig ? deriveAutonomyModeFromConfig(refreshedConfig) : previousMode);
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to update permission mode: ${msg}`, type: 'error' });
    } finally {
      setIsUpdatingAutonomy(false);
    }
  }, [autonomyMode, isUpdatingAutonomy, refreshCodexConfig, writeConfigValueWithFallback]);

  const autonomyOptions = useMemo(() => {
    const baseOptions = [
      { value: 'suggest', label: 'Suggest' },
      { value: 'auto-edit', label: 'Auto Edit' },
      { value: 'full-auto', label: 'Full Auto' },
    ];
    return autonomyMode === 'custom'
      ? [...baseOptions, { value: 'custom', label: 'Custom' }]
      : baseOptions;
  }, [autonomyMode]);

  const handleConnect = async (connectUrl?: string) => {
    try {
      await clientRef.current.connect(connectUrl ?? url, { autoReconnect: true });
      const result = await clientRef.current.listThreads({ limit: 50 });
      setThreads(result.data);
      setNextCursor(result.nextCursor);
      let availableModels: ModelInfo[] = [];
      try {
        const m = await clientRef.current.listModels();
        availableModels = m;
        setModels(m);
      } catch { /* models optional */ }
      try {
        await refreshAccountInfo();
      } catch { /* account optional */ }
      try {
        await refreshMcpServers();
      } catch { /* mcp optional */ }
      const config = await refreshCodexConfig();
      const configuredModel = getStringConfigValue(config, 'model');
      if (configuredModel && availableModels.some((model) => model.id === configuredModel)) {
        setSelectedModel(configuredModel);
      } else {
        const defaultModel = availableModels.find((model) => model.isDefault);
        if (defaultModel) setSelectedModel(defaultModel.id);
      }
    } catch { /* handled by state listener */ }
  };

  // 自动连接：应用启动时无感连接，无需用户手动操作
  useEffect(() => {
    void handleConnect(url);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDisconnect = () => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    clientRef.current.disconnect();
    setThreads([]);
    setSelectedThread(null);
    setThreadDetail(null);
    setModels([]);
    setIsSending(false);
    setIsAgentActive(false);
    setSidebarView('threads');
    setApprovals([]);
    setUserInputRequests([]);
    setMcpElicitationRequests([]);
    setDynamicToolCallRequests([]);
    setAuthRefreshRequests([]);
    setPendingMessages([]);
    setNextCursor(null);
    setAccountInfo(null);
    setRateLimits(null);
    setCodexConfig(null);
    setIsUpdatingAutonomy(false);
    activeTurnIdRef.current = null;
  };

  const handleListThreads = useCallback(async () => {
    try {
      const result = await clientRef.current.listThreads({ limit: 50, archived: showArchived });
      setThreads(result.data);
      setNextCursor(result.nextCursor);
    } catch { /* ignore */ }
  }, [showArchived]);

  const applyNewThreadSelection = useCallback((thread: ThreadSummary, fallbackCwd?: string) => {
    const initialDetail = { ...thread, turns: [] } as ThreadDetail;
    selectedThreadRef.current = thread.id;
    threadDetailRef.current = initialDetail;
    setThreadLoadError(null);
    setIsThreadLoading(false);
    setSidebarView('threads');
    setSelectedThread(thread.id);
    setThreadDetail(initialDetail);
    if (thread.cwd || fallbackCwd) {
      setActiveProjectCwd(thread.cwd ?? fallbackCwd ?? null);
    }
    void handleListThreads();
    setTimeout(() => textareaRef.current?.focus(), 100);
  }, [handleListThreads]);

  useEffect(() => {
    if (connState === 'connected') handleListThreads();
  }, [showArchived, connState, handleListThreads]);

  const handleLoadMoreThreads = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await clientRef.current.listThreads({ limit: 50, cursor: nextCursor, archived: showArchived });
      setThreads((prev) => [...prev, ...result.data]);
      setNextCursor(result.nextCursor);
    } catch { /* ignore */ }
    setLoadingMore(false);
  };

  const handleReadThread = async (id: string) => {
    selectedThreadRef.current = id;
    threadDetailRef.current = null;
    pendingDeltaEventsRef.current = [];
    setSelectedThread(id);
    setOverlayView(null);
    setSidebarView('threads');
    setShowRawJson(false);
    setIsAgentActive(false);
    setThreadLoadError(null);
    setIsThreadLoading(true);
    setThreadDetail(null);
    try {
      const result = await refreshThreadDetail(id);
      if (!result) {
        throw new Error('Failed to load thread');
      }
      if (result.cwd) setActiveProjectCwd(result.cwd);
      const active = result.status?.type === 'active';
      setIsAgentActive(active);
      if (active) startPolling(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (selectedThreadRef.current === id) {
        setThreadLoadError(msg);
      }
    } finally {
      if (selectedThreadRef.current === id) {
        setIsThreadLoading(false);
      }
    }
    try {
      const config = await getChatConfig(id);
      if (config) {
        if (config.model) setSelectedModel(config.model);
        if (config.reasoning) setReasoning(config.reasoning as ReasoningLevel);
      }
    } catch { /* ignore */ }
  };

  const handleNewThread = useCallback(async (cwd?: string) => {
    if (connState !== 'connected') {
      setToast({ msg: 'Not connected to Codex server', type: 'error' });
      return;
    }
    setSidebarView('threads');
    try {
      const targetCwd = cwd ?? activeProjectCwd ?? undefined;
      const params = targetCwd ? { cwd: targetCwd } : undefined;
      const thread = await startThreadWithConfigRecovery(params);
      if (!thread?.id) {
        setToast({ msg: 'Failed to create thread', type: 'error' });
        return;
      }
      applyNewThreadSelection(thread, targetCwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `New thread failed: ${msg}`, type: 'error' });
    }
  }, [activeProjectCwd, applyNewThreadSelection, connState, startThreadWithConfigRecovery]);

  const handleOpenInExplorer = async (cwd: string) => {
    try {
      await invoke('open_in_explorer', { path: cwd });
    } catch { /* ignore */ }
    setFolderMenu(null);
  };

  const handleAddProject = async () => {
    try {
      const selected = await invoke<string | null>('pick_folder');
      if (selected) {
        const normalized = selected.replace(/\\/g, '/').replace(/\/$/, '');
        const alreadyExists = addedProjects.some(p => p.replace(/\\/g, '/').replace(/\/$/, '') === normalized);
        if (!alreadyExists) {
          setAddedProjects([...addedProjects, selected]);
        }
        setActiveProjectCwd(selected);
      }
    } catch { /* ignore */ }
  };

  const handleRemoveProject = (cwd: string) => {
    const normalized = cwd.replace(/\\/g, '/').replace(/\/$/, '');
    setAddedProjects(addedProjects.filter(p => p.replace(/\\/g, '/').replace(/\/$/, '') !== normalized));
    setFolderMenu(null);
  };

  const handleRemoveFolder = (cwd: string) => {
    setThreads(prev => prev.filter(t => t.cwd !== cwd));
    setFolderMenu(null);
  };

  const handleRenameFolder = (cwd: string) => {
    setRenamingFolder(cwd);
    setFolderMenu(null);
  };

  const handleSaveFolderAlias = (cwd: string, alias: string) => {
    const trimmed = alias.trim();
    if (trimmed) {
      setFolderAlias({ ...folderAlias, [cwd]: trimmed });
    } else {
      const next = { ...folderAlias };
      delete next[cwd];
      setFolderAlias(next);
    }
    setRenamingFolder(null);
  };

  const enqueuePendingMessage = useCallback((threadId: string, text: string) => {
    const id = `pending-${threadId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPendingMessages((prev) => [...prev, { id, threadId, text }]);
  }, []);

  const handleSendMessage = useCallback(async (text: string): Promise<boolean> => {
    if (!selectedThread || !threadDetail) return false;
    setIsSending(true);
    setThreadDetail((prev) => {
      if (!prev) return prev;
      const optimisticItem = {
        type: 'userMessage' as const,
        id: `optimistic-${Date.now()}`,
        content: [{ type: 'text', text }],
      };
      const turns = prev.turns ? [...prev.turns] : [];
      const optimisticTurn = {
        id: `optimistic-turn-${Date.now()}`,
        status: 'inProgress' as const,
        items: [optimisticItem],
      };
      turns.push(optimisticTurn);
      return { ...prev, turns };
    });
    try {
      const opts: { model?: string; reasoningEffort?: string } = {};
      if (selectedModel) opts.model = selectedModel;
      if (reasoning) opts.reasoningEffort = reasoning;
      const startedTurn = await clientRef.current.startTurn(selectedThread, text, opts);
      activeTurnIdRef.current = startedTurn.id;
      setThreadDetail((prev) =>
        applyServerEventToThreadDetail(prev, 'turn/started', {
          threadId: selectedThread,
          turn: startedTurn,
        } as Record<string, unknown>),
      );
      setIsAgentActive(true);
      startPolling(selectedThread);
      return true;
    } catch (err) {
      await refreshThreadDetail(selectedThread);
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Send failed: ${msg}`, type: 'error' });
      return false;
    }
    finally { setIsSending(false); }
  }, [selectedThread, threadDetail, selectedModel, reasoning, startPolling, refreshThreadDetail]);

  const handleInterrupt = useCallback(async () => {
    if (!selectedThread) return;
    const turnId = activeTurnIdRef.current;
    const lastTurn = threadDetail?.turns?.[threadDetail.turns.length - 1];
    const tid = turnId ?? lastTurn?.id;
    if (!tid) return;
    try {
      await clientRef.current.interruptTurn(selectedThread, tid);
      setIsAgentActive(false);
    } catch { /* ignore */ }
  }, [selectedThread, threadDetail]);

  const handleApproval = useCallback(async (request: ApprovalRequest, decision: ApprovalDecision) => {
    try {
      if (request.method === 'item/permissions/requestApproval') {
        if (decision === 'accept' || decision === 'acceptForSession') {
          await clientRef.current.respondToPermissionsRequest(
            request.requestId,
            request.rawPermissions ?? {},
            decision === 'acceptForSession' ? 'session' : 'turn',
          );
        } else {
          await clientRef.current.respondToPermissionsRequest(request.requestId, {}, 'turn');
        }
      } else {
        await clientRef.current.respondToApproval(request.requestId, decision);
      }
    } catch { /* ignore */ }
    setApprovals((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
  }, []);

  useEffect(() => {
    const handleKeyboard = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        if (connState === 'connected') void handleNewThread();
      }
      if (e.key === 'Escape') {
        if (editingName) setEditingName(false);
      }
        const activeApproval = approvals.find((approval) => approval.threadId === selectedThread);
        if (activeApproval && !editingName && !(document.activeElement instanceof HTMLTextAreaElement) && !(document.activeElement instanceof HTMLInputElement)) {
          if (e.key === 'y' || e.key === 'Y') {
            e.preventDefault();
            void handleApproval(activeApproval, 'accept');
          } else if (e.key === 'a' || e.key === 'A') {
            e.preventDefault();
            void handleApproval(activeApproval, 'acceptForSession');
          } else if (e.key === 'n' || e.key === 'N') {
            e.preventDefault();
            void handleApproval(activeApproval, 'decline');
          }
        }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>('.sidebar-search-input');
        searchInput?.focus();
      }
      if (e.key === '?' && !editingName && !(document.activeElement instanceof HTMLTextAreaElement) && !(document.activeElement instanceof HTMLInputElement)) {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, [approvals, connState, editingName, handleApproval, handleNewThread, selectedThread]);

  const handleArchiveThread = useCallback(async (threadId: string) => {
    try {
      await clientRef.current.archiveThread(threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setPendingMessages((prev) => prev.filter((message) => message.threadId !== threadId));
      if (selectedThread === threadId) {
        setSelectedThread(null);
        setThreadDetail(null);
      }
    } catch { /* ignore */ }
  }, [selectedThread]);

  const handleRenameThread = useCallback(async () => {
    if (!selectedThread || !editNameValue.trim()) return;
    try {
      await clientRef.current.setThreadName(selectedThread, editNameValue.trim());
      setEditingName(false);
      await refreshThreadDetail(selectedThread);
      await handleListThreads();
    } catch { /* ignore */ }
  }, [selectedThread, editNameValue, refreshThreadDetail, handleListThreads]);

  const handleRollback = useCallback(async (numTurns: number) => {
    if (!selectedThread) return;
    try {
      const result = await clientRef.current.rollbackThread(selectedThread, numTurns);
      setThreadDetail(result);
    } catch { /* ignore */ }
  }, [selectedThread]);

  const handleForkThread = useCallback(async () => {
    if (!selectedThread) return;
    try {
      const forked = await clientRef.current.forkThread(selectedThread, { model: selectedModel || undefined });
      await handleListThreads();
      setSelectedThread(forked.id);
      setThreadDetail(forked);
      setSidebarView('threads');
    } catch { /* ignore */ }
  }, [selectedThread, selectedModel, handleListThreads]);

  const handleThreadContextMenu = useCallback((e: React.MouseEvent, threadId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setThreadCtxMenu({ threadId, x: e.clientX, y: e.clientY });
  }, []);

  const handlePinThread = useCallback((threadId: string) => {
    setPinnedThreads(
      pinnedThreads.includes(threadId)
        ? pinnedThreads.filter((id) => id !== threadId)
        : [...pinnedThreads, threadId]
    );
    setThreadCtxMenu(null);
  }, [pinnedThreads, setPinnedThreads]);

  const handleCtxRenameThread = useCallback(async (threadId: string) => {
    setThreadCtxMenu(null);
    if (selectedThread !== threadId) {
      await handleReadThread(threadId);
    }
    const t = threadsRef.current.find((t) => t.id === threadId);
    setEditNameValue(t?.name || t?.preview || '');
    setEditingName(true);
  }, [selectedThread, handleReadThread]);

  const handleCtxArchiveThread = useCallback(async (threadId: string) => {
    setThreadCtxMenu(null);
    await handleArchiveThread(threadId);
  }, [handleArchiveThread]);

  const handleCtxForkThread = useCallback(async (threadId: string) => {
    setThreadCtxMenu(null);
    if (selectedThread !== threadId) {
      await handleReadThread(threadId);
    }
    await handleForkThread();
  }, [selectedThread, handleReadThread, handleForkThread]);

  const handleShellCommand = useCallback(async (command: string) => {
    if (!selectedThread) return;
    try {
      await clientRef.current.runShellCommand(selectedThread, command);
      startPolling(selectedThread);
    } catch { /* ignore */ }
  }, [selectedThread, startPolling]);

  const handleCompactThread = useCallback(async () => {
    if (!selectedThread) return;
    try {
      await clientRef.current.startThreadCompaction(selectedThread);
      startPolling(selectedThread);
    } catch { /* ignore */ }
  }, [selectedThread, startPolling]);

  const handleCommitChanges = useCallback(async () => {
    if (!selectedThread || !threadDetail) return;
    const text = 'Please review the current changes, propose a commit message, and ask for confirmation before running git commit.';
    setInputText(text);
    setToast({ msg: 'Commit helper now prepares a safe prompt instead of committing immediately.', type: 'info' });
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = text.length;
      el.selectionEnd = text.length;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    });
  }, [selectedThread, threadDetail]);

  const handleStartNewThreadWithMessage = useCallback(async (text: string) => {
    try {
      const params = activeProjectCwd ? { cwd: activeProjectCwd } : undefined;
      const thread = await startThreadWithConfigRecovery(params);
      if (!thread?.id) {
        setToast({ msg: 'Failed to create thread: no ID returned', type: 'error' });
        return;
      }
      applyNewThreadSelection(thread, activeProjectCwd ?? undefined);

      const optimisticUserItem = {
        type: 'userMessage' as const,
        id: `optimistic-user-${Date.now()}`,
        content: [{ type: 'text', text }],
      };
      const optimisticTurn = {
        id: `optimistic-turn-${Date.now()}`,
        status: 'inProgress' as const,
        items: [optimisticUserItem],
      };
      setThreadDetail({ ...thread, turns: [optimisticTurn] } as ThreadDetail);
      threadDetailRef.current = { ...thread, turns: [optimisticTurn] } as ThreadDetail;
      setIsAgentActive(true);
      if (thread.cwd) setActiveProjectCwd(thread.cwd);

      const opts: { model?: string; reasoningEffort?: string } = {};
      if (selectedModel) opts.model = selectedModel;
      if (reasoning) opts.reasoningEffort = reasoning;
      const startedTurn = await clientRef.current.startTurn(thread.id, text, opts);
      activeTurnIdRef.current = startedTurn.id;
      setThreadDetail((prev) =>
        applyServerEventToThreadDetail(prev, 'turn/started', {
          threadId: thread.id,
          turn: startedTurn,
        } as Record<string, unknown>),
      );
      startPolling(thread.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Send failed: ${msg}`, type: 'error' });
      setIsAgentActive(false);
    }
  }, [selectedModel, reasoning, startPolling, applyNewThreadSelection, activeProjectCwd, startThreadWithConfigRecovery]);

  const handleUserInputResponse = useCallback(async (requestId: number, answers: Array<{ selectedOptions?: number[]; notes?: string }>) => {
    const request = userInputRequests.find((entry) => entry.requestId === requestId);
    try {
      if (request) {
        const payload = Object.fromEntries(
          request.questions.map((question, index) => {
            const answer = answers[index];
            const selectedLabels = (answer?.selectedOptions ?? [])
              .filter((selectedIndex) => selectedIndex >= 0)
              .map((selectedIndex) => question.options?.[selectedIndex]?.label)
              .filter((label): label is string => typeof label === 'string' && label.length > 0);

            const notes = answer?.notes?.trim();
            const values = notes ? [...selectedLabels, notes] : selectedLabels;

            return [question.id, { answers: values }];
          }),
        );

        await clientRef.current.respondToUserInput(requestId, payload);
      }
      setUserInputRequests((prev) => prev.filter((r) => r.requestId !== requestId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to submit user input: ${msg}`, type: 'error' });
    }
  }, [userInputRequests]);

  const handleUserInputCancel = useCallback(async (requestId: number) => {
    try {
      await clientRef.current.rejectServerRequest(requestId, 'User cancelled input request', -32000);
      setUserInputRequests((prev) => prev.filter((request) => request.requestId !== requestId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to cancel user input request: ${msg}`, type: 'error' });
    }
  }, []);

  const handleMcpElicitationResponse = useCallback(async (
    request: McpElicitationRequest,
    response: { action: 'accept' | 'decline' | 'cancel'; content: unknown },
  ) => {
    try {
      await clientRef.current.respondToMcpElicitation(
        request.requestId,
        response.action,
        response.content,
        request.meta ?? null,
      );
      setMcpElicitationRequests((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to respond to MCP elicitation: ${msg}`, type: 'error' });
    }
  }, []);

  const handleDynamicToolCallResponse = useCallback(async (
    request: DynamicToolCallRequest,
    response: {
      contentItems: DynamicToolCallContentItem[];
      success: boolean;
    },
  ) => {
    try {
      await clientRef.current.respondToDynamicToolCall(request.requestId, response.contentItems, response.success);
      setDynamicToolCallRequests((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to respond to dynamic tool call: ${msg}`, type: 'error' });
    }
  }, []);

  const handleDynamicToolCallReject = useCallback(async (request: DynamicToolCallRequest) => {
    try {
      await clientRef.current.rejectServerRequest(request.requestId, 'Dynamic tool call rejected by desktop user', -32000);
      setDynamicToolCallRequests((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to reject dynamic tool call: ${msg}`, type: 'error' });
    }
  }, []);

  const handleAuthRefreshResponse = useCallback(async (
    request: AuthRefreshRequest,
    response: ChatgptAuthTokensRefreshResponse,
  ) => {
    try {
      await clientRef.current.respondToChatgptAuthTokensRefresh(request.requestId, response);

      let nextAccount: AccountInfo = {
        type: 'chatgptAuthTokens',
        planType: response.chatgptPlanType ?? undefined,
      };

      try {
        const { account } = await clientRef.current.readAccount();
        if (account) {
          nextAccount = account;
        }
      } catch {
        /* best effort */
      }

      setAccountInfo(nextAccount);
      setAuthRefreshRequests((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
      setToast({ msg: 'ChatGPT auth tokens refreshed.', type: 'info' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to refresh ChatGPT auth tokens: ${msg}`, type: 'error' });
    }
  }, []);

  const handleAuthRefreshReject = useCallback(async (request: AuthRefreshRequest) => {
    try {
      await clientRef.current.rejectServerRequest(request.requestId, 'ChatGPT auth token refresh rejected by desktop user', -32000);
      setAuthRefreshRequests((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to reject ChatGPT auth refresh: ${msg}`, type: 'error' });
    }
  }, []);

  const handleSendFromBar = async () => {
    const text = inputText.trim();
    if (!text && attachedImages.length === 0) return;
    const finalText = attachedImages.length > 0
      ? `${text}\n\n${attachedImages.map(img => `![${img.name}](${img.dataUrl})`).join('\n')}`.trim()
      : text;
    setMessageHistory(prev => [text, ...prev].slice(0, 50));
    setHistoryIdx(-1);
    setInputText('');
    setAttachedImages([]);
    if (selectedThread && text) { addChatMessage(selectedThread, text).catch(() => {}); }
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    const textForSend = finalText;

    if (textForSend.startsWith('!') && selectedThread) {
      await handleShellCommand(textForSend.slice(1).trim());
      return;
    }

    if (isAgentActive && selectedThread && threadDetail) {
      const activeTurn = threadDetail.turns?.find(t => t.status === 'inProgress');
      if (activeTurn) {
        const optimisticSteerItem: ThreadItem = {
          type: 'userMessage',
          id: `optimistic-steer-${Date.now()}`,
          content: [{ type: 'text', text: textForSend }],
        };
        setThreadDetail((prev) =>
          applyServerEventToThreadDetail(prev, 'item/completed', {
            threadId: selectedThread,
            turnId: activeTurn.id,
            item: optimisticSteerItem,
          } as Record<string, unknown>),
        );
        try {
          await clientRef.current.steerTurn(selectedThread, textForSend, activeTurn.id);
        } catch {
          await refreshThreadDetail(selectedThread);
          enqueuePendingMessage(selectedThread, textForSend);
        }
        return;
      }
    }

    if (isSending && selectedThread) {
      enqueuePendingMessage(selectedThread, textForSend);
      return;
    }
    if (!selectedThread) {
      await handleStartNewThreadWithMessage(textForSend);
      return;
    }
    await handleSendMessage(textForSend);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendFromBar();
    }
    if (isComposingRef.current) return;
    if (e.key === 'ArrowUp' && !inputText && messageHistory.length > 0) {
      e.preventDefault();
      const next = Math.min(historyIdx + 1, messageHistory.length - 1);
      setHistoryIdx(next);
      setInputText(messageHistory[next]);
    }
    if (e.key === 'ArrowDown' && historyIdx >= 0) {
      e.preventDefault();
      const next = historyIdx - 1;
      if (next < 0) {
        setHistoryIdx(-1);
        setInputText('');
      } else {
        setHistoryIdx(next);
        setInputText(messageHistory[next]);
      }
    }
  };

  const handleTextareaInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 240) + 'px';
    }
  };

  const handleImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      setAttachedImages((prev) => [...prev, { dataUrl, name: file.name }]);
    };
    reader.readAsDataURL(file);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find((item) => item.type.startsWith('image/'));
    if (imageItem) {
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (file) handleImageFile(file);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        handleImageFile(file);
      } else if (file.type.startsWith('text/') || file.name.endsWith('.txt') || file.name.endsWith('.md')) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const content = ev.target?.result as string;
          setInputText((prev) => prev + (prev ? '\n' : '') + content);
        };
        reader.readAsText(file);
      }
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        handleImageFile(file);
      } else if (file.type.startsWith('text/') || /\.(txt|md|json|csv|xml|yaml|yml|js|ts|jsx|tsx|py|go|rs|java|c|cpp|h|css|html)$/.test(file.name)) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const content = ev.target?.result as string;
          setInputText((prev) => prev + (prev ? '\n' : '') + `\`\`\`\n${content}\n\`\`\``);
        };
        reader.readAsText(file);
      }
    }
    e.target.value = '';
  };

  const handleSlashButtonClick = () => {
    setInputText('/');
    setSlashOpen(true);
    setSlashIdx(0);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  type PopupItem = { id: string; icon: 'command' | 'skill' | 'file'; name: string; desc: string; badge?: string; action?: () => void; insert?: string };
  type PopupMode = 'slash' | 'mention' | null;

  const builtInCommands: PopupItem[] = useMemo(() => [
    { id: 'cmd-model', icon: 'command', name: 'model', desc: 'Choose model and reasoning effort' },
    { id: 'cmd-skills', icon: 'command', name: 'skills', desc: 'Browse and manage skills' },
    { id: 'cmd-review', icon: 'command', name: 'review', desc: 'Review current changes and find issues' },
    { id: 'cmd-compact', icon: 'command', name: 'compact', desc: 'Summarize conversation to save context' },
    { id: 'cmd-clear', icon: 'command', name: 'clear', desc: 'Clear terminal and start a new chat' },
    { id: 'cmd-rename', icon: 'command', name: 'rename', desc: 'Rename the current thread' },
    { id: 'cmd-diff', icon: 'command', name: 'diff', desc: 'Show git diff including untracked files' },
    { id: 'cmd-status', icon: 'command', name: 'status', desc: 'Show session configuration and token usage' },
    { id: 'cmd-plan', icon: 'command', name: 'plan', desc: 'Switch to Plan mode' },
    { id: 'cmd-fork', icon: 'command', name: 'fork', desc: 'Fork/branch this conversation' },
    { id: 'cmd-new', icon: 'command', name: 'new', desc: 'Start a new chat' },
    { id: 'cmd-help', icon: 'command', name: 'help', desc: 'Show available commands and skills' },
  ], []);

  const mentionItems: PopupItem[] = useMemo(() =>
    skills.map(s => ({
      id: `skill-${s.name}`,
      icon: 'skill' as const,
      name: s.name,
      desc: s.path.split('/').pop() || s.path,
      badge: 'Skill',
      insert: `$${s.name}`,
    })),
  [skills]);

  const popupMode: PopupMode = slashOpen
    ? inputText.startsWith('/') ? 'slash'
    : inputText.includes('$') ? 'mention'
    : null
    : null;

  const popupFilter = popupMode === 'slash'
    ? inputText.slice(1).toLowerCase()
    : popupMode === 'mention'
    ? (inputText.match(/\$([^\s]*)$/)?.[1] || '').toLowerCase()
    : '';

  const popupItems: PopupItem[] = useMemo(() => {
    const source = popupMode === 'slash' ? builtInCommands : mentionItems;
    if (!popupFilter) return source;
    return source.filter(item => item.name.toLowerCase().includes(popupFilter) || item.desc.toLowerCase().includes(popupFilter));
  }, [popupMode, builtInCommands, mentionItems, popupFilter]);

  const handleInputChange = (val: string) => {
    setInputText(val);
    const atEnd = val.length > 0;
    if (atEnd && val.startsWith('/') && !val.includes('\n') && val.indexOf(' ') === -1) {
      setSlashOpen(true);
      setSlashIdx(0);
    } else if (atEnd && /\$[^\s]*$/.test(val)) {
      setSlashOpen(true);
      setSlashIdx(0);
    } else {
      setSlashOpen(false);
    }
    handleTextareaInput();
  };

  const handlePopupSelect = (item: PopupItem) => {
    setSlashOpen(false);
    if (item.action) {
      item.action();
      return;
    }
    if (item.insert) {
      const mentionMatch = inputText.match(/\$[^\s]*$/);
      if (mentionMatch) {
        const before = inputText.slice(0, mentionMatch.index!);
        setInputText(`${before}${item.insert} `);
      } else {
        setInputText(`${item.insert} `);
      }
      textareaRef.current?.focus();
      return;
    }
    setInputText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    const cmd = item.name;
    if (cmd === 'model') {
      setShowModelPicker(true);
    } else if (cmd === 'clear' && selectedThread) {
      handleRollback(threadDetail?.turns?.length ?? 0);
    } else if (cmd === 'compact' && selectedThread) {
      handleCompactThread();
    } else if (cmd === 'fork' && selectedThread) {
      handleForkThread();
    } else if (cmd === 'review' && selectedThread) {
      handleSendMessage('/review');
    } else if (cmd === 'diff' && selectedThread) {
      handleSendMessage('/diff');
    } else if (cmd === 'status' && selectedThread) {
      handleSendMessage('/status');
    } else if (cmd === 'rename') {
      setEditingName(true);
      setEditNameValue(threadDetail?.name || threadDetail?.preview || '');
    } else if (cmd === 'skills') {
      setSidebarView('skills');
      void refreshSkills();
    } else if (cmd === 'plan' && selectedThread) {
      handleSendMessage('Switch to planning mode. Analyze the situation and create a detailed plan before making any changes.');
    } else if (cmd === 'new') {
      handleNewThread();
    } else if (cmd === 'help') {
      const helpLines = [
        '**Slash commands** (type /):', '',
        ...builtInCommands.map(c => `  \`/${c.name}\` — ${c.desc}`), '',
        '**Skill mentions** (type $):', '',
        skills.length > 0
          ? skills.map(s => `  \`$${s.name}\``).join(', ')
          : '  No skills loaded. Connect to Codex and navigate to a project.', '',
        '**Shell commands** (type !):', '',
        '  `!command` — Execute a shell command in the thread context (e.g. `!ls -la`)',
      ];
      setThreadDetail(prev => {
        if (!prev) return prev;
        const helpItem = { type: 'agentMessage' as const, id: `help-${Date.now()}`, content: [{ type: 'text', text: helpLines.join('\n') }] };
        const turns = prev.turns ? [...prev.turns] : [];
        turns.push({ id: `help-turn-${Date.now()}`, status: 'completed' as const, items: [helpItem] });
        return { ...prev, turns };
      });
    }
  };

  const handleSlashKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!slashOpen || popupItems.length === 0) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSlashIdx(i => (i + 1) % popupItems.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSlashIdx(i => (i - 1 + popupItems.length) % popupItems.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      handlePopupSelect(popupItems[slashIdx]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setSlashOpen(false);
      return true;
    }
    return false;
  };

  const toggleGroup = (cwd: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  };

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const lastTurn = threadDetail?.turns?.[threadDetail.turns.length - 1];
  const displayedThread = threadDetail ?? (isThreadLoading ? lastResolvedThreadDetail : null);
  const selectedThreadSummary = selectedThread
    ? threads.find((thread) => thread.id === selectedThread) ?? null
    : null;
  const isShowingPreviousThreadWhileLoading =
    isThreadLoading &&
    !!selectedThread &&
    !!displayedThread &&
    displayedThread.id !== selectedThread;
  const isProcessing = !isShowingPreviousThreadWhileLoading && (isSending || isAgentActive || lastTurn?.status === 'inProgress');
  const selectedThreadPendingMessages = selectedThread
    ? pendingMessages.filter((message) => message.threadId === selectedThread)
    : [];
  const canSubmitInput = inputText.trim().length > 0;
  const composerDisabled = isShowingPreviousThreadWhileLoading;
  const composerPlaceholder = composerDisabled
    ? 'Loading selected thread...'
    : isProcessing
      ? 'Send a follow-up while Codex keeps working...'
      : 'Message Codex... (/ commands, $ skills)';
  const statusHint = selectedThreadPendingMessages.length > 0
    ? `Queued ${selectedThreadPendingMessages.length} follow-up${selectedThreadPendingMessages.length === 1 ? '' : 's'}`
    : isProcessing
      ? 'Enter to follow up, Esc to interrupt'
      : null;
  const autonomyDetail = autonomyMode === 'custom' ? getAutonomyModeSummary(codexConfig) : null;

  useEffect(() => {
    if (isProcessing || !selectedThread) return;

    const nextPending = pendingMessages.find((message) => message.threadId === selectedThread);
    if (!nextPending || lastAutoFlushedPendingIdRef.current === nextPending.id) return;

    lastAutoFlushedPendingIdRef.current = nextPending.id;
    let cancelled = false;

    void (async () => {
      const sent = await handleSendMessage(nextPending.text);
      if (cancelled) return;

      if (sent) {
        setPendingMessages((prev) => prev.filter((message) => message.id !== nextPending.id));
        lastAutoFlushedPendingIdRef.current = null;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [handleSendMessage, isProcessing, pendingMessages, selectedThread]);

  const rightSidebarEl = rightSidebarOpen ? (
    <RightSidebar
      cwd={activeProjectCwd}
      activeTab={rightSidebarTab}
      onTabChange={setRightSidebarTab}
      onOverlayView={setOverlayView}
      onInsertPrompt={(text) => {
        setInputText(text);
        textareaRef.current?.focus();
      }}
      width={rightSidebarWidth}
      onWidthChange={setRightSidebarWidth}
    />
  ) : null;

  return (
    <>
      <div className="app-layout">
        {/* Sidebar */}
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          <nav className="sidebar-nav">
            <button
              className="sidebar-nav-btn"
              onClick={() => { setSelectedThread(null); setThreadDetail(null); setSidebarView('threads'); }}
              disabled={connState !== 'connected'}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <line x1="8" y1="3" x2="8" y2="13" />
                <line x1="3" y1="8" x2="13" y2="8" />
              </svg>
              New Thread
            </button>
            <button
              className={`sidebar-nav-btn${sidebarView === 'automations' ? ' sidebar-nav-btn--active' : ''}`}
              onClick={() => { setSidebarView('automations'); }}
              disabled={connState !== 'connected'}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2v4l2.5 1.5" />
                <circle cx="8" cy="8" r="6" />
              </svg>
              Automations
            </button>
            <button
              className={`sidebar-nav-btn${sidebarView === 'skills' ? ' sidebar-nav-btn--active' : ''}`}
              onClick={async () => {
                setSidebarView('skills');
                await refreshSkills();
              }}
              disabled={connState !== 'connected'}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="5" height="5" rx="1" />
                <rect x="9" y="2" width="5" height="5" rx="1" />
                <rect x="2" y="9" width="5" height="5" rx="1" />
                <rect x="9" y="9" width="5" height="5" rx="1" />
              </svg>
              Skills
            </button>
            <button
              className={`sidebar-nav-btn${sidebarView === 'history' ? ' sidebar-nav-btn--active' : ''}`}
              onClick={() => setSidebarView('history')}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6" />
                <polyline points="8,5 8,8 10.5,10" />
              </svg>
              History
            </button>
          </nav>

          <div className="sidebar-divider" />

          <div className="sidebar-threads-header">
            <span className="sidebar-threads-label">Threads</span>
            <div className="sidebar-threads-actions">
              <button
                className="sidebar-icon-btn"
                onClick={handleAddProject}
                title="Add project folder"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
                  <line x1="8" y1="8" x2="8" y2="12" />
                  <line x1="6" y1="10" x2="10" y2="10" />
                </svg>
              </button>
              <button
                className={`sidebar-icon-btn${showArchived ? ' sidebar-icon-btn--active' : ''}`}
                onClick={() => setShowArchived(!showArchived)}
                title={showArchived ? 'Show active threads' : 'Show archived threads'}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="12" height="3" rx="1" />
                  <path d="M3 6v6a1 1 0 001 1h8a1 1 0 001-1V6" />
                  <path d="M6.5 9h3" />
                </svg>
              </button>
              <button
                className="sidebar-icon-btn"
                onClick={handleListThreads}
                title="Refresh threads"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2.5 8a5.5 5.5 0 0 1 9.3-4" strokeLinecap="round" />
                  <path d="M13.5 8a5.5 5.5 0 0 1-9.3 4" strokeLinecap="round" />
                  <polyline points="12,2 12,5 9,5" strokeLinecap="round" strokeLinejoin="round" />
                  <polyline points="4,14 4,11 7,11" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>

          {connState === 'connected' && (
            <div className="sidebar-search">
              <svg className="sidebar-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="7" cy="7" r="5" />
                <path d="M11 11l3.5 3.5" />
              </svg>
              <input
                className="sidebar-search-input"
                value={threadSearch}
                onChange={(e) => setThreadSearch(e.target.value)}
                placeholder="Search threads... (Ctrl+K)"
              />
              {threadSearch && (
                <button className="sidebar-search-clear" onClick={() => setThreadSearch('')}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="2" y1="2" x2="8" y2="8" />
                    <line x1="8" y1="2" x2="2" y2="8" />
                  </svg>
                </button>
              )}
            </div>
          )}

          <div className="sidebar-thread-list">
            {threads.length === 0 && connState === 'connected' && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                No threads yet.
              </div>
            )}

            {pinnedThreads.length > 0 && (() => {
              const pinned = threads.filter(t => pinnedThreads.includes(t.id));
              if (pinned.length === 0) return null;
              return (
                <div className="thread-group">
                  <div className="pinned-group-header">
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828 1a1 1 0 01.707.293l4.172 4.172a1 1 0 010 1.414l-1.586 1.586a1 1 0 01-1.414 0l-.464-.464-2.828 2.828.929.929a1 1 0 010 1.414l-.707.707a1 1 0 01-1.414 0L7 12.243l-3.536 3.536a1 1 0 01-1.414-1.414L5.586 11 4.172 9.586a1 1 0 010-1.414l.707-.707a1 1 0 011.414 0l.929.929 2.828-2.828-.464-.464a1 1 0 010-1.414l1.586-1.586A1 1 0 019.828 1z"/></svg>
                    已固定
                  </div>
                  {pinned.map((t) => (
                    <button
                      key={t.id}
                      className={`sidebar-thread-item sidebar-thread-item--ungrouped thread-item--pinned${selectedThread === t.id ? ' sidebar-thread-item--active' : ''}`}
                      onClick={() => handleReadThread(t.id)}
                      onContextMenu={(e) => handleThreadContextMenu(e, t.id)}
                    >
                      <div className="sidebar-thread-info">
                        <div className="sidebar-thread-name">
                          {t.status?.type === 'active' && <span className="active-dot" />}
                          {t.name || t.preview || 'Untitled'}
                        </div>
                      </div>
                      <span className="sidebar-thread-time">
                        {formatRelativeTime(t.updatedAt ?? t.createdAt)}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })()}

            {threadGroups.map((group) => {
              if (!group.folder) {
                return group.threads.map((t) => (
                  <button
                    key={t.id}
                    className={`sidebar-thread-item sidebar-thread-item--ungrouped${selectedThread === t.id ? ' sidebar-thread-item--active' : ''}`}
                    onClick={() => handleReadThread(t.id)}
                    onContextMenu={(e) => handleThreadContextMenu(e, t.id)}
                  >
                    <div className="sidebar-thread-info">
                      <div className="sidebar-thread-name">
                        {t.status?.type === 'active' && <span className="active-dot" />}
                        {t.name || t.preview || 'Untitled'}
                      </div>
                    </div>
                    <span className="sidebar-thread-time">
                      {formatRelativeTime(t.updatedAt ?? t.createdAt)}
                    </span>
                  </button>
                ));
              }

              const isCollapsed = collapsedGroups.has(group.cwd);
              const displayName = folderAlias[group.cwd] || group.folder;
              return (
                <div key={group.cwd} className="thread-group">
                  <div className="thread-group-header">
                    <button className="thread-group-toggle" onClick={() => toggleGroup(group.cwd)}>
                      <svg
                        className={`thread-group-chevron${isCollapsed ? '' : ' thread-group-chevron--open'}`}
                        width="10" height="10" viewBox="0 0 10 10" fill="none"
                        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                      >
                        <path d="M3 1.5l4 3.5-4 3.5" />
                      </svg>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
                      </svg>
                      {renamingFolder === group.cwd ? (
                        <input
                          className="thread-group-rename"
                          autoFocus
                          defaultValue={displayName}
                          onBlur={e => handleSaveFolderAlias(group.cwd, e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleSaveFolderAlias(group.cwd, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenamingFolder(null); }}
                          onClick={e => e.stopPropagation()}
                        />
                      ) : (
                        <span className="thread-group-name">{displayName}</span>
                      )}
                    </button>
                    <div className="thread-group-actions">
                      <button className="thread-group-action-btn" onClick={e => { e.stopPropagation(); handleNewThread(group.cwd); }} title="New thread in this folder">
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="6" y1="2" x2="6" y2="10" /><line x1="2" y1="6" x2="10" y2="6" /></svg>
                      </button>
                      <button
                        className="thread-group-action-btn"
                        onClick={e => { e.stopPropagation(); setFolderMenu(folderMenu?.cwd === group.cwd ? null : { cwd: group.cwd, x: e.clientX, y: e.clientY }); }}
                        title="More actions"
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                          <circle cx="6" cy="2.5" r="1" /><circle cx="6" cy="6" r="1" /><circle cx="6" cy="9.5" r="1" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  {!isCollapsed && group.threads.map((t) => (
                    <button
                      key={t.id}
                      className={`sidebar-thread-item${selectedThread === t.id ? ' sidebar-thread-item--active' : ''}${pinnedThreads.includes(t.id) ? ' thread-item--pinned' : ''}`}
                      onClick={() => handleReadThread(t.id)}
                      onContextMenu={(e) => handleThreadContextMenu(e, t.id)}
                    >
                      <div className="sidebar-thread-info">
                        <div className="sidebar-thread-name">
                          {t.status?.type === 'active' && <span className="active-dot" />}
                          {t.name || t.preview || 'Untitled'}
                        </div>
                      </div>
                      <span className="sidebar-thread-time">
                        {formatRelativeTime(t.updatedAt ?? t.createdAt)}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
            {nextCursor && (
              <button
                className="sidebar-load-more"
                onClick={handleLoadMoreThreads}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading...' : 'Load more threads'}
              </button>
            )}
          </div>

          {folderMenu && (
            <>
              <div className="ctx-backdrop" onClick={() => setFolderMenu(null)} />
              <div className="ctx-menu" style={{ top: folderMenu.y, left: Math.min(folderMenu.x, 220) }}>
                <button className="ctx-menu-item" onClick={() => handleOpenInExplorer(folderMenu.cwd)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
                  </svg>
                  Open in Explorer
                </button>
                <button className="ctx-menu-item" onClick={() => { handleNewThread(folderMenu.cwd); setFolderMenu(null); }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 8h8M8 4v8" />
                  </svg>
                  New Thread
                </button>
                <div className="ctx-menu-sep" />
                <button className="ctx-menu-item" onClick={() => handleRenameFolder(folderMenu.cwd)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11.5 1.5l3 3L5 14H2v-3z" />
                  </svg>
                  Rename
                </button>
                <button className="ctx-menu-item ctx-menu-item--danger" onClick={() => handleRemoveProject(folderMenu.cwd)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 5h10M5.5 5V3.5a1 1 0 011-1h3a1 1 0 011 1V5M6.5 7.5v4M9.5 7.5v4" />
                    <path d="M4 5l.7 8.4a1 1 0 001 .9h4.6a1 1 0 001-.9L12 5" />
                  </svg>
                  Remove Project
                </button>
                <button className="ctx-menu-item ctx-menu-item--danger" onClick={() => handleRemoveFolder(folderMenu.cwd)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 5h12" />
                    <path d="M4 5v8a1 1 0 001 1h6a1 1 0 001-1V5" />
                  </svg>
                  Hide Until Refresh
                </button>
              </div>
            </>
          )}

          {threadCtxMenu && (
            <>
              <div className="ctx-backdrop" onClick={() => setThreadCtxMenu(null)} />
              <div className="ctx-menu" style={{ top: Math.min(threadCtxMenu.y, window.innerHeight - 200), left: Math.min(threadCtxMenu.x, window.innerWidth - 180) }}>
                <button className="ctx-menu-item" onClick={() => handleCtxRenameThread(threadCtxMenu.threadId)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3z" /></svg>
                  重命名
                </button>
                <button className="ctx-menu-item" onClick={() => handlePinThread(threadCtxMenu.threadId)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828 1a1 1 0 01.707.293l4.172 4.172a1 1 0 010 1.414l-1.586 1.586a1 1 0 01-1.414 0l-.464-.464-2.828 2.828.929.929a1 1 0 010 1.414l-.707.707a1 1 0 01-1.414 0L7 12.243l-3.536 3.536a1 1 0 01-1.414-1.414L5.586 11 4.172 9.586a1 1 0 010-1.414l.707-.707a1 1 0 011.414 0l.929.929 2.828-2.828-.464-.464a1 1 0 010-1.414l1.586-1.586A1 1 0 019.828 1z"/></svg>
                  {pinnedThreads.includes(threadCtxMenu.threadId) ? '取消置顶' : '置顶'}
                </button>
                <button className="ctx-menu-item" onClick={() => handleCtxForkThread(threadCtxMenu.threadId)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3a2 2 0 100 4 2 2 0 000-4zM11 3a2 2 0 100 4 2 2 0 000-4zM5 9a2 2 0 100 4 2 2 0 000-4zM5 7v2M11 7c0 2-2 3-4 3" /></svg>
                  Fork
                </button>
                <div className="ctx-menu-divider" />
                <button className="ctx-menu-item ctx-menu-item--danger" onClick={() => handleCtxArchiveThread(threadCtxMenu.threadId)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4h12v1.5a1 1 0 01-1 1H3a1 1 0 01-1-1V4zM4 6.5v6a1 1 0 001 1h6a1 1 0 001-1v-6" /><path d="M6.5 9h3" /></svg>
                  归档
                </button>
              </div>
            </>
          )}

          <div className="sidebar-footer">
            <button
              className={`sidebar-footer-btn${sidebarView === 'settings' ? ' sidebar-footer-btn--active' : ''}`}
              onClick={() => { setSidebarView('settings'); }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="8" cy="8" r="2.5" />
                <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M3.1 12.9l1.4-1.4M11.5 4.5l1.4-1.4" strokeLinecap="round" />
              </svg>
              Settings
            </button>
          </div>
          <div className="sidebar-resize-handle" onMouseDown={handleSidebarResizeStart} />
        </aside>

        {/* Main Content */}
        <main className="main-content">
          {sidebarView === 'settings' && <WindowControls className="window-controls--floating" />}
          {sidebarView === 'settings' ? (
            <SettingsView url={url} onUrlChange={setUrl} connState={connState} accountInfo={accountInfo} rateLimits={rateLimits} mcpServers={mcpServers} client={clientRef.current} theme={theme} onThemeChange={setTheme} codexConfig={codexConfig} onWriteConfig={async (key, value) => { await writeConfigValueWithFallback(key, null, value); await refreshCodexConfig(); }} />
          ) : sidebarView === 'automations' ? (
            <AutomationsView />
          ) : sidebarView === 'skills' ? (
            <SkillsView skills={skills} onRefresh={async () => {
              await refreshSkills();
            }} />
          ) : sidebarView === 'history' ? (
            <HistoryPanel
              entries={historyEntries}
              searchQuery={historySearchQuery}
              onSearchChange={setHistorySearchQuery}
              threads={threads}
              onSelectMessage={(msg) => {
                setInputText(msg);
                setSidebarView('threads');
                setTimeout(() => textareaRef.current?.focus(), 100);
              }}
            />
          ) : overlayView ? (
            <CodeViewer
              overlay={overlayView}
              onClose={() => setOverlayView(null)}
              extraToolbarRight={
                <>
                  <button className={`toolbar-icon-btn${rightSidebarOpen ? ' toolbar-icon-btn--active' : ''}`} onClick={() => setRightSidebarOpen(!rightSidebarOpen)} title={rightSidebarOpen ? 'Close sidebar' : 'Open sidebar'}>
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><line x1="10" y1="2.5" x2="10" y2="13.5" /></svg>
                  </button>
                  <div className="toolbar-divider" />
                  <WindowControls />
                </>
              }
              sidebar={rightSidebarEl}
            />
          ) : displayedThread ? (
            <>
              {/* Top toolbar */}
              <div className="thread-toolbar" data-tauri-drag-region>
                <div className="thread-toolbar-left">
                  {editingName ? (
                    <div className="thread-rename-row">
                      <input
                        className="thread-rename-input"
                        value={editNameValue}
                        onChange={(e) => setEditNameValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleRenameThread(); if (e.key === 'Escape') setEditingName(false); }}
                        autoFocus
                        placeholder="Thread name..."
                      />
                      <button className="btn-small" onClick={handleRenameThread}>Save</button>
                      <button className="btn-small" onClick={() => setEditingName(false)}>Cancel</button>
                    </div>
                  ) : (
                    <button
                      className="thread-toolbar-title"
                      onClick={() => {
                        if (!threadDetail || isShowingPreviousThreadWhileLoading) return;
                        setEditNameValue(threadDetail.name || '');
                        setEditingName(true);
                      }}
                      title="Click to rename"
                      disabled={!threadDetail || isShowingPreviousThreadWhileLoading}
                    >
                      {displayedThread.name || displayedThread.preview || 'New Thread'}
                    </button>
                  )}
                </div>
                <div className="thread-toolbar-right">
                  {isProcessing ? (
                    <button className="toolbar-btn toolbar-btn--stop" onClick={handleInterrupt} title="Stop agent">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                        <rect x="3" y="3" width="8" height="8" rx="1.5" />
                      </svg>
                    </button>
                  ) : (
                    <button
                      className="toolbar-btn toolbar-btn--run"
                      onClick={() => {
                        if (!threadDetail) return;
                        if (threadDetail.status?.type !== 'active') {
                          clientRef.current.resumeThread(threadDetail.id).then(() => {
                            refreshThreadDetail(threadDetail.id);
                          }).catch(() => {});
                        }
                      }}
                      title="Resume thread"
                      disabled={!threadDetail || isShowingPreviousThreadWhileLoading || threadDetail.status?.type === 'active'}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                        <path d="M3.5 2l8 5-8 5z" />
                      </svg>
                    </button>
                  )}
                  <button
                    className="toolbar-btn toolbar-btn--commit"
                    onClick={handleCommitChanges}
                    title="Commit changes"
                    disabled={isProcessing || !threadDetail || isShowingPreviousThreadWhileLoading}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="7" cy="7" r="2.5" />
                      <line x1="7" y1="0" x2="7" y2="4.5" />
                      <line x1="7" y1="9.5" x2="7" y2="14" />
                    </svg>
                    <span>Commit</span>
                  </button>
                  <button
                    className="toolbar-icon-btn"
                    onClick={handleForkThread}
                    title="Fork thread"
                    disabled={!threadDetail || isShowingPreviousThreadWhileLoading}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="5" cy="4" r="2" />
                      <circle cx="11" cy="4" r="2" />
                      <circle cx="8" cy="13" r="2" />
                      <path d="M5 6v2c0 2 3 3 3 3M11 6v2c0 2-3 3-3 3" />
                    </svg>
                  </button>
                  <button
                    className="toolbar-icon-btn"
                    onClick={() => setShowRawJson(!showRawJson)}
                    title={showRawJson ? 'Chat View' : 'Terminal output'}
                    disabled={isShowingPreviousThreadWhileLoading}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                      <path d="M4.5 6l2.5 2-2.5 2" />
                      <line x1="8.5" y1="10" x2="11.5" y2="10" />
                    </svg>
                  </button>
                  <button
                    className="toolbar-icon-btn"
                    onClick={() => handleRollback(1)}
                    title="Undo last turn"
                    disabled={!threadDetail?.turns?.length || isShowingPreviousThreadWhileLoading}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 8a5 5 0 019-3" />
                      <path d="M13 8a5 5 0 01-9 3" />
                      <polyline points="11,3 12,5 10,6" />
                    </svg>
                  </button>
                  <button
                    className="toolbar-icon-btn"
                    onClick={() => threadDetail && handleArchiveThread(threadDetail.id)}
                    title="Archive thread"
                    disabled={!threadDetail || isShowingPreviousThreadWhileLoading}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="12" height="3" rx="1" />
                      <path d="M3 6v6a1 1 0 001 1h8a1 1 0 001-1V6" />
                      <path d="M6.5 9h3" />
                    </svg>
                  </button>
                  {gitInfo && (gitInfo.addedLines > 0 || gitInfo.removedLines > 0) && (
                    <span className="toolbar-diff-stats">
                      {gitInfo.addedLines > 0 && <span className="diff-added">+{gitInfo.addedLines.toLocaleString()}</span>}
                      {gitInfo.removedLines > 0 && <span className="diff-removed">-{gitInfo.removedLines.toLocaleString()}</span>}
                    </span>
                  )}
                  <button
                    className={`toolbar-icon-btn${rightSidebarOpen ? ' toolbar-icon-btn--active' : ''}`}
                    onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
                    title={rightSidebarOpen ? 'Close sidebar' : 'Open sidebar'}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                      <line x1="10" y1="2.5" x2="10" y2="13.5" />
                    </svg>
                  </button>
                  <div className="toolbar-divider" />
                  <WindowControls />
                </div>
              </div>

              <div className="main-content-body">
                <div className="main-content-primary">
              {/* Approval overlay */}
              {approvals.filter((a) => a.threadId === selectedThread).map((a) => (
                <div key={a.requestId} className="approval-overlay-card">
                  <div className="approval-overlay-header">
                    <span className="approval-overlay-icon">
                      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--status-warning)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 2L2 16h14L9 2z" />
                        <line x1="9" y1="7" x2="9" y2="11" />
                        <circle cx="9" cy="13.5" r="0.5" fill="var(--status-warning)" />
                      </svg>
                    </span>
                    <span className="approval-overlay-title">
                      {a.kind === 'applyPatch' ? 'Apply file changes?' :
                       a.kind === 'permissions' ? 'Grant permissions?' :
                       a.kind === 'mcpElicitation' ? 'MCP server approval' :
                       a.command ? 'Run this command?' : 'Approval required'}
                    </span>
                  </div>
                  {a.command && (
                    <div className="approval-overlay-command">
                      <code>{a.command}</code>
                    </div>
                  )}
                  {a.description && (
                    <div className="approval-overlay-desc">{a.description}</div>
                  )}
                  {a.diff && (
                    <div className="approval-overlay-diff">
                      <pre>{a.diff}</pre>
                    </div>
                  )}
                  {a.permissions && a.permissions.length > 0 && (
                    <div className="approval-overlay-permissions">
                      {a.permissions.map((p, i) => (
                        <span key={i} className="approval-perm-tag">{p}</span>
                      ))}
                    </div>
                  )}
                  <div className="approval-overlay-actions">
                    <button className="btn-approve" onClick={() => handleApproval(a, 'accept')}>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3,7 6,10 11,4" />
                      </svg>
                      Approve
                    </button>
                    <button className="btn-approve-session" onClick={() => handleApproval(a, 'acceptForSession')}>Always Approve</button>
                    <button className="btn-decline" onClick={() => handleApproval(a, 'decline')}>Decline</button>
                  </div>
                  <div className="approval-overlay-hint">
                    <kbd>Y</kbd> approve &nbsp; <kbd>A</kbd> always &nbsp; <kbd>N</kbd> decline
                  </div>
                </div>
              ))}

              {/* User input request modal */}
              {userInputRequests.filter(r => r.threadId === selectedThread).map((req) => (
                <UserInputModal
                  key={req.requestId}
                  request={req}
                  onSubmit={handleUserInputResponse}
                  onCancel={() => { void handleUserInputCancel(req.requestId); }}
                />
              ))}

              {mcpElicitationRequests.filter((request) => request.threadId === selectedThread).map((request) => (
                <McpElicitationModal
                  key={request.requestId}
                  request={request}
                  onSubmit={handleMcpElicitationResponse}
                />
              ))}

              {dynamicToolCallRequests.filter((request) => request.threadId === selectedThread).map((request) => (
                <DynamicToolCallModal
                  key={request.requestId}
                  request={request}
                  onSubmit={handleDynamicToolCallResponse}
                  onReject={handleDynamicToolCallReject}
                />
              ))}

              {authRefreshRequests.map((request) => (
                <AuthRefreshModal
                  key={request.requestId}
                  request={request}
                  onSubmit={handleAuthRefreshResponse}
                  onReject={handleAuthRefreshReject}
                />
              ))}

              {isShowingPreviousThreadWhileLoading && (
                <div className="thread-loading-banner">
                  <span className="thread-loading-banner-dot" />
                  <span className="thread-loading-banner-text">
                    Loading {selectedThreadSummary?.name || selectedThreadSummary?.preview || 'selected thread'}...
                  </span>
                </div>
              )}

              <ThreadView
                thread={displayedThread}
                isSending={isShowingPreviousThreadWhileLoading ? false : isSending}
                isAgentActive={isShowingPreviousThreadWhileLoading ? false : isAgentActive}
                showRawJson={showRawJson}
                onToggleRawJson={() => setShowRawJson(!showRawJson)}
                overrideIsProcessing={isShowingPreviousThreadWhileLoading ? false : undefined}
              />
              {selectedThreadPendingMessages.length > 0 && isProcessing && (
                <div className="pending-input-preview">
                  <span className="pending-input-label">Queued messages ({selectedThreadPendingMessages.length}):</span>
                  {selectedThreadPendingMessages.slice(0, 3).map((message) => (
                    <span key={message.id} className="pending-input-msg">
                      {message.text.length > 60 ? message.text.slice(0, 60) + '...' : message.text}
                    </span>
                  ))}
                  {selectedThreadPendingMessages.length > 3 && <span className="pending-input-more">+{selectedThreadPendingMessages.length - 3} more</span>}
                </div>
              )}
              {showScrollBtn && (
                <button
                  className="scroll-to-bottom-btn"
                  onClick={() => {
                    const el = messagesContainerRef.current;
                    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                  }}
                  title="滚动到底部"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="7" y1="2" x2="7" y2="12" />
                    <polyline points="3,8 7,12 11,8" />
                  </svg>
                </button>
              )}
              {isProcessing && (
                <div className="status-indicator">
                  <span className="status-indicator-dot" />
                  <span className="status-indicator-text">Working</span>
                  <span className="status-indicator-time">{elapsedSec > 0 ? `${elapsedSec}s` : ''}</span>
                  {contextUsage && (
                    <span className="status-indicator-context">
                      {contextUsage.percent}% context left
                    </span>
                  )}
                  {statusHint && <span className="status-indicator-hint">{statusHint}</span>}
                </div>
              )}
              <div className="bottom-bar">
                <div className="bottom-bar-input">
                  {slashOpen && popupItems.length > 0 && (
                    <div className="slash-popup">
                      <div className="slash-popup-header">{popupMode === 'slash' ? 'Commands' : 'Skills & Mentions'}</div>
                      <div className="slash-popup-list">
                        {popupItems.map((item, i) => (
                          <button
                            key={item.id}
                            className={`slash-popup-item${i === slashIdx ? ' slash-popup-item--active' : ''}`}
                            onMouseEnter={() => setSlashIdx(i)}
                            onClick={() => handlePopupSelect(item)}
                          >
                            <span className={`slash-popup-icon${item.icon === 'skill' ? ' slash-popup-icon--skill' : ''}`}>
                              {item.icon === 'command' ? (
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="4,6 8,10 12,6" />
                                </svg>
                              ) : (
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--accent-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                  <rect x="2" y="2" width="5" height="5" rx="1" />
                                  <rect x="9" y="2" width="5" height="5" rx="1" />
                                  <rect x="2" y="9" width="5" height="5" rx="1" />
                                  <rect x="9" y="9" width="5" height="5" rx="1" />
                                </svg>
                              )}
                            </span>
                            <span className="slash-popup-info">
                              <span className="slash-popup-name">{popupMode === 'slash' ? '/' : '$'}{item.name}</span>
                              <span className="slash-popup-desc">{item.desc}</span>
                            </span>
                            {item.badge && <span className="slash-popup-badge">{item.badge}</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {attachedImages.length > 0 && (
                    <div className="attached-images-preview">
                      {attachedImages.map((img, idx) => (
                        <div key={idx} className="attached-image-thumb">
                          <img src={img.dataUrl} alt={img.name} />
                          <button className="attached-image-remove" onClick={() => setAttachedImages(prev => prev.filter((_, i) => i !== idx))}>
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={textareaRef}
                    className="bottom-bar-textarea"
                    value={inputText}
                    onChange={(e) => handleInputChange(e.target.value)}
                    onKeyDown={(e) => { if (!handleSlashKeyDown(e)) handleInputKeyDown(e); }}
                    onCompositionStart={() => { isComposingRef.current = true; }}
                    onCompositionEnd={() => { isComposingRef.current = false; }}
                    onPaste={handlePaste}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleDrop}
                    placeholder={composerPlaceholder}
                    disabled={composerDisabled}
                    rows={1}
                    title="Enter 发送 · Shift+Enter 换行"
                  />
                  {inputText.length > 500 && (
                    <span className="char-count">{inputText.length}</span>
                  )}
                  <div className="bottom-bar-actions">
                    <button
                      className={`bottom-bar-send${canSubmitInput ? ' bottom-bar-send--active' : ''}`}
                      onClick={handleSendFromBar}
                      disabled={!canSubmitInput || composerDisabled}
                      title={isProcessing ? 'Send follow-up' : 'Send'}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    {isProcessing && (
                      <button
                        className="bottom-bar-send bottom-bar-send--stop"
                        onClick={handleInterrupt}
                        title="Stop"
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                          <rect x="2" y="2" width="10" height="10" rx="2" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
                <div className="bottom-bar-controls">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,text/*,.txt,.md,.json,.csv,.xml,.yaml,.yml,.js,.ts,.jsx,.tsx,.py,.go,.rs,.java,.c,.cpp,.h,.css,.html,.pdf"
                    multiple
                    style={{ display: 'none' }}
                    onChange={handleFileSelect}
                  />
                  <button
                    className="bb-icon-btn"
                    onClick={() => fileInputRef.current?.click()}
                    title="添加文件或图片"
                    disabled={composerDisabled}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13.5 9.5v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-3" />
                      <polyline points="10.5,5 8,2.5 5.5,5" />
                      <line x1="8" y1="2.5" x2="8" y2="10.5" />
                    </svg>
                  </button>
                  <button
                    className="bb-icon-btn"
                    onClick={handleSlashButtonClick}
                    title="插入斜杠命令"
                    disabled={composerDisabled}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="10" y1="3" x2="6" y2="13" />
                    </svg>
                  </button>
                  {models.length > 0 && (
                    <CustomSelect
                      value={selectedModel}
                      options={models.map(m => ({ value: m.id, label: m.displayName }))}
                      onChange={setSelectedModel}
                      title="Model"
                    />
                  )}
                  <CustomSelect
                    value={reasoning}
                    options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'X-High' }]}
                    onChange={v => setReasoning(v as ReasoningLevel)}
                    title="Reasoning"
                  />
                  <div className="bottom-bar-spacer" />
                  <span className="bottom-bar-label">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
                      <rect x="1" y="1" width="8" height="8" rx="1.5" />
                    </svg>
                    Codex
                  </span>
                  <CustomSelect
                    value={autonomyMode}
                    options={autonomyOptions}
                    onChange={handleAutonomyModeChange}
                    title="Permission mode"
                    compact
                  />
                  {isUpdatingAutonomy && (
                    <span className="bottom-bar-label">Saving mode...</span>
                  )}
                  {!isUpdatingAutonomy && autonomyDetail && (
                    <span className="bottom-bar-label">{autonomyDetail}</span>
                  )}
                  <span className="bottom-bar-label">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 1v3" />
                      <path d="M5 6v3" />
                      <path d="M2 7l3-3 3 3" />
                    </svg>
                    {gitInfo?.branch || displayedThread.gitInfo?.branch || 'master'}
                  </span>
                  {contextUsage && (
                    <span className={`bottom-bar-label bottom-bar-context${contextUsage.percent < 20 ? ' bottom-bar-context--low' : ''}`}>
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.2" />
                        <path d={`M5 5 L5 1 A4 4 0 ${contextUsage.percent > 50 ? 1 : 0} 1 ${5 + 4 * Math.sin(2 * Math.PI * (100 - contextUsage.percent) / 100)} ${5 - 4 * Math.cos(2 * Math.PI * (100 - contextUsage.percent) / 100)} Z`} fill="currentColor" opacity="0.4" />
                      </svg>
                      {contextUsage.percent}% ctx
                    </span>
                  )}
                </div>
              </div>
                </div>
                {rightSidebarEl}
              </div>
            </>
          ) : selectedThread ? (
            isThreadLoading ? (
              <div className="tv-container">
                <div className="thread-toolbar" data-tauri-drag-region>
                  <div className="thread-toolbar-left">
                    <div className="skeleton-line skeleton-line--medium" style={{ height: 14 }} />
                  </div>
                  <div className="thread-toolbar-right">
                    <button className={`toolbar-icon-btn${rightSidebarOpen ? ' toolbar-icon-btn--active' : ''}`} onClick={() => setRightSidebarOpen(!rightSidebarOpen)} title={rightSidebarOpen ? 'Close sidebar' : 'Open sidebar'}>
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><line x1="10" y1="2.5" x2="10" y2="13.5" /></svg>
                    </button>
                    <div className="toolbar-divider" />
                    <WindowControls />
                  </div>
                </div>
                <div className="main-content-body">
                  <div className="main-content-primary">
                    <div className="tv-messages">
                      {[1, 2, 3].map(i => (
                        <div key={i} className="skeleton-row">
                          <div className="skeleton-avatar" />
                          <div className="skeleton-block" style={{ flex: 1 }}>
                            <div className={`skeleton-line skeleton-line--${i === 1 ? 'long' : i === 2 ? 'medium' : 'short'}`} />
                            <div className="skeleton-line skeleton-line--long" />
                            <div className="skeleton-line skeleton-line--medium" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {rightSidebarEl}
                </div>
              </div>
            ) : (
              <div className="main-empty">
                <div className="empty-toolbar" data-tauri-drag-region>
                  <div className="empty-toolbar-left">
                    <button className="empty-toolbar-title" onClick={() => { textareaRef.current?.focus(); }}>
                      Thread Unavailable
                    </button>
                  </div>
                  <div className="empty-toolbar-right">
                    <button className={`toolbar-icon-btn${rightSidebarOpen ? ' toolbar-icon-btn--active' : ''}`} onClick={() => setRightSidebarOpen(!rightSidebarOpen)} title={rightSidebarOpen ? 'Close sidebar' : 'Open sidebar'}>
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><line x1="10" y1="2.5" x2="10" y2="13.5" /></svg>
                    </button>
                    <div className="toolbar-divider" />
                    <WindowControls />
                  </div>
                </div>
                <div className="main-content-body">
                  <div className="main-content-primary">
                    <div className="empty-body">
                      <div className="empty-hero">
                        <svg className="empty-logo" width="48" height="48" viewBox="0 0 48 48" fill="none">
                          <path d="M24 4C12.95 4 4 12.95 4 24s8.95 20 20 20 20-8.95 20-20S35.05 4 24 4z" stroke="var(--text-tertiary)" strokeWidth="1.5" />
                          <path d="M24 14v10" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" />
                          <circle cx="24" cy="31" r="2" fill="var(--text-tertiary)" />
                        </svg>
                        <h2 className="empty-title">Unable to open thread</h2>
                        <p className="settings-desc" style={{ maxWidth: 520, textAlign: 'center' }}>
                          {threadLoadError || 'The selected thread could not be loaded. Try refreshing or open it again.'}
                        </p>
                        <button className="btn-primary" onClick={() => void handleReadThread(selectedThread)}>
                          Retry
                        </button>
                      </div>
                    </div>
                  </div>
                  {rightSidebarEl}
                </div>
              </div>
            )
          ) : (
            <div className="main-empty">
              <div className="empty-toolbar" data-tauri-drag-region>
                <div className="empty-toolbar-left">
                  <button className="empty-toolbar-title" onClick={() => { textareaRef.current?.focus(); }}>New Thread</button>
                </div>
                <div className="empty-toolbar-right">
                  <button className={`toolbar-icon-btn${rightSidebarOpen ? ' toolbar-icon-btn--active' : ''}`} onClick={() => setRightSidebarOpen(!rightSidebarOpen)} title={rightSidebarOpen ? 'Close sidebar' : 'Open sidebar'}>
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><line x1="10" y1="2.5" x2="10" y2="13.5" /></svg>
                  </button>
                  <div className="toolbar-divider" />
                  <WindowControls />
                </div>
              </div>

              <div className="main-content-body">
                <div className="main-content-primary">
              <div className="empty-body">
                <div className="empty-hero">
                  <svg className="empty-logo" width="48" height="48" viewBox="0 0 48 48" fill="none">
                    <path d="M24 4C12.95 4 4 12.95 4 24s8.95 20 20 20 20-8.95 20-20S35.05 4 24 4z" stroke="var(--text-tertiary)" strokeWidth="1.5" />
                    <circle cx="17" cy="22" r="2" fill="var(--text-tertiary)" />
                    <circle cx="31" cy="22" r="2" fill="var(--text-tertiary)" />
                    <path d="M17 30c2 3 5 4 7 4s5-1 7-4" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  <h2 className="empty-title">Start Building</h2>
                  {(() => {
                    const projectFolders = threadGroups.filter(g => g.cwd && g.folder);
                    const activeProject = projectFolders.find(g => g.cwd === activeProjectCwd) || projectFolders[0];
                    const activeLabel = activeProject ? (folderAlias[activeProject.cwd] || activeProject.folder) : 'No project';
                    return (
                      <div className="empty-project-wrapper" ref={projectDropdownRef}>
                        <button className="empty-project-btn" onClick={() => { if (projectFolders.length > 0) setProjectDropdownOpen(!projectDropdownOpen); }}>
                          {activeLabel}
                          {projectFolders.length > 0 && (
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 4l2 2 2-2" />
                            </svg>
                          )}
                        </button>
                        {projectDropdownOpen && projectFolders.length > 0 && (
                          <div className="empty-project-menu">
                            {projectFolders.map(g => {
                              const label = folderAlias[g.cwd] || g.folder;
                              const isActive = g.cwd === (activeProjectCwd || projectFolders[0]?.cwd);
                              return (
                                <button
                                  key={g.cwd}
                                  className={`empty-project-option${isActive ? ' empty-project-option--active' : ''}`}
                                  onClick={() => { setActiveProjectCwd(g.cwd); setProjectDropdownOpen(false); }}
                                >
                                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
                                  </svg>
                                  <span>{label}</span>
                                  {isActive && (
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M2.5 6l2.5 2.5 4.5-5" />
                                    </svg>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>

              {connState === 'connected' && (
                <div className="empty-footer">
                  {showSuggestions && (
                    <div className="empty-suggestions">
                      <div className="suggestions-header">
                        <span className="suggestions-header-label">Explore more</span>
                        <button className="suggestions-close" onClick={() => setShowSuggestions(false)}>
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
                          </svg>
                        </button>
                      </div>
                      <div className="suggestion-cards">
                        {[
                          { icon: '🎮', text: 'Build a classic Snake game in this repo.' },
                          { icon: '📄', text: 'Create a one-page $pdf that summarizes this app.' },
                          { icon: '✏️', text: 'Create a plan to refactor the codebase.' },
                        ].map((s, i) => (
                          <button key={i} className="suggestion-card" onClick={() => { setInputText(s.text); textareaRef.current?.focus(); }}>
                            <span className="suggestion-card-icon">{s.icon}</span>
                            <span className="suggestion-card-text">{s.text}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="bottom-bar empty-bottom-bar">
                    <div className="bottom-bar-input">
                      {slashOpen && popupItems.length > 0 && (
                        <div className="slash-popup">
                          <div className="slash-popup-header">{popupMode === 'slash' ? 'Commands' : 'Skills & Mentions'}</div>
                          <div className="slash-popup-list">
                            {popupItems.map((item, i) => (
                              <button
                                key={item.id}
                                className={`slash-popup-item${i === slashIdx ? ' slash-popup-item--active' : ''}`}
                                onMouseEnter={() => setSlashIdx(i)}
                                onClick={() => handlePopupSelect(item)}
                              >
                                <span className={`slash-popup-icon${item.icon === 'skill' ? ' slash-popup-icon--skill' : ''}`}>
                                  {item.icon === 'command' ? (
                                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                      <polyline points="4,6 8,10 12,6" />
                                    </svg>
                                  ) : (
                                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--accent-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                      <rect x="2" y="2" width="5" height="5" rx="1" />
                                      <rect x="9" y="2" width="5" height="5" rx="1" />
                                      <rect x="2" y="9" width="5" height="5" rx="1" />
                                      <rect x="9" y="9" width="5" height="5" rx="1" />
                                    </svg>
                                  )}
                                </span>
                                <span className="slash-popup-info">
                                  <span className="slash-popup-name">{popupMode === 'slash' ? '/' : '$'}{item.name}</span>
                                  <span className="slash-popup-desc">{item.desc}</span>
                                </span>
                                {item.badge && <span className="slash-popup-badge">{item.badge}</span>}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <textarea
                        ref={textareaRef}
                        className="bottom-bar-textarea"
                        value={inputText}
                        onChange={(e) => handleInputChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (handleSlashKeyDown(e)) return;
                          handleInputKeyDown(e);
                        }}
                        onInput={(e) => {
                          const el = e.currentTarget;
                          el.style.height = 'auto';
                          el.style.height = Math.min(el.scrollHeight, 200) + 'px';
                        }}
                        placeholder="Ask Codex anything, @ to add files, / for commands"
                        rows={1}
                      />
                      <button
                        className={`bottom-bar-send${inputText.trim() ? ' bottom-bar-send--active' : ''}`}
                        onClick={handleSendFromBar}
                        disabled={!inputText.trim()}
                        title="Send"
                      >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    </div>
                    <div className="bottom-bar-controls">
                      <button
                        className="bb-icon-btn"
                        onClick={() => fileInputRef.current?.click()}
                        title="添加文件或图片"
                      >
                        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M13.5 9.5v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-3" />
                          <polyline points="10.5,5 8,2.5 5.5,5" />
                          <line x1="8" y1="2.5" x2="8" y2="10.5" />
                        </svg>
                      </button>
                      <button
                        className="bb-icon-btn"
                        onClick={handleSlashButtonClick}
                        title="插入斜杠命令"
                      >
                        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="10" y1="3" x2="6" y2="13" />
                        </svg>
                      </button>
                      {models.length > 0 && (
                        <CustomSelect
                          value={selectedModel}
                          options={models.map(m => ({ value: m.id, label: m.displayName }))}
                          onChange={setSelectedModel}
                          title="Model"
                        />
                      )}
                      <CustomSelect
                        value={reasoning}
                        options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'X-High' }]}
                        onChange={v => setReasoning(v as ReasoningLevel)}
                        title="Reasoning"
                      />
                      <div className="bottom-bar-spacer" />
                      <span className="bottom-bar-label">
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
                          <rect x="1" y="1" width="8" height="8" rx="1.5" />
                        </svg>
                        Codex
                      </span>
                      <CustomSelect
                        value={autonomyMode}
                        options={autonomyOptions}
                        onChange={handleAutonomyModeChange}
                        title="Permission mode"
                        compact
                      />
                      {isUpdatingAutonomy && (
                        <span className="bottom-bar-label">Saving mode...</span>
                      )}
                      {!isUpdatingAutonomy && autonomyDetail && (
                        <span className="bottom-bar-label">{autonomyDetail}</span>
                      )}
                      <span className="bottom-bar-label">
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 1v3" />
                          <path d="M5 6v3" />
                          <path d="M2 7l3-3 3 3" />
                        </svg>
                        {gitInfo?.branch || 'main'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
                </div>
                {rightSidebarEl}
              </div>
            </div>
          )}
        </main>
      </div>

      {showModelPicker && (
        <div className="modal-overlay" onClick={() => setShowModelPicker(false)}>
          <div className="modal-card model-picker" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Select Model</h3>
              <button className="modal-close" onClick={() => setShowModelPicker(false)}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="3" y1="3" x2="11" y2="11" /><line x1="11" y1="3" x2="3" y2="11" />
                </svg>
              </button>
            </div>
            <div className="model-picker-list">
              {models.map(m => (
                <button
                  key={m.id}
                  className={`model-picker-item${selectedModel === m.id ? ' model-picker-item--active' : ''}`}
                  onClick={() => { setSelectedModel(m.id); setShowModelPicker(false); }}
                >
                  <span className="model-picker-name">{m.displayName}</span>
                  {m.isDefault && <span className="model-picker-badge">default</span>}
                  {selectedModel === m.id && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3,7 6,10 11,4" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
            <div className="model-picker-reasoning">
              <span className="model-picker-reasoning-label">Reasoning Effort</span>
              <div className="model-picker-reasoning-options">
                {(['low', 'medium', 'high', 'xhigh'] as ReasoningLevel[]).map(r => (
                  <button
                    key={r}
                    className={`model-picker-reasoning-btn${reasoning === r ? ' model-picker-reasoning-btn--active' : ''}`}
                    onClick={() => setReasoning(r)}
                  >
                    {r === 'xhigh' ? 'Max' : r.charAt(0).toUpperCase() + r.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {showShortcuts && (
        <div className="modal-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="modal-card shortcuts-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Keyboard Shortcuts</h3>
              <button className="modal-close" onClick={() => setShowShortcuts(false)}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="3" y1="3" x2="11" y2="11" /><line x1="11" y1="3" x2="3" y2="11" />
                </svg>
              </button>
            </div>
            <div className="shortcuts-list">
              <div className="shortcuts-group">
                <h4>General</h4>
                <div className="shortcut-row"><kbd>Ctrl+N</kbd><span>New thread</span></div>
                <div className="shortcut-row"><kbd>Ctrl+K</kbd><span>Search threads</span></div>
                <div className="shortcut-row"><kbd>?</kbd><span>Show shortcuts</span></div>
                <div className="shortcut-row"><kbd>Esc</kbd><span>Cancel / Close</span></div>
              </div>
              <div className="shortcuts-group">
                <h4>Chat</h4>
                <div className="shortcut-row"><kbd>Enter</kbd><span>Send message</span></div>
                <div className="shortcut-row"><kbd>Shift+Enter</kbd><span>New line</span></div>
                <div className="shortcut-row"><kbd>↑</kbd><span>Previous message (when empty)</span></div>
                <div className="shortcut-row"><kbd>↓</kbd><span>Next message (in history)</span></div>
                <div className="shortcut-row"><kbd>/</kbd><span>Slash commands</span></div>
                <div className="shortcut-row"><kbd>$</kbd><span>Skill mentions</span></div>
                <div className="shortcut-row"><kbd>!</kbd><span>Shell command (e.g. !ls -la)</span></div>
              </div>
              <div className="shortcuts-group">
                <h4>Approvals</h4>
                <div className="shortcut-row"><kbd>Y</kbd><span>Approve</span></div>
                <div className="shortcut-row"><kbd>A</kbd><span>Always approve</span></div>
                <div className="shortcut-row"><kbd>N</kbd><span>Decline</span></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast toast--${toast.type}`} onClick={() => setToast(null)}>
          <span>{toast.msg}</span>
          <button className="toast-close" onClick={() => setToast(null)}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}

function UserInputModal({ request, onSubmit, onCancel }: {
  request: UserInputRequest;
  onSubmit: (requestId: number, answers: Array<{ selectedOptions?: number[]; notes?: string }>) => void;
  onCancel: () => void;
}) {
  const [currentQ, setCurrentQ] = useState(0);
  const [answers, setAnswers] = useState<Array<{ selectedOptions: number[]; notes: string }>>(
    () => request.questions.map(() => ({ selectedOptions: [], notes: '' }))
  );

  const q = request.questions[currentQ];
  const answer = answers[currentQ];
  const isLast = currentQ === request.questions.length - 1;

  const toggleOption = (idx: number) => {
    setAnswers(prev => {
      const next = [...prev];
      const curr = next[currentQ];
      const opts = curr.selectedOptions.includes(idx)
        ? curr.selectedOptions.filter(o => o !== idx)
        : [...curr.selectedOptions, idx];
      next[currentQ] = { ...curr, selectedOptions: opts };
      return next;
    });
  };

  const handleNext = () => {
    if (isLast) {
      onSubmit(request.requestId, answers.map(a => ({
        selectedOptions: a.selectedOptions.length > 0 ? a.selectedOptions : undefined,
        notes: a.notes.trim() || undefined,
      })));
    } else {
      setCurrentQ(prev => prev + 1);
    }
  };

  return (
    <div className="user-input-overlay">
      <div className="user-input-card">
        <div className="user-input-header">
          <span className="user-input-icon">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--accent-blue)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="9" r="7.5" />
              <line x1="9" y1="6" x2="9" y2="10" />
              <circle cx="9" cy="12.5" r="0.5" fill="var(--accent-blue)" />
            </svg>
          </span>
          <span className="user-input-title">Agent needs your input</span>
          {request.questions.length > 1 && (
            <span className="user-input-progress">Question {currentQ + 1} of {request.questions.length}</span>
          )}
        </div>
        {q?.header && <div className="user-input-progress">{q.header}</div>}
        <div className="user-input-question">{q?.question}</div>
        {q?.options && q.options.length > 0 && (
          <div className="user-input-options">
            {q.options.map((opt, i) => (
              <button
                key={i}
                className={`user-input-option${answer.selectedOptions.includes(i) ? ' user-input-option--selected' : ''}`}
                onClick={() => toggleOption(i)}
              >
                <span className="user-input-option-num">{i + 1}</span>
                <span className="user-input-option-text">
                  {opt.label}
                  {opt.description ? <small style={{ display: 'block', opacity: 0.7, marginTop: 4 }}>{opt.description}</small> : null}
                </span>
              </button>
            ))}
            {q.allowNoneOfAbove && (
              <button
                className={`user-input-option user-input-option--none${answer.selectedOptions.includes(-1) ? ' user-input-option--selected' : ''}`}
                onClick={() => toggleOption(-1)}
              >
                <span className="user-input-option-text">None of the above</span>
              </button>
            )}
          </div>
        )}
        <div className="user-input-notes">
          <textarea
            value={answer.notes}
            onChange={(e) => {
              setAnswers(prev => {
                const next = [...prev];
                next[currentQ] = { ...next[currentQ], notes: e.target.value };
                return next;
              });
            }}
            placeholder={q?.isSecret ? 'Secret answer...' : 'Additional notes (optional)...'}
            rows={2}
          />
        </div>
        <div className="user-input-actions">
          <button className="btn-primary" onClick={handleNext}>
            {isLast ? 'Submit' : 'Next'}
          </button>
          {currentQ > 0 && (
            <button className="btn-secondary" onClick={() => setCurrentQ(prev => prev - 1)}>Back</button>
          )}
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
        <div className="user-input-hint">
          Press <kbd>Enter</kbd> to {isLast ? 'submit' : 'continue'} &middot; <kbd>1</kbd>-<kbd>9</kbd> to select
        </div>
      </div>
    </div>
  );
}

function McpElicitationModal({
  request,
  onSubmit,
}: {
  request: McpElicitationRequest;
  onSubmit: (
    request: McpElicitationRequest,
    response: { action: 'accept' | 'decline' | 'cancel'; content: unknown },
  ) => void;
}) {
  const [draft, setDraft] = useState<Record<string, McpDraftValue>>(() => {
    if (request.mode !== 'form') {
      return {};
    }

    return Object.fromEntries(
      request.fields.map((field) => [field.key, getMcpFieldInitialValue(field)]),
    ) as Record<string, McpDraftValue>;
  });
  const [error, setError] = useState<string | null>(null);

  const submitForm = () => {
    if (request.mode !== 'form') {
      return;
    }

    const invalidFields = request.fields.filter((field) => !isMcpFieldValueValid(field, draft[field.key]));
    if (invalidFields.length > 0) {
      setError(`Please complete: ${invalidFields.map((field) => field.label).join(', ')}`);
      return;
    }

    setError(null);
    onSubmit(request, {
      action: 'accept',
      content: buildMcpElicitationContent(request.fields, draft),
    });
  };

  return (
    <div className="user-input-overlay">
      <div className="user-input-card elicitation-card">
        <div className="user-input-header">
          <span className="user-input-icon">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--accent-blue)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 2.5l6 3.2v6.6L9 15.5l-6-3.2V5.7L9 2.5z" />
              <path d="M6.5 8.5h5" />
              <path d="M6.5 11h3.5" />
            </svg>
          </span>
          <span className="user-input-title">MCP server needs input</span>
          <span className="user-input-progress">{request.serverName}</span>
        </div>

        <div className="user-input-question">{request.message}</div>

        {request.mode === 'url' ? (
          <div className="elicitation-url-block">
            <div className="approval-overlay-command">
              <code>{request.url}</code>
            </div>
            <div className="elicitation-url-actions">
              <a className="btn-secondary" href={request.url} target="_blank" rel="noreferrer">
                Open link
              </a>
            </div>
          </div>
        ) : (
          <div className="elicitation-fields">
            {request.fields.map((field) => {
              const value = draft[field.key];
              const description = field.description;

              if (field.kind === 'boolean') {
                return (
                  <label key={field.key} className="elicitation-checkbox-row">
                    <input
                      type="checkbox"
                      checked={typeof value === 'boolean' ? value : false}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          [field.key]: event.target.checked,
                        }))
                      }
                    />
                    <span className="elicitation-checkbox-copy">
                      <span className="elicitation-label">
                        {field.label}
                        {field.required ? ' *' : ''}
                      </span>
                      {description ? <span className="elicitation-help">{description}</span> : null}
                    </span>
                  </label>
                );
              }

              if (field.kind === 'multiSelect') {
                const selectedValues = Array.isArray(value) ? value : [];
                return (
                  <div key={field.key} className="elicitation-field">
                    <div className="elicitation-label">
                      {field.label}
                      {field.required ? ' *' : ''}
                    </div>
                    {description ? <div className="elicitation-help">{description}</div> : null}
                    <div className="elicitation-choice-list">
                      {field.options.map((option) => {
                        const selected = selectedValues.includes(option.value);
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className={`user-input-option${selected ? ' user-input-option--selected' : ''}`}
                            onClick={() =>
                              setDraft((prev) => {
                                const current = Array.isArray(prev[field.key]) ? (prev[field.key] as string[]) : [];
                                const next = current.includes(option.value)
                                  ? current.filter((entry) => entry !== option.value)
                                  : [...current, option.value];
                                return {
                                  ...prev,
                                  [field.key]: next,
                                };
                              })
                            }
                          >
                            <span className="user-input-option-num">{selected ? '✓' : '+'}</span>
                            <span className="user-input-option-text">{option.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              }

              if (field.kind === 'singleSelect') {
                return (
                  <div key={field.key} className="elicitation-field">
                    <label className="elicitation-label">
                      {field.label}
                      {field.required ? ' *' : ''}
                    </label>
                    {description ? <div className="elicitation-help">{description}</div> : null}
                    <select
                      className="elicitation-input"
                      value={typeof value === 'string' ? value : ''}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          [field.key]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Select...</option>
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              }

              const inputType =
                field.kind === 'number'
                  ? 'number'
                  : field.format === 'email'
                  ? 'email'
                  : field.format === 'uri'
                  ? 'url'
                  : field.format === 'date'
                  ? 'date'
                  : field.format === 'date-time'
                  ? 'datetime-local'
                  : 'text';
              const textValue = typeof value === 'string' ? value : '';
              const useTextarea =
                field.kind === 'string' &&
                !field.format &&
                (field.maxLength == null || field.maxLength > 120);

              return (
                <div key={field.key} className="elicitation-field">
                  <label className="elicitation-label">
                    {field.label}
                    {field.required ? ' *' : ''}
                  </label>
                  {description ? <div className="elicitation-help">{description}</div> : null}
                  {useTextarea ? (
                    <textarea
                      className="elicitation-input elicitation-textarea"
                      value={textValue}
                      minLength={field.kind === 'string' ? field.minLength : undefined}
                      maxLength={field.kind === 'string' ? field.maxLength : undefined}
                      rows={3}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                  ) : (
                    <input
                      className="elicitation-input"
                      type={inputType}
                      value={textValue}
                      min={field.kind === 'number' ? field.minimum : undefined}
                      max={field.kind === 'number' ? field.maximum : undefined}
                      minLength={field.kind === 'string' ? field.minLength : undefined}
                      maxLength={field.kind === 'string' ? field.maxLength : undefined}
                      step={field.kind === 'number' ? (field.integer ? 1 : 'any') : undefined}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {error ? <div className="elicitation-error">{error}</div> : null}

        <div className="user-input-actions">
          {request.mode === 'form' ? (
            <button className="btn-primary" onClick={submitForm}>
              Submit
            </button>
          ) : (
            <button
              className="btn-primary"
              onClick={() => onSubmit(request, { action: 'accept', content: null })}
            >
              I&apos;ve completed this
            </button>
          )}
          <button
            className="btn-secondary"
            onClick={() => onSubmit(request, { action: 'decline', content: null })}
          >
            Decline
          </button>
          <button
            className="btn-secondary"
            onClick={() => onSubmit(request, { action: 'cancel', content: null })}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function AuthRefreshModal({
  request,
  onSubmit,
  onReject,
}: {
  request: AuthRefreshRequest;
  onSubmit: (request: AuthRefreshRequest, response: ChatgptAuthTokensRefreshResponse) => void;
  onReject: (request: AuthRefreshRequest) => void;
}) {
  const [accessToken, setAccessToken] = useState('');
  const [accountId, setAccountId] = useState(request.previousAccountId ?? '');
  const [planType, setPlanType] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    const trimmedToken = accessToken.trim();
    const trimmedAccountId = accountId.trim();

    if (!trimmedToken || !trimmedAccountId) {
      setError('Access token and workspace/account ID are required.');
      return;
    }

    setError(null);
    onSubmit(request, {
      accessToken: trimmedToken,
      chatgptAccountId: trimmedAccountId,
      chatgptPlanType: planType.trim() || null,
    });
  };

  return (
    <div className="user-input-overlay">
      <div className="user-input-card auth-refresh-card">
        <div className="user-input-header">
          <span className="user-input-icon">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--accent-blue)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 5.5A5.5 5.5 0 0 0 4.2 4.4" />
              <path d="M4 2.5v2.8h2.8" />
              <path d="M4 12.5A5.5 5.5 0 0 0 13.8 13.6" />
              <path d="M14 15.5v-2.8h-2.8" />
            </svg>
          </span>
          <span className="user-input-title">Refresh ChatGPT auth tokens</span>
          <span className="user-input-progress">{request.reason}</span>
        </div>

        <div className="user-input-question">
          Codex needs a fresh ChatGPT access token to continue the current session.
        </div>

        {request.previousAccountId ? (
          <div className="auth-refresh-note">
            Previous workspace/account ID: <code>{request.previousAccountId}</code>
          </div>
        ) : null}

        <div className="elicitation-fields">
          <div className="elicitation-field">
            <label className="elicitation-label">Access token *</label>
            <div className="elicitation-help">
              Paste a fresh ChatGPT access token JWT from your external auth provider or session broker.
            </div>
            <textarea
              className="elicitation-input elicitation-textarea auth-refresh-token"
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
              rows={4}
              spellCheck={false}
              autoComplete="off"
              placeholder="eyJhbGciOi..."
            />
          </div>

          <div className="elicitation-field">
            <label className="elicitation-label">Workspace/account ID *</label>
            <div className="elicitation-help">
              Use the ChatGPT workspace/account identifier that should own the refreshed token.
            </div>
            <input
              className="elicitation-input auth-refresh-account-id"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="acc_..."
            />
          </div>

          <div className="elicitation-field">
            <label className="elicitation-label">Plan type</label>
            <div className="elicitation-help">
              Optional. Leave blank to let Codex infer the plan type from the token claims.
            </div>
            <input
              className="elicitation-input auth-refresh-plan-type"
              value={planType}
              onChange={(event) => setPlanType(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="plus / pro / team / enterprise"
            />
          </div>
        </div>

        {error ? <div className="elicitation-error">{error}</div> : null}

        <div className="user-input-actions">
          <button className="btn-primary" onClick={handleSubmit}>
            Submit token
          </button>
          <button className="btn-secondary" onClick={() => onReject(request)}>
            Reject request
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryPanel({
  entries,
  searchQuery,
  onSearchChange,
  threads,
  onSelectMessage,
}: {
  entries: ChatHistoryEntry[];
  searchQuery: string;
  onSearchChange: (q: string) => void;
  threads: import('@codex-mobile/shared').ThreadSummary[];
  onSelectMessage: (msg: string) => void;
}) {
  const now = Date.now() / 1000;
  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const todayTs = today.getTime() / 1000;
  const yesterdayTs = yesterday.getTime() / 1000;

  const grouped = entries.reduce<{ today: ChatHistoryEntry[]; yesterday: ChatHistoryEntry[]; earlier: ChatHistoryEntry[] }>(
    (acc, entry) => {
      if (entry.created_at >= todayTs) acc.today.push(entry);
      else if (entry.created_at >= yesterdayTs) acc.yesterday.push(entry);
      else acc.earlier.push(entry);
      return acc;
    },
    { today: [], yesterday: [], earlier: [] }
  );

  const threadMap = Object.fromEntries(threads.map(t => [t.id, t.name || t.preview || t.id]));

  const renderGroup = (label: string, items: ChatHistoryEntry[]) => {
    if (items.length === 0) return null;
    return (
      <div key={label} className="history-group">
        <div className="history-group-label">{label}</div>
        {items.map(entry => (
          <button key={entry.id} className="history-item" onClick={() => onSelectMessage(entry.message)}>
            <div className="history-item-msg">{entry.message.length > 80 ? entry.message.slice(0, 80) + '…' : entry.message}</div>
            {entry.thread_id && threadMap[entry.thread_id] && (
              <div className="history-item-thread">{threadMap[entry.thread_id]}</div>
            )}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="history-panel">
      <div className="history-search-row">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="7" cy="7" r="5" /><path d="M11 11l3.5 3.5" />
        </svg>
        <input
          className="history-search-input"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search history..."
        />
        {searchQuery && (
          <button className="history-search-clear" onClick={() => onSearchChange('')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
            </svg>
          </button>
        )}
      </div>
      <div className="history-list">
        {entries.length === 0 ? (
          <div className="history-empty">暂无历史记录</div>
        ) : (
          <>
            {renderGroup('今天', grouped.today)}
            {renderGroup('昨天', grouped.yesterday)}
            {renderGroup('更早', grouped.earlier)}
          </>
        )}
      </div>
    </div>
  );
}

function DynamicToolCallModal({
  request,
  onSubmit,
  onReject,
}: {
  request: DynamicToolCallRequest;
  onSubmit: (
    request: DynamicToolCallRequest,
    response: {
      contentItems: DynamicToolCallContentItem[];
      success: boolean;
    },
  ) => void;
  onReject: (request: DynamicToolCallRequest) => void;
}) {
  const [textOutput, setTextOutput] = useState('');
  const [imageUrls, setImageUrls] = useState('');

  const buildResponse = (success: boolean) => {
    const contentItems: DynamicToolCallContentItem[] = [];
    const text = textOutput.trim();
    const urls = imageUrls
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (text) {
      contentItems.push({ type: 'inputText', text });
    }

    contentItems.push(...urls.map((imageUrl) => ({ type: 'inputImage' as const, imageUrl })));

    onSubmit(request, {
      contentItems,
      success,
    });
  };

  return (
    <div className="user-input-overlay">
      <div className="user-input-card dynamic-tool-card">
        <div className="user-input-header">
          <span className="user-input-icon">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--status-warning)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="12" height="12" rx="2" />
              <path d="M6 9h6" />
              <path d="M9 6v6" />
            </svg>
          </span>
          <span className="user-input-title">Dynamic tool call</span>
          <span className="user-input-progress">{request.tool}</span>
        </div>

        <div className="user-input-question">Codex requested a client-side tool result. Review the arguments below and return the result payload manually.</div>

        <div className="dynamic-tool-section">
          <div className="elicitation-label">Arguments</div>
          <pre className="dynamic-tool-json">{stringifyForDisplay(request.arguments)}</pre>
        </div>

        <div className="dynamic-tool-section">
          <label className="elicitation-label">Text output</label>
          <textarea
            className="elicitation-input elicitation-textarea"
            value={textOutput}
            onChange={(event) => setTextOutput(event.target.value)}
            rows={4}
            placeholder="Return text content for the dynamic tool call..."
          />
        </div>

        <div className="dynamic-tool-section">
          <label className="elicitation-label">Image URLs</label>
          <textarea
            className="elicitation-input elicitation-textarea"
            value={imageUrls}
            onChange={(event) => setImageUrls(event.target.value)}
            rows={3}
            placeholder="One image URL or data URL per line (optional)..."
          />
        </div>

        <div className="user-input-actions">
          <button className="btn-primary" onClick={() => buildResponse(true)}>
            Return success
          </button>
          <button className="btn-secondary" onClick={() => buildResponse(false)}>
            Return failure
          </button>
          <button className="btn-secondary" onClick={() => onReject(request)}>
            Reject request
          </button>
        </div>

        <div className="user-input-hint">Leave both fields empty to return an empty <code>contentItems</code> array.</div>
      </div>
    </div>
  );
}

type Automation = {
  id: string;
  name: string;
  description: string;
  trigger: 'schedule' | 'on-push' | 'on-pr' | 'manual';
  schedule?: string;
  skillName?: string;
  enabled: boolean;
  lastRun?: number;
  lastStatus?: 'success' | 'failed' | 'running';
};

const TRIGGER_LABELS: Record<string, string> = {
  schedule: 'Scheduled',
  'on-push': 'On Push',
  'on-pr': 'On Pull Request',
  manual: 'Manual',
};

function AutomationsView() {
  const [automations, setAutomations] = usePersistedState<Automation[]>('codex-automations', []);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formTrigger, setFormTrigger] = useState<Automation['trigger']>('manual');
  const [formSchedule, setFormSchedule] = useState('0 */6 * * *');
  const [formSkill, setFormSkill] = useState('');
  const [filterTrigger, setFilterTrigger] = useState<string>('all');
  const resetForm = () => {
    setFormName('');
    setFormDesc('');
    setFormTrigger('manual');
    setFormSchedule('0 */6 * * *');
    setFormSkill('');
    setShowCreate(false);
    setEditingId(null);
  };

  const handleSave = () => {
    if (!formName.trim()) return;
    if (editingId) {
      setAutomations(automations.map(a =>
        a.id === editingId
          ? { ...a, name: formName.trim(), description: formDesc.trim(), trigger: formTrigger, schedule: formSchedule, skillName: formSkill || undefined }
          : a
      ));
    } else {
      const newAuto: Automation = {
        id: `auto-${Date.now()}`,
        name: formName.trim(),
        description: formDesc.trim(),
        trigger: formTrigger,
        schedule: formTrigger === 'schedule' ? formSchedule : undefined,
        skillName: formSkill || undefined,
        enabled: true,
      };
      setAutomations([...automations, newAuto]);
    }
    resetForm();
  };

  const handleEdit = (a: Automation) => {
    setEditingId(a.id);
    setFormName(a.name);
    setFormDesc(a.description);
    setFormTrigger(a.trigger);
    setFormSchedule(a.schedule || '0 */6 * * *');
    setFormSkill(a.skillName || '');
    setShowCreate(true);
  };

  const handleToggle = (id: string) => {
    setAutomations(automations.map(a => a.id === id ? { ...a, enabled: !a.enabled } : a));
  };

  const handleDelete = (id: string) => {
    setAutomations(automations.filter(a => a.id !== id));
  };

  const handleRunNow = (id: string) => {
    setAutomations(automations.map(a =>
      a.id === id ? { ...a, lastRun: Math.floor(Date.now() / 1000), lastStatus: 'running' } : a
    ));
    setTimeout(() => {
      setAutomations(automations.map(a =>
        a.id === id ? { ...a, lastStatus: 'success' as const } : a
      ));
    }, 2000);
  };

  const filteredAutomations = filterTrigger === 'all' ? automations : automations.filter(a => a.trigger === filterTrigger);

  return (
    <div className="feature-view">
      <div className="fv-toolbar" data-tauri-drag-region>
        <div className="fv-toolbar-left">
          <h2 className="fv-toolbar-title">Automations</h2>
          <div className="fv-toolbar-filters">
            {['all', 'manual', 'schedule', 'on-push', 'on-pr'].map(t => (
              <button key={t} className={`fv-filter-btn${filterTrigger === t ? ' fv-filter-btn--active' : ''}`} onClick={() => setFilterTrigger(t)}>
                {t === 'all' ? 'All' : TRIGGER_LABELS[t] || t}
              </button>
            ))}
          </div>
        </div>
        <div className="fv-toolbar-right">
          <button className="toolbar-btn" onClick={() => { resetForm(); setShowCreate(true); }} title="New Automation">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="7" y1="3" x2="7" y2="11" /><line x1="3" y1="7" x2="11" y2="7" /></svg>
            <span>New</span>
          </button>
          <div className="toolbar-divider" />
          <WindowControls />
        </div>
      </div>

      <div className="fv-body">
        {showCreate && (
          <div className="feature-form-card">
            <h3>{editingId ? 'Edit Automation' : 'Create Automation'}</h3>
            <div className="feature-form">
              <div className="form-row">
                <div className="form-field"><label>Name</label><input value={formName} onChange={e => setFormName(e.target.value)} placeholder="e.g. Nightly Error Triage" /></div>
                <div className="form-field"><label>Trigger</label>
                  <select value={formTrigger} onChange={e => setFormTrigger(e.target.value as Automation['trigger'])}>
                    <option value="manual">Manual</option><option value="schedule">Scheduled (Cron)</option><option value="on-push">On Push</option><option value="on-pr">On Pull Request</option>
                  </select>
                </div>
              </div>
              <div className="form-field"><label>Description</label><textarea value={formDesc} onChange={e => setFormDesc(e.target.value)} placeholder="What this automation does..." rows={2} /></div>
              {formTrigger === 'schedule' && (
                <div className="form-field"><label>Cron Schedule</label><input value={formSchedule} onChange={e => setFormSchedule(e.target.value)} placeholder="0 */6 * * *" className="mono-input" /></div>
              )}
              <div className="form-field"><label>Linked Skill (optional)</label><input value={formSkill} onChange={e => setFormSkill(e.target.value)} placeholder="Skill name" /></div>
              <div className="form-actions">
                <button className="btn-primary" onClick={handleSave} disabled={!formName.trim()}>{editingId ? 'Save' : 'Create'}</button>
                <button className="btn-secondary" onClick={resetForm}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {filteredAutomations.length === 0 && !showCreate ? (
          <div className="feature-empty">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M24 8v12l7.5 4.5" /><circle cx="24" cy="24" r="18" />
            </svg>
            <h3>{filterTrigger === 'all' ? 'No automations yet' : `No ${TRIGGER_LABELS[filterTrigger] || filterTrigger} automations`}</h3>
            <p>Combine skills with triggers to automate routine tasks.</p>
            <button className="btn-primary" onClick={() => setShowCreate(true)}>Create Automation</button>
          </div>
        ) : (
          <div className="automation-list">
            {filteredAutomations.map(a => (
              <div key={a.id} className={`automation-card${a.enabled ? '' : ' automation-card--disabled'}`}>
                <div className="automation-card-header">
                  <div className="automation-card-left">
                    <button className={`toggle-switch${a.enabled ? ' toggle-switch--on' : ''}`} onClick={() => handleToggle(a.id)} title={a.enabled ? 'Disable' : 'Enable'}>
                      <span className="toggle-knob" />
                    </button>
                    <div className="automation-card-info">
                      <span className="automation-card-name">{a.name}</span>
                      {a.description && <span className="automation-card-desc">{a.description}</span>}
                    </div>
                  </div>
                  <div className="automation-card-actions">
                    <span className={`automation-trigger-badge automation-trigger-badge--${a.trigger}`}>{TRIGGER_LABELS[a.trigger]}</span>
                    {a.trigger === 'schedule' && a.schedule && <span className="automation-schedule">{a.schedule}</span>}
                  </div>
                </div>
                <div className="automation-card-footer">
                  <div className="automation-card-meta">
                    {a.lastRun && (
                      <span className="automation-last-run">
                        Last run: {new Date(a.lastRun * 1000).toLocaleString()}
                        {a.lastStatus && <span className={`automation-status automation-status--${a.lastStatus}`}>{a.lastStatus}</span>}
                      </span>
                    )}
                    {a.skillName && <span className="automation-skill">Skill: {a.skillName}</span>}
                  </div>
                  <div className="automation-card-btns">
                    <button className="btn-small" onClick={() => handleRunNow(a.id)} disabled={a.lastStatus === 'running'}>{a.lastStatus === 'running' ? 'Running...' : 'Run Now'}</button>
                    <button className="btn-small" onClick={() => handleEdit(a)}>Edit</button>
                    <button className="btn-small btn-danger-text" onClick={() => handleDelete(a.id)}>Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="fv-footer">
        <span>{automations.length} automation{automations.length !== 1 ? 's' : ''}</span>
        {filterTrigger !== 'all' && <span> · {filteredAutomations.length} shown</span>}
      </div>
    </div>
  );
}

type SkillDetail = { name: string; path: string; description?: string; tags?: string[] };

function SkillsView({ skills, onRefresh }: { skills: SkillDetail[]; onRefresh?: () => void }) {
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
    <div className="feature-view">
      <div className="fv-toolbar" data-tauri-drag-region>
        <div className="fv-toolbar-left">
          <h2 className="fv-toolbar-title">Skills</h2>
          <div className="fv-toolbar-search">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="7" cy="7" r="5" /><path d="M11 11l3.5 3.5" />
            </svg>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search skills..." />
            {search && (
              <button className="fv-search-clear" onClick={() => setSearch('')}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" /></svg>
              </button>
            )}
          </div>
        </div>
        <div className="fv-toolbar-right">
          {onRefresh && (
            <button className="toolbar-btn" onClick={onRefresh} title="Refresh skills">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 7a5.5 5.5 0 0 1 9.3-4" /><path d="M12.5 7a5.5 5.5 0 0 1-9.3 4" />
                <polyline points="11,1 11,4 8,4" /><polyline points="3,13 3,10 6,10" />
              </svg>
              <span>Refresh</span>
            </button>
          )}
          <div className="toolbar-divider" />
          <WindowControls />
        </div>
      </div>

      <div className="fv-body">
        {filtered.length === 0 ? (
          <div className="feature-empty">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="6" width="15" height="15" rx="3" /><rect x="27" y="6" width="15" height="15" rx="3" />
              <rect x="6" y="27" width="15" height="15" rx="3" /><rect x="27" y="27" width="15" height="15" rx="3" />
            </svg>
            <h3>{search ? 'No matching skills' : 'No skills found'}</h3>
            <p>{search ? 'Try a different search term.' : 'Create a SKILL.md in your project to get started.'}</p>
          </div>
        ) : (
          <div className="skills-groups">
            {grouped.map(([project, items]) => (
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
                    <button key={i} className={`skill-card${isExpanded ? ' skill-card--expanded' : ''}`} onClick={() => setExpandedSkill(isExpanded ? null : `${project}-${i}`)}>
                      <div className="skill-card-main">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--accent-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" />
                        </svg>
                        <div className="skill-card-info">
                          <span className="skill-card-name">{s.name}</span>
                          {s.description && !isExpanded && <span className="skill-card-desc">{s.description}</span>}
                        </div>
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
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="fv-footer">
        <span>{filtered.length} skill{filtered.length !== 1 ? 's' : ''} found</span>
        {grouped.length > 0 && <span> · {grouped.length} project{grouped.length !== 1 ? 's' : ''}</span>}
      </div>
    </div>
  );
}

type SettingsTab = 'general' | 'appearance' | 'config' | 'personalization' | 'mcp' | 'git' | 'archived';

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'config', label: 'Configuration' },
  { id: 'personalization', label: 'Personalization' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'git', label: 'Git' },
  { id: 'archived', label: 'Archived Threads' },
];

function getConfigValue(config: Record<string, unknown> | null, path: string): unknown {
  const root = getConfigRoot(config);
  if (!root) return undefined;
  const parts = path.split('.');
  let obj: unknown = root;
  for (const p of parts) {
    if (obj && typeof obj === 'object' && p in (obj as Record<string, unknown>)) {
      obj = (obj as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return obj;
}

function getApprovalPolicyValue(config: Record<string, unknown> | null): ApprovalPolicyValue | undefined {
  const raw = getConfigValue(config, 'approvalPolicy') ?? getConfigValue(config, 'approval_policy');
  if (typeof raw === 'string') {
    if (raw === 'untrusted' || raw === 'on-failure' || raw === 'on-request' || raw === 'never') {
      return raw;
    }
    return undefined;
  }
  if (raw && typeof raw === 'object' && 'granular' in (raw as Record<string, unknown>)) {
    return 'granular';
  }
  return undefined;
}

function getSandboxModeValue(config: Record<string, unknown> | null): SandboxModeValue | undefined {
  const raw = getConfigValue(config, 'sandboxMode') ?? getConfigValue(config, 'sandbox_mode') ?? getConfigValue(config, 'sandbox');
  if (raw === 'read-only' || raw === 'workspace-write' || raw === 'danger-full-access') {
    return raw;
  }
  return undefined;
}

function getEffectiveApprovalPolicyValue(config: Record<string, unknown> | null): ApprovalPolicyValue {
  return getApprovalPolicyValue(config) ?? 'untrusted';
}

function getEffectiveSandboxModeValue(config: Record<string, unknown> | null): SandboxModeValue {
  return getSandboxModeValue(config) ?? 'read-only';
}

function deriveAutonomyModeFromConfig(config: Record<string, unknown> | null): AutonomyModeValue {
  if (!config) return 'suggest';

  const approvalPolicy = getEffectiveApprovalPolicyValue(config);
  const sandboxMode = getEffectiveSandboxModeValue(config);

  if (approvalPolicy === AUTONOMY_PRESETS.suggest.approvalPolicy && sandboxMode === AUTONOMY_PRESETS.suggest.sandboxMode) {
    return 'suggest';
  }
  if (approvalPolicy === AUTONOMY_PRESETS['auto-edit'].approvalPolicy && sandboxMode === AUTONOMY_PRESETS['auto-edit'].sandboxMode) {
    return 'auto-edit';
  }
  if (
    sandboxMode === AUTONOMY_PRESETS['full-auto'].sandboxMode &&
    (approvalPolicy === AUTONOMY_PRESETS['full-auto'].approvalPolicy || approvalPolicy === 'on-failure')
  ) {
    return 'full-auto';
  }
  return 'custom';
}

function formatAutonomyModeLabel(mode: AutonomyModeValue): string {
  switch (mode) {
    case 'suggest':
      return 'Suggest';
    case 'auto-edit':
      return 'Auto Edit';
    case 'full-auto':
      return 'Full Auto';
    default:
      return 'Custom';
  }
}

function formatAutonomyModeDetail(config: Record<string, unknown> | null, mode: AutonomyModeValue): string | null {
  if (mode !== 'custom') return null;

  const approvalPolicy = getApprovalPolicyValue(config) ?? 'unknown';
  const sandboxMode = getSandboxModeValue(config) ?? 'unknown';
  return `${approvalPolicy} · ${sandboxMode}`;
}

function getAutonomyModeSummary(config: Record<string, unknown> | null): string {
  const approvalPolicy = getEffectiveApprovalPolicyValue(config);
  const sandboxMode = getEffectiveSandboxModeValue(config);
  return `${approvalPolicy} / ${sandboxMode}`;
}

function formatRateLimitResetTime(unixSec: number | null): string {
  if (typeof unixSec !== 'number' || !Number.isFinite(unixSec)) {
    return 'Unknown';
  }
  return new Date(unixSec * 1000).toLocaleString();
}

function SettingsView({
  url,
  onUrlChange,
  connState,
  accountInfo,
  rateLimits,
  mcpServers,
  client,
  theme,
  onThemeChange,
  codexConfig,
  onWriteConfig,
}: {
  url: string;
  onUrlChange: (url: string) => void;
  connState: ConnectionState;
  accountInfo: AccountInfo;
  rateLimits: RateLimitSnapshotState | null;
  mcpServers: Array<{ name: string; status: string }>;
  client: CodexClient;
  theme: ThemeMode;
  onThemeChange: (t: ThemeMode) => void;
  codexConfig: Record<string, unknown> | null;
  onWriteConfig?: (key: string, value: unknown) => Promise<void>;
}) {
  const [tab, setTab] = useState<SettingsTab>('general');
  const [archivedThreads, setArchivedThreads] = useState<ThreadSummary[]>([]);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [instructionsValue, setInstructionsValue] = useState('');
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [editingBranchPrefix, setEditingBranchPrefix] = useState(false);
  const [branchPrefixValue, setBranchPrefixValue] = useState('');
  const [savingBranchPrefix, setSavingBranchPrefix] = useState(false);

  useEffect(() => {
    if (tab === 'archived' && connState === 'connected') {
      setLoadingArchived(true);
      (async () => {
        try {
          const result = await client.listThreads({ limit: 50, archived: true });
          setArchivedThreads(result.data);
        } catch {
          setArchivedThreads([]);
        }
        setLoadingArchived(false);
      })();
    }
  }, [tab, connState, client]);

  return (
    <div className="settings-layout">
      <nav className="settings-tabs">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            className={`settings-tab${tab === t.id ? ' settings-tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {tab === 'general' && (
          <div className="settings-panel">
            <h2>General</h2>
            <div className="settings-section">
              <h3>Connection</h3>
              <div className="settings-row">
                <label>WebSocket URL</label>
                <input
                  className="settings-input"
                  value={url}
                  onChange={(e) => onUrlChange(e.target.value)}
                  disabled={connState === 'connected'}
                />
              </div>
              <div className="settings-row">
                <label>Status</label>
                <span style={{
                  fontSize: 13,
                  color: connState === 'connected' ? 'var(--status-active)' : 'var(--text-tertiary)',
                  textTransform: 'capitalize',
                }}>
                  {connState}
                </span>
              </div>
            </div>
            {accountInfo && (
              <div className="settings-section">
                <h3>Account</h3>
                <div className="settings-row">
                  <label>Auth Type</label>
                  <span className="settings-value">{accountInfo.type}</span>
                </div>
                {accountInfo.email && (
                  <div className="settings-row">
                    <label>Email</label>
                    <span className="settings-value">{accountInfo.email}</span>
                  </div>
                )}
                {accountInfo.planType && (
                  <div className="settings-row">
                    <label>Plan</label>
                    <span className="settings-value" style={{ textTransform: 'capitalize' }}>
                      {accountInfo.planType}
                    </span>
                  </div>
                )}
              </div>
            )}
            {rateLimits && (
              <div className="settings-section">
                <h3>Rate Limits</h3>
                {rateLimits.limitName && (
                  <div className="settings-row">
                    <label>Limit</label>
                    <span className="settings-value">{rateLimits.limitName}</span>
                  </div>
                )}
                {rateLimits.planType && (
                  <div className="settings-row">
                    <label>Plan Snapshot</label>
                    <span className="settings-value" style={{ textTransform: 'capitalize' }}>
                      {rateLimits.planType}
                    </span>
                  </div>
                )}
                {rateLimits.primary && (
                  <>
                    <div className="settings-row">
                      <label>Primary Window</label>
                      <span className="settings-value">
                        {Math.round(rateLimits.primary.usedPercent)}% used
                        {rateLimits.primary.windowDurationMins ? ` / ${rateLimits.primary.windowDurationMins} min` : ''}
                      </span>
                    </div>
                    <div className="settings-row">
                      <label>Primary Reset</label>
                      <span className="settings-value">{formatRateLimitResetTime(rateLimits.primary.resetsAt)}</span>
                    </div>
                  </>
                )}
                {rateLimits.secondary && (
                  <>
                    <div className="settings-row">
                      <label>Secondary Window</label>
                      <span className="settings-value">
                        {Math.round(rateLimits.secondary.usedPercent)}% used
                        {rateLimits.secondary.windowDurationMins ? ` / ${rateLimits.secondary.windowDurationMins} min` : ''}
                      </span>
                    </div>
                    <div className="settings-row">
                      <label>Secondary Reset</label>
                      <span className="settings-value">{formatRateLimitResetTime(rateLimits.secondary.resetsAt)}</span>
                    </div>
                  </>
                )}
                {rateLimits.credits && (
                  <div className="settings-row">
                    <label>Credits</label>
                    <span className="settings-value">
                      {rateLimits.credits.unlimited
                        ? 'Unlimited'
                        : rateLimits.credits.balance
                        ? rateLimits.credits.balance
                        : rateLimits.credits.hasCredits
                        ? 'Available'
                        : 'Unavailable'}
                    </span>
                  </div>
                )}
              </div>
            )}
            <div className="settings-section">
              <h3>Notifications</h3>
              <div className="settings-row">
                <label>Turn completion</label>
                <span className="settings-value">When app unfocused</span>
              </div>
            </div>
          </div>
        )}

        {tab === 'appearance' && (
          <div className="settings-panel">
            <h2>Appearance</h2>
            <div className="settings-section">
              <h3>Theme</h3>
              <div className="settings-theme-row">
                {(['dark', 'light', 'system'] as ThemeMode[]).map((t) => (
                  <button
                    key={t}
                    className={`settings-theme-option${theme === t ? ' settings-theme-option--active' : ''}`}
                    onClick={() => onThemeChange(t)}
                  >
                    <div className={`settings-theme-preview settings-theme-preview--${t}`} />
                    <span>{t.charAt(0).toUpperCase() + t.slice(1)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-section">
              <h3>Typography</h3>
              <div className="settings-row">
                <label>UI Font Size</label>
                <span className="settings-value">14px</span>
              </div>
              <div className="settings-row">
                <label>Code Font Size</label>
                <span className="settings-value">13px</span>
              </div>
            </div>
          </div>
        )}

        {tab === 'config' && (
          <div className="settings-panel">
            <h2>Configuration</h2>
            <p className="settings-desc">Configure approval policy and sandbox settings. These are managed in your Codex config.toml file.</p>
            <div className="settings-section">
              <h3>Autonomy Preset</h3>
              <div className="settings-row">
                <label>Preset</label>
                <span className="settings-value">
                  {formatAutonomyModeLabel(deriveAutonomyModeFromConfig(codexConfig))}
                </span>
              </div>
            </div>
            <div className="settings-section">
              <h3>Approval Policy</h3>
              <div className="settings-row">
                <label>Policy</label>
                <span className="settings-value">
                  {getAutonomyModeSummary(codexConfig).split(' / ')[0]}
                </span>
              </div>
            </div>
            <div className="settings-section">
              <h3>Sandbox</h3>
              <div className="settings-row">
                <label>Sandbox mode</label>
                <span className="settings-value settings-value--accent">
                  {getAutonomyModeSummary(codexConfig).split(' / ')[1]}
                </span>
              </div>
            </div>
            {codexConfig && (
              <div className="settings-section">
                <h3>Raw Config</h3>
                <pre className="settings-text-block" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {JSON.stringify(codexConfig, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {tab === 'personalization' && (
          <div className="settings-panel">
            <h2>Personalization</h2>
            <p className="settings-desc">Tailor Codex's personality and instructions.</p>
            <div className="settings-section">
              <h3>Custom Instructions</h3>
              {editingInstructions ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <textarea
                    value={instructionsValue}
                    onChange={e => setInstructionsValue(e.target.value)}
                    rows={10}
                    style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 6, padding: '8px 10px', resize: 'vertical', boxSizing: 'border-box' }}
                    placeholder="Enter custom instructions for Codex..."
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-small btn-primary" disabled={savingInstructions} onClick={async () => {
                      if (!onWriteConfig) return;
                      setSavingInstructions(true);
                      try { await onWriteConfig('instructions', instructionsValue); setEditingInstructions(false); } catch {}
                      setSavingInstructions(false);
                    }}>{savingInstructions ? 'Saving...' : 'Save'}</button>
                    <button className="btn-small" onClick={() => setEditingInstructions(false)}>Cancel</button>
                  </div>
                </div>
              ) : (() => {
                const instructions = getConfigValue(codexConfig, 'instructions') ?? getConfigValue(codexConfig, 'customInstructions');
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {instructions ? (
                      <pre className="settings-text-block" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {typeof instructions === 'string' ? instructions : JSON.stringify(instructions, null, 2)}
                      </pre>
                    ) : (
                      <div className="settings-text-block">No custom instructions set.</div>
                    )}
                    {onWriteConfig && (
                      <button className="btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => {
                        const current = getConfigValue(codexConfig, 'instructions') ?? getConfigValue(codexConfig, 'customInstructions');
                        setInstructionsValue(typeof current === 'string' ? current : '');
                        setEditingInstructions(true);
                      }}>Edit</button>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {tab === 'mcp' && (
          <div className="settings-panel">
            <h2>MCP Servers</h2>
            <p className="settings-desc">Connect external tools and data sources.</p>
            {mcpServers.length > 0 ? (
              <div className="settings-section">
                <h3>Connected Servers</h3>
                {mcpServers.map((s, i) => (
                  <div key={i} className="settings-row">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`sidebar-conn-dot sidebar-conn-dot--${s.status === 'running' ? 'connected' : 'disconnected'}`} />
                      <label>{s.name}</label>
                    </div>
                    <span style={{
                      fontSize: 12,
                      color: s.status === 'running' ? 'var(--status-active)' : 'var(--text-tertiary)',
                      textTransform: 'capitalize',
                    }}>
                      {s.status}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-section-card">
                <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
                  No MCP servers connected. Configure servers in your Codex config.
                </span>
              </div>
            )}
            <div className="settings-section">
              <h3>Recommended</h3>
              {['Linear', 'Notion', 'Figma', 'Playwright'].map((name) => (
                <div key={name} className="settings-row">
                  <label>{name}</label>
                  <button className="btn-small" disabled>Install</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'git' && (
          <div className="settings-panel">
            <h2>Git</h2>
            <div className="settings-section">
              <h3>Branch Prefix</h3>
              <div className="settings-row">
                <label>Prefix for new branches</label>
                {editingBranchPrefix ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      value={branchPrefixValue}
                      onChange={e => setBranchPrefixValue(e.target.value)}
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 4, padding: '3px 8px', width: 140 }}
                    />
                    <button className="btn-small btn-primary" disabled={savingBranchPrefix} onClick={async () => {
                      if (!onWriteConfig) return;
                      setSavingBranchPrefix(true);
                      try { await onWriteConfig('git.branchPrefix', branchPrefixValue); setEditingBranchPrefix(false); } catch {}
                      setSavingBranchPrefix(false);
                    }}>{savingBranchPrefix ? '...' : 'Save'}</button>
                    <button className="btn-small" onClick={() => setEditingBranchPrefix(false)}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="settings-value" style={{ fontFamily: 'var(--font-mono)' }}>
                      {String(getConfigValue(codexConfig, 'git.branchPrefix') ?? getConfigValue(codexConfig, 'branchPrefix') ?? 'codex/')}
                    </span>
                    {onWriteConfig && (
                      <button className="btn-small" onClick={() => {
                        const current = getConfigValue(codexConfig, 'git.branchPrefix') ?? getConfigValue(codexConfig, 'branchPrefix') ?? 'codex/';
                        setBranchPrefixValue(String(current));
                        setEditingBranchPrefix(true);
                      }}>Edit</button>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="settings-section">
              <h3>Push Settings</h3>
              <div className="settings-row">
                <label>Force push with lease</label>
                {onWriteConfig ? (
                  <button className="btn-small" onClick={() => onWriteConfig('git.forcePush', !(getConfigValue(codexConfig, 'git.forcePush') === true))}>
                    {getConfigValue(codexConfig, 'git.forcePush') === true ? 'On' : 'Off'}
                  </button>
                ) : (
                  <span className="settings-value">{getConfigValue(codexConfig, 'git.forcePush') === true ? 'On' : 'Off'}</span>
                )}
              </div>
              <div className="settings-row">
                <label>Draft pull requests</label>
                {onWriteConfig ? (
                  <button className="btn-small" onClick={() => onWriteConfig('git.draftPullRequests', !(getConfigValue(codexConfig, 'git.draftPullRequests') === true))}>
                    {getConfigValue(codexConfig, 'git.draftPullRequests') === true ? 'On' : 'Off'}
                  </button>
                ) : (
                  <span className="settings-value">{getConfigValue(codexConfig, 'git.draftPullRequests') === true ? 'On' : 'Off'}</span>
                )}
              </div>
            </div>
            <div className="settings-section">
              <h3>Commit Instructions</h3>
              {(() => {
                const commitInstructions = getConfigValue(codexConfig, 'git.commitInstructions') ?? getConfigValue(codexConfig, 'commitInstructions');
                return commitInstructions ? (
                  <pre className="settings-text-block" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {String(commitInstructions)}
                  </pre>
                ) : (
                  <div className="settings-text-block">
                    Add commit message guidelines in your Codex config file to customize how Codex generates commit messages.
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {tab === 'archived' && (
          <div className="settings-panel">
            <h2>Archived Threads</h2>
            {loadingArchived ? (
              <div className="settings-text-block">Loading archived threads...</div>
            ) : archivedThreads.length === 0 ? (
              <div className="empty-section-card">
                <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
                  No archived threads.
                </span>
              </div>
            ) : (
              <div className="archived-list">
                {archivedThreads.map((t) => (
                  <div key={t.id} className="archived-item">
                    <div className="archived-info">
                      <span className="archived-name">{t.name || t.preview || 'Untitled'}</span>
                      <span className="archived-meta">
                        {new Date((t.updatedAt ?? t.createdAt) * 1000).toLocaleDateString()}
                        {t.cwd && ` · ${folderName(t.cwd)}`}
                      </span>
                    </div>
                    <button className="btn-small" onClick={async () => {
                      try {
                        await client.unarchiveThread(t.id);
                        setArchivedThreads((prev) => prev.filter((x) => x.id !== t.id));
                      } catch { /* ignore */ }
                    }}>
                      Unarchive
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
