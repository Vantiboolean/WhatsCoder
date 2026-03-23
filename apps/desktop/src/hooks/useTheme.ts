import { useEffect, useCallback } from 'react';
import {
  type ThemeMode,
  type ChromeThemeConfig,
  THEME_PRESETS, DEFAULT_THEME_PRESET,
  applyThemeConfig, applyFontSizes, resolveThemeVariant,
  getDefaultThemeConfig,
} from '../lib/settingsHelpers';

function applyThemeToDOM(mode: ThemeMode) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
  if (resolved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

interface UseThemeOptions {
  theme: ThemeMode;
  themeConfig: ChromeThemeConfig;
  themePreset: string;
  uiFontSize: number;
  codeFontSize: number;
  pointerCursor: boolean;
  onThemeChange: (theme: ThemeMode) => void;
  onThemeConfigChange: (config: ChromeThemeConfig) => void;
  onThemePresetChange: (presetId: string) => void;
}

export function useTheme({
  theme,
  themeConfig,
  themePreset,
  uiFontSize,
  codeFontSize,
  pointerCursor,
  onThemeChange,
  onThemeConfigChange,
  onThemePresetChange,
}: UseThemeOptions) {
  const activeVariant = resolveThemeVariant(theme);

  useEffect(() => {
    applyThemeToDOM(theme);
    const v = resolveThemeVariant(theme);
    applyThemeConfig(themeConfig, v);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (theme === 'system') {
        applyThemeToDOM('system');
        applyThemeConfig(themeConfig, resolveThemeVariant('system'));
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme, themeConfig]);

  useEffect(() => {
    applyFontSizes(uiFontSize, codeFontSize);
  }, [uiFontSize, codeFontSize]);

  useEffect(() => {
    document.documentElement.classList.toggle('use-pointer-cursor', pointerCursor);
  }, [pointerCursor]);

  const selectPreset = useCallback((presetId: string) => {
    const preset = THEME_PRESETS.find(p => p.id === presetId);
    if (!preset) return;
    onThemePresetChange(presetId);
    const colors = activeVariant === 'dark' ? preset.dark : preset.light;
    onThemeConfigChange({ ...themeConfig, accent: colors.accent, surface: colors.surface, ink: colors.ink });
  }, [activeVariant, themeConfig, onThemePresetChange, onThemeConfigChange]);

  const changeMode = useCallback((mode: ThemeMode) => {
    onThemeChange(mode);
    const newVariant = mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : (mode === 'light' ? 'light' : 'dark');
    const preset = THEME_PRESETS.find(p => p.id === themePreset);
    if (preset) {
      const colors = newVariant === 'dark' ? preset.dark : preset.light;
      onThemeConfigChange({ ...themeConfig, accent: colors.accent, surface: colors.surface, ink: colors.ink });
    }
  }, [themePreset, themeConfig, onThemeChange, onThemeConfigChange]);

  const setCustomAccent = useCallback((accent: string) => {
    onThemeConfigChange({ ...themeConfig, accent });
  }, [themeConfig, onThemeConfigChange]);

  return {
    activeVariant,
    currentPreset: THEME_PRESETS.find(p => p.id === themePreset) ?? THEME_PRESETS[0],
    presets: THEME_PRESETS,
    selectPreset,
    changeMode,
    setCustomAccent,
  };
}

export { THEME_PRESETS, DEFAULT_THEME_PRESET, getDefaultThemeConfig };
