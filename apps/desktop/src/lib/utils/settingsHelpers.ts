import type { ConnectionState, AccountInfo, CodexClient, ThreadSummary } from '@whats-coder/shared';

export type ThemeMode = 'dark' | 'light' | 'system';
export type ApprovalPolicyValue = 'untrusted' | 'on-failure' | 'on-request' | 'never' | 'granular';
export type SandboxModeValue = 'read-only' | 'workspace-write' | 'danger-full-access';
export type AutonomyModeValue = 'suggest' | 'auto-edit' | 'full-auto' | 'custom';
export type NotificationPref = 'always' | 'unfocused' | 'never';
export type SettingsTab = 'general' | 'connections' | 'appearance' | 'config' | 'personalization' | 'mcp' | 'git' | 'archived';

export interface ChromeThemeConfig {
  accent: string;
  surface: string;
  ink: string;
  contrast: number;
  fonts: { ui: string | null; code: string | null };
  opaqueWindows: boolean;
  semanticColors: { diffAdded: string; diffRemoved: string; skill: string };
}

export interface ThemePreset {
  id: string;
  label: string;
  dark: { accent: string; surface: string; ink: string };
  light: { accent: string; surface: string; ink: string };
  previewColor: string;
}

export type RateLimitWindowState = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CreditsSnapshotState = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
};

export type RateLimitSnapshotState = {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  primary: RateLimitWindowState | null;
  secondary: RateLimitWindowState | null;
  credits: CreditsSnapshotState | null;
};

export type SkillDetail = { name: string; path: string; description?: string; tags?: string[] };

export const AUTONOMY_PRESETS: Record<Exclude<AutonomyModeValue, 'custom'>, { approvalPolicy: ApprovalPolicyValue; sandboxMode: SandboxModeValue }> = {
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

export const SETTINGS_TAB_KEYS: { id: SettingsTab; key: string }[] = [
  { id: 'general', key: 'settings.general' },
  { id: 'connections', key: 'settings.connections' },
  { id: 'appearance', key: 'settings.appearance' },
  { id: 'config', key: 'settings.configuration' },
  { id: 'personalization', key: 'settings.personalization' },
  { id: 'mcp', key: 'settings.mcpServers' },
  { id: 'git', key: 'settings.git' },
  { id: 'archived', key: 'settings.archivedThreads' },
];

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'codex', label: 'Codex', dark: { accent: '#0169cc', surface: '#111111', ink: '#fcfcfc' }, light: { accent: '#0169cc', surface: '#ffffff', ink: '#1a1a1b' }, previewColor: '#0169cc' },
  { id: 'linear', label: 'Linear', dark: { accent: '#5e6ad2', surface: '#17181d', ink: '#e6e9ef' }, light: { accent: '#5e6ad2', surface: '#ffffff', ink: '#1a1a1b' }, previewColor: '#5e6ad2' },
  { id: 'absolutely', label: 'Absolutely', dark: { accent: '#cc7d5e', surface: '#2d2d2b', ink: '#f9f9f7' }, light: { accent: '#cc7d5e', surface: '#f9f9f7', ink: '#2d2d2b' }, previewColor: '#cc7d5e' },
  { id: 'ayu', label: 'Ayu', dark: { accent: '#e6b450', surface: '#0b0e14', ink: '#bfbdb6' }, light: { accent: '#e6b450', surface: '#fafafa', ink: '#575f66' }, previewColor: '#e6b450' },
  { id: 'catppuccin', label: 'Catppuccin', dark: { accent: '#cba6f7', surface: '#1e1e2e', ink: '#cdd6f4' }, light: { accent: '#8839ef', surface: '#eff1f5', ink: '#4c4f69' }, previewColor: '#cba6f7' },
  { id: 'dracula', label: 'Dracula', dark: { accent: '#bd93f9', surface: '#282a36', ink: '#f8f8f2' }, light: { accent: '#7c3aed', surface: '#f8f8f2', ink: '#282a36' }, previewColor: '#bd93f9' },
  { id: 'everforest', label: 'Everforest', dark: { accent: '#a7c080', surface: '#2d353b', ink: '#d3c6aa' }, light: { accent: '#8da101', surface: '#fdf6e3', ink: '#5c6a72' }, previewColor: '#a7c080' },
  { id: 'github', label: 'GitHub', dark: { accent: '#1f6feb', surface: '#0d1117', ink: '#e6edf3' }, light: { accent: '#0969da', surface: '#ffffff', ink: '#1f2328' }, previewColor: '#1f6feb' },
  { id: 'gruvbox', label: 'Gruvbox', dark: { accent: '#d79921', surface: '#282828', ink: '#ebdbb2' }, light: { accent: '#b57614', surface: '#fbf1c7', ink: '#3c3836' }, previewColor: '#d79921' },
  { id: 'material', label: 'Material', dark: { accent: '#82aaff', surface: '#212121', ink: '#eeffff' }, light: { accent: '#6182b8', surface: '#fafafa', ink: '#90a4ae' }, previewColor: '#82aaff' },
  { id: 'monokai', label: 'Monokai', dark: { accent: '#a6e22e', surface: '#272822', ink: '#f8f8f2' }, light: { accent: '#78a21a', surface: '#fafaf8', ink: '#49483e' }, previewColor: '#a6e22e' },
  { id: 'nord', label: 'Nord', dark: { accent: '#88c0d0', surface: '#2e3440', ink: '#eceff4' }, light: { accent: '#5e81ac', surface: '#eceff4', ink: '#2e3440' }, previewColor: '#88c0d0' },
  { id: 'notion', label: 'Notion', dark: { accent: '#3183d8', surface: '#191919', ink: '#d9d9d8' }, light: { accent: '#2383e2', surface: '#ffffff', ink: '#37352f' }, previewColor: '#3183d8' },
  { id: 'one-dark', label: 'One Dark', dark: { accent: '#61afef', surface: '#282c34', ink: '#abb2bf' }, light: { accent: '#4078f2', surface: '#fafafa', ink: '#383a42' }, previewColor: '#61afef' },
  { id: 'rose-pine', label: 'Rosé Pine', dark: { accent: '#c4a7e7', surface: '#232136', ink: '#e0def4' }, light: { accent: '#907aa9', surface: '#faf4ed', ink: '#575279' }, previewColor: '#c4a7e7' },
  { id: 'solarized', label: 'Solarized', dark: { accent: '#2aa198', surface: '#002b36', ink: '#839496' }, light: { accent: '#2aa198', surface: '#fdf6e3', ink: '#657b83' }, previewColor: '#2aa198' },
  { id: 'tokyo-night', label: 'Tokyo Night', dark: { accent: '#7aa2f7', surface: '#1a1b26', ink: '#a9b1d6' }, light: { accent: '#34548a', surface: '#d5d6db', ink: '#343b58' }, previewColor: '#7aa2f7' },
  { id: 'sentry', label: 'Sentry', dark: { accent: '#7055f6', surface: '#2d2935', ink: '#e6dff9' }, light: { accent: '#6c5fc7', surface: '#f5f3f7', ink: '#2d2935' }, previewColor: '#7055f6' },
  { id: 'lobster', label: 'Lobster', dark: { accent: '#ff5c5c', surface: '#111827', ink: '#e4e4e7' }, light: { accent: '#dc2626', surface: '#ffffff', ink: '#111827' }, previewColor: '#ff5c5c' },
  { id: 'matrix', label: 'Matrix', dark: { accent: '#1eff5a', surface: '#040805', ink: '#b8ffca' }, light: { accent: '#00a240', surface: '#f0fff4', ink: '#0a3d19' }, previewColor: '#1eff5a' },
];

