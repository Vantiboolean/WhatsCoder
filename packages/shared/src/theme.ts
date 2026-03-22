/**
 * Design tokens matching the Codex desktop app's visual language.
 * Platform-agnostic values — each app applies these to its own styling system.
 */

export const colors = {
  bg: {
    primary: '#0d0d0e',
    secondary: '#161617',
    tertiary: '#1e1e1f',
    elevated: '#252527',
    hover: '#2a2a2c',
    input: '#1a1a1c',
  },
  text: {
    primary: '#e5e5e5',
    secondary: '#a0a0a0',
    tertiary: '#6e6e6e',
    inverse: '#0d0d0e',
    link: '#339cff',
  },
  accent: {
    // Codex blue — dark mode
    primary: '#339cff',
    primaryHover: '#1a8aff',
    primaryMuted: 'rgba(51, 156, 255, 0.15)',
    primaryBorder: 'rgba(51, 156, 255, 0.3)',
    // Codex blue — light mode
    primaryLight: '#0285ff',
    primaryLightHover: '#006ee0',
    // Semantic green for ok/diff states
    emerald: '#40c977',
    emeraldLight: '#00a240',
    // Skill purple
    skill: '#ad7bf9',
    skillLight: '#924ff7',
  },
  border: {
    primary: '#2a2a2c',
    secondary: '#3a3a3c',
    subtle: '#1f1f21',
  },
  status: {
    active: '#339cff',
    idle: '#6e6e6e',
    error: '#ef4444',
    warning: '#f59e0b',
    info: '#339cff',
  },
  item: {
    userMessage: '#1a2332',
    agentMessage: 'transparent',
    commandBg: '#131318',
    fileDiffBg: '#111116',
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  full: 999,
} as const;

export const typography = {
  fontFamily: {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: '"SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
  },
  size: {
    xs: 11,
    sm: 13,
    md: 15,
    lg: 17,
    xl: 20,
    xxl: 24,
    title: 28,
  },
  weight: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
  },
} as const;
