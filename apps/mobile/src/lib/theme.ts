import { Platform } from 'react-native';

export { colors, spacing, radius } from '@codex-mobile/shared';

export const typography = {
  fontFamily: {
    sans: 'System',
    mono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
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
  lineHeight: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.7,
  },
} as const;
