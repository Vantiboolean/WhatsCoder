/**
 * Design tokens matching Cursor's visual language.
 * Platform-agnostic values — each app applies these to its own styling system.
 */

export const colors = {
  bg: {
    primary: '#1b1913',
    secondary: '#14120b',
    tertiary: '#1d1b15',
    elevated: '#26241e',
    hover: 'rgba(237, 236, 236, 0.07)',
    input: '#201e18',
  },
  text: {
    primary: 'rgba(237, 236, 236, 0.93)',
    secondary: 'rgba(237, 236, 236, 0.55)',
    tertiary: 'rgba(237, 236, 236, 0.37)',
    inverse: '#14120b',
    link: '#599CE7',
  },
  accent: {
    primary: '#599CE7',
    primaryHover: '#4A8DD4',
    primaryMuted: 'rgba(89, 156, 231, 0.16)',
    primaryBorder: 'rgba(89, 156, 231, 0.35)',
    primaryLight: '#3C7CAB',
    primaryLightHover: '#206595',
    emerald: '#4ec9b0',
    emeraldLight: '#158f77',
    skill: '#b495ff',
    skillLight: '#8d68e6',
  },
  border: {
    primary: 'rgba(228, 228, 228, 0.15)',
    secondary: 'rgba(228, 228, 228, 0.22)',
    subtle: 'rgba(228, 228, 228, 0.09)',
  },
  status: {
    active: '#599CE7',
    idle: '#6d7682',
    error: '#e06c75',
    warning: '#d7ba7d',
    info: '#599CE7',
  },
  item: {
    userMessage: '#1e1e1e',
    agentMessage: 'transparent',
    commandBg: '#141414',
    fileDiffBg: '#1a1a1a',
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
  sm: 2,
  md: 4,
  lg: 6,
  xl: 8,
  full: 999,
} as const;

export const typography = {
  fontFamily: {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    mono: 'Consolas, "JetBrains Mono", "Courier New", monospace',
  },
  size: {
    xs: 10,
    sm: 12,
    md: 13,
    lg: 14,
    xl: 16,
    xxl: 22,
    title: 24,
  },
  weight: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
  },
} as const;