export const DEFAULT_THEME_PRESET = 'codex';

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function folderName(cwd?: string): string {
  if (!cwd) return '';
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

export function getConfigRoot(config: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!config) return null;
  if (isObject(config.config)) return config.config;
  return config;
}

export function getConfigValue(config: Record<string, unknown> | null, path: string): unknown {
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

export function getApprovalPolicyValue(config: Record<string, unknown> | null): ApprovalPolicyValue | undefined {
  const raw = getConfigValue(config, 'approvalPolicy') ?? getConfigValue(config, 'approval_policy');
  if (typeof raw === 'string') {
    if (raw === 'untrusted' || raw === 'on-failure' || raw === 'on-request' || raw === 'never') return raw;
    return undefined;
  }
  if (raw && typeof raw === 'object' && 'granular' in (raw as Record<string, unknown>)) return 'granular';
  return undefined;
}

export function getSandboxModeValue(config: Record<string, unknown> | null): SandboxModeValue | undefined {
  const raw = getConfigValue(config, 'sandboxMode') ?? getConfigValue(config, 'sandbox_mode') ?? getConfigValue(config, 'sandbox');
  if (raw === 'read-only' || raw === 'workspace-write' || raw === 'danger-full-access') return raw;
  return undefined;
}

export function getEffectiveApprovalPolicyValue(config: Record<string, unknown> | null): ApprovalPolicyValue {
  return getApprovalPolicyValue(config) ?? 'untrusted';
}

export function getEffectiveSandboxModeValue(config: Record<string, unknown> | null): SandboxModeValue {
  return getSandboxModeValue(config) ?? 'read-only';
}

export function deriveAutonomyModeFromConfig(config: Record<string, unknown> | null): AutonomyModeValue {
  if (!config) return 'suggest';
  const approvalPolicy = getEffectiveApprovalPolicyValue(config);
  const sandboxMode = getEffectiveSandboxModeValue(config);
  if (approvalPolicy === AUTONOMY_PRESETS.suggest.approvalPolicy && sandboxMode === AUTONOMY_PRESETS.suggest.sandboxMode) return 'suggest';
  if (approvalPolicy === AUTONOMY_PRESETS['auto-edit'].approvalPolicy && sandboxMode === AUTONOMY_PRESETS['auto-edit'].sandboxMode) return 'auto-edit';
  if (sandboxMode === AUTONOMY_PRESETS['full-auto'].sandboxMode && (approvalPolicy === AUTONOMY_PRESETS['full-auto'].approvalPolicy || approvalPolicy === 'on-failure')) return 'full-auto';
  return 'custom';
}

export function formatAutonomyModeLabel(mode: AutonomyModeValue): string {
  switch (mode) {
    case 'suggest': return 'Suggest';
    case 'auto-edit': return 'Auto Edit';
    case 'full-auto': return 'Full Auto';
    default: return 'Custom';
  }
}

export function formatAutonomyModeDetail(config: Record<string, unknown> | null, mode: AutonomyModeValue): string | null {
  if (mode !== 'custom') return null;
  const approvalPolicy = getApprovalPolicyValue(config) ?? 'unknown';
  const sandboxMode = getSandboxModeValue(config) ?? 'unknown';
  return `${approvalPolicy} · ${sandboxMode}`;
}

export function getAutonomyModeSummary(config: Record<string, unknown> | null): string {
  const approvalPolicy = getEffectiveApprovalPolicyValue(config);
  const sandboxMode = getEffectiveSandboxModeValue(config);
  return `${approvalPolicy} / ${sandboxMode}`;
}

export function formatRateLimitResetTime(unixSec: number | null): string {
  if (typeof unixSec !== 'number' || !Number.isFinite(unixSec)) return 'Unknown';
  return new Date(unixSec * 1000).toLocaleString();
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

export function mixHex(c1: string, c2: string, amount: number): string {
  const [r1, g1, b1] = hexToRgb(c1);
  const [r2, g2, b2] = hexToRgb(c2);
  return rgbToHex(r1 + (r2 - r1) * amount, g1 + (g2 - g1) * amount, b1 + (b2 - b1) * amount);
}

export function hexAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

const THEME_STRING_PREFIX = 'codex-theme-v1:';

export function getDefaultThemeConfig(variant: 'dark' | 'light'): ChromeThemeConfig {
  const preset = THEME_PRESETS.find(p => p.id === DEFAULT_THEME_PRESET) ?? THEME_PRESETS[0];
  const colors = variant === 'dark' ? preset.dark : preset.light;
  return {
    ...colors,
    contrast: 60,
    fonts: { ui: null, code: null },
    opaqueWindows: true,
    semanticColors: variant === 'dark'
      ? { diffAdded: '#40c977', diffRemoved: '#fa423e', skill: '#ad7bf9' }
      : { diffAdded: '#00a240', diffRemoved: '#ba2623', skill: '#924ff7' },
  };
}

export function exportThemeString(config: ChromeThemeConfig, variant: 'dark' | 'light'): string {
  return THEME_STRING_PREFIX + JSON.stringify({ variant, theme: config });
}

export function importThemeString(str: string): { variant: 'dark' | 'light'; theme: ChromeThemeConfig } | null {
  try {
    const trimmed = str.trim();
    if (!trimmed.startsWith(THEME_STRING_PREFIX)) return null;
    const json = trimmed.slice(THEME_STRING_PREFIX.length);
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const v = parsed.variant;
    if (v !== 'dark' && v !== 'light') return null;
    const t = parsed.theme;
    if (!t || typeof t.accent !== 'string' || typeof t.surface !== 'string' || typeof t.ink !== 'string') return null;
    const defaults = getDefaultThemeConfig(v);
    return {
      variant: v,
      theme: {
        accent: t.accent,
        surface: t.surface,
        ink: t.ink,
        contrast: typeof t.contrast === 'number' ? Math.max(0, Math.min(100, t.contrast)) : 60,
        fonts: { ui: t.fonts?.ui ?? null, code: t.fonts?.code ?? null },
        opaqueWindows: typeof t.opaqueWindows === 'boolean' ? t.opaqueWindows : true,
        semanticColors: {
          diffAdded: t.semanticColors?.diffAdded ?? defaults.semanticColors.diffAdded,
          diffRemoved: t.semanticColors?.diffRemoved ?? defaults.semanticColors.diffRemoved,
          skill: t.semanticColors?.skill ?? defaults.semanticColors.skill,
        },
      },
    };
  } catch {
    return null;
  }
}

export function applyThemeConfig(config: ChromeThemeConfig, variant: 'dark' | 'light') {
  const root = document.documentElement;
  const { accent, surface, ink, contrast } = config;
  const c = contrast / 100;

  root.style.setProperty('--bg-primary', surface);
  root.style.setProperty('--bg-secondary', mixHex(surface, ink, 0.03 + c * 0.02));
  root.style.setProperty('--bg-tertiary', mixHex(surface, ink, 0.06 + c * 0.03));
  root.style.setProperty('--bg-elevated', mixHex(surface, ink, 0.09 + c * 0.04));
  root.style.setProperty('--bg-hover', mixHex(surface, ink, 0.10 + c * 0.05));
  root.style.setProperty('--bg-input', mixHex(surface, ink, 0.04 + c * 0.02));
  root.style.setProperty('--surface-secondary', mixHex(surface, ink, 0.03 + c * 0.02));

  root.style.setProperty('--text-primary', ink);
  root.style.setProperty('--text-secondary', mixHex(ink, surface, 0.35 - c * 0.1));
  root.style.setProperty('--text-tertiary', mixHex(ink, surface, 0.55 - c * 0.1));
  root.style.setProperty('--text-inverse', surface);

  root.style.setProperty('--accent-green', accent);
  root.style.setProperty('--accent-green-hover', mixHex(accent, variant === 'dark' ? '#ffffff' : '#000000', 0.1));
  root.style.setProperty('--accent-green-muted', hexAlpha(accent, 0.15));
  root.style.setProperty('--accent-green-border', hexAlpha(accent, 0.3));
  root.style.setProperty('--accent-green-subtle', hexAlpha(accent, 0.08));
  root.style.setProperty('--accent-green-hover-bg', hexAlpha(accent, 0.25));
  root.style.setProperty('--accent-green-soft', hexAlpha(accent, 0.12));
  root.style.setProperty('--accent-green-faint', hexAlpha(accent, 0.04));
  root.style.setProperty('--accent-blue', accent);
  root.style.setProperty('--accent-blue-muted', hexAlpha(accent, 0.12));
  root.style.setProperty('--accent-blue-subtle', hexAlpha(accent, 0.06));
  root.style.setProperty('--accent-blue-border', hexAlpha(accent, 0.3));
  root.style.setProperty('--accent-blue-soft', hexAlpha(accent, 0.1));
  root.style.setProperty('--accent-blue-border-soft', hexAlpha(accent, 0.25));
  root.style.setProperty('--accent-blue-hover', hexAlpha(accent, 0.2));
  root.style.setProperty('--accent-blue-faint', hexAlpha(accent, 0.08));
  root.style.setProperty('--accent-blue-strong', hexAlpha(accent, 0.4));

  const borderAlpha = 0.06 + c * 0.04;
  root.style.setProperty('--border-primary', mixHex(surface, ink, borderAlpha));
  root.style.setProperty('--border-secondary', mixHex(surface, ink, borderAlpha * 1.5));
  root.style.setProperty('--border-subtle', mixHex(surface, ink, borderAlpha * 0.6));

  root.style.setProperty('--status-active', accent);
  root.style.setProperty('--status-info', accent);
  root.style.setProperty('--border-active', accent);

  root.style.setProperty('--diff-added', config.semanticColors.diffAdded);
  root.style.setProperty('--diff-removed', config.semanticColors.diffRemoved);
  root.style.setProperty('--skill-color', config.semanticColors.skill);
  root.style.setProperty('--accent-emerald', config.semanticColors.diffAdded);
  root.style.setProperty('--accent-emerald-muted', hexAlpha(config.semanticColors.diffAdded, 0.12));
  root.style.setProperty('--accent-emerald-subtle', hexAlpha(config.semanticColors.diffAdded, 0.08));

  if (config.fonts.ui) {
    root.style.setProperty('--font-sans', config.fonts.ui);
  } else {
    root.style.removeProperty('--font-sans');
  }
  if (config.fonts.code) {
    root.style.setProperty('--font-mono', config.fonts.code);
  } else {
    root.style.removeProperty('--font-mono');
  }

  root.style.setProperty('--shadow-focus', `0 0 0 3px ${hexAlpha(accent, 0.15)}`);
  root.style.setProperty('--shadow-focus-blue', `0 0 0 2px ${hexAlpha(accent, 0.25)}`);
}

export function applyFontSizes(uiSize: number, codeSize: number) {
  document.documentElement.style.setProperty('--ui-font-size', `${uiSize}px`);
  document.documentElement.style.setProperty('--code-font-size', `${codeSize}px`);
  document.body.style.fontSize = `${uiSize}px`;
}

export function resolveThemeVariant(theme: ThemeMode): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme === 'light' ? 'light' : 'dark';
}
