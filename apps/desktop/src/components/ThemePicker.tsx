import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { THEME_PRESETS, type ThemePreset, type ThemeMode } from '../lib/settingsHelpers';

interface ThemePickerProps {
  theme: ThemeMode;
  themePreset: string;
  onThemeChange: (mode: ThemeMode) => void;
  onPresetSelect: (presetId: string) => void;
  className?: string;
}

export function ThemePicker({
  theme,
  themePreset,
  onThemeChange,
  onPresetSelect,
  className,
}: ThemePickerProps) {
  const { t } = useTranslation();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const currentPreset = THEME_PRESETS.find(p => p.id === themePreset) ?? THEME_PRESETS[0];

  return (
    <div className={`theme-picker${className ? ` ${className}` : ''}`}>
      <div className="theme-picker-modes">
        {(['dark', 'light', 'system'] as ThemeMode[]).map((mode) => (
          <button
            key={mode}
            className={`theme-picker-mode${theme === mode ? ' theme-picker-mode--active' : ''}`}
            onClick={() => onThemeChange(mode)}
          >
            <div className={`theme-picker-mode-preview theme-picker-mode-preview--${mode}`} />
            <span>{t(`settings.${mode}`)}</span>
          </button>
        ))}
      </div>

      <div className="theme-picker-preset-section" ref={dropdownRef}>
        <button
          className="theme-picker-preset-trigger"
          onClick={() => setDropdownOpen(!dropdownOpen)}
        >
          <span className="theme-picker-swatch" style={{ background: currentPreset.previewColor }} />
          <span className="theme-picker-preset-label">{currentPreset.label}</span>
          <svg
            className={`theme-picker-chevron${dropdownOpen ? ' theme-picker-chevron--open' : ''}`}
            width="10" height="10" viewBox="0 0 10 10"
            fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          >
            <path d="M3 4l2 2 2-2" />
          </svg>
        </button>

        {dropdownOpen && (
          <div className="theme-picker-preset-menu">
            {THEME_PRESETS.map((preset: ThemePreset) => (
              <button
                key={preset.id}
                className={`theme-picker-preset-item${themePreset === preset.id ? ' theme-picker-preset-item--active' : ''}`}
                onClick={() => {
                  onPresetSelect(preset.id);
                  setDropdownOpen(false);
                }}
              >
                <span className="theme-picker-swatch" style={{ background: preset.previewColor }} />
                <span>{preset.label}</span>
                {themePreset === preset.id && (
                  <svg className="theme-picker-check" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="2,6 5,9 10,3" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
