import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionState, AccountInfo, CodexClient, ThreadSummary } from '@whats-coder/shared';
import {
  type ThemeMode, type AutonomyModeValue, type NotificationPref,
  type ChromeThemeConfig, type RateLimitSnapshotState, type SettingsTab,
  SETTINGS_TAB_KEYS, THEME_PRESETS,
  getConfigValue, getConfigRoot,
  getEffectiveApprovalPolicyValue, getEffectiveSandboxModeValue,
  deriveAutonomyModeFromConfig, formatAutonomyModeLabel, formatAutonomyModeDetail,
  getAutonomyModeSummary, formatRateLimitResetTime,
  exportThemeString, importThemeString, applyFontSizes, resolveThemeVariant,
  folderName,
} from '../lib/settingsHelpers';
import { ConnectionsPanel } from './ConnectionsPanel';
import { DesktopPageShell } from './DesktopPageShell';
import { McpSettingsPanel } from './McpSettingsPanel';

export function SettingsView({
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
  onRefreshMcp,
  onConnect,
  onDisconnect,
  uiFontSize,
  onUiFontSizeChange,
  codeFontSize,
  onCodeFontSizeChange,
  notificationPref,
  onNotificationPrefChange,
  themePreset,
  onThemePresetChange,
  themeConfig,
  onThemeConfigChange,
  pointerCursor,
  onPointerCursorChange,
  onAutonomyModeChange,
  autonomyMode: externalAutonomyMode,
  isUpdatingAutonomy,
  serverStarting,
  serverRunning,
  serverLog,
  codexBinPath,
  onCodexBinPathChange,
  codexCandidates,
  onStartServer,
  onStopServer,
  onBrowseCodexBinary,
  windowControls,
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
  onRefreshMcp?: () => Promise<unknown>;
  onConnect?: (url: string) => void;
  onDisconnect?: () => void;
  uiFontSize: number;
  onUiFontSizeChange: (size: number) => void;
  codeFontSize: number;
  onCodeFontSizeChange: (size: number) => void;
  notificationPref: NotificationPref;
  onNotificationPrefChange: (pref: NotificationPref) => void;
  themePreset: string;
  onThemePresetChange: (presetId: string) => void;
  themeConfig: ChromeThemeConfig;
  onThemeConfigChange: (config: ChromeThemeConfig) => void;
  pointerCursor: boolean;
  onPointerCursorChange: (enabled: boolean) => void;
  onAutonomyModeChange?: (mode: string) => void;
  autonomyMode: AutonomyModeValue;
  isUpdatingAutonomy?: boolean;
  serverStarting?: boolean;
  serverRunning?: boolean;
  serverLog?: string;
  codexBinPath?: string;
  onCodexBinPathChange?: (path: string) => void;
  codexCandidates?: string[];
  onStartServer?: () => void;
  onStopServer?: () => void;
  onBrowseCodexBinary?: () => void;
  windowControls?: import('react').ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<SettingsTab>('general');
  const [archivedThreads, setArchivedThreads] = useState<ThreadSummary[]>([]);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [instructionsValue, setInstructionsValue] = useState('');
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [editingBranchPrefix, setEditingBranchPrefix] = useState(false);
  const [branchPrefixValue, setBranchPrefixValue] = useState('');
  const [savingBranchPrefix, setSavingBranchPrefix] = useState(false);
  const [editingCommitInstructions, setEditingCommitInstructions] = useState(false);
  const [commitInstructionsValue, setCommitInstructionsValue] = useState('');
  const [savingCommitInstructions, setSavingCommitInstructions] = useState(false);
  const [editingProfileName, setEditingProfileName] = useState(false);
  const [profileNameValue, setProfileNameValue] = useState('');
  const [savingProfileName, setSavingProfileName] = useState(false);
  const [editingResponseLang, setEditingResponseLang] = useState(false);
  const [responseLangValue, setResponseLangValue] = useState('');
  const [savingResponseLang, setSavingResponseLang] = useState(false);
  const [themeImportOpen, setThemeImportOpen] = useState(false);
  const [themeImportValue, setThemeImportValue] = useState('');
  const [presetDropdownOpen, setPresetDropdownOpen] = useState(false);
  const presetDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!presetDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (presetDropdownRef.current && !presetDropdownRef.current.contains(e.target as Node)) {
        setPresetDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [presetDropdownOpen]);

  const activeVariant = resolveThemeVariant(theme);
  const patch = (p: Partial<ChromeThemeConfig>) => onThemeConfigChange({ ...themeConfig, ...p });
  const patchFonts = (p: Partial<ChromeThemeConfig['fonts']>) => onThemeConfigChange({ ...themeConfig, fonts: { ...themeConfig.fonts, ...p } });
  const patchSemantic = (p: Partial<ChromeThemeConfig['semanticColors']>) => onThemeConfigChange({ ...themeConfig, semanticColors: { ...themeConfig.semanticColors, ...p } });

  const handlePresetSelect = (presetId: string) => {
    const preset = THEME_PRESETS.find(p => p.id === presetId);
    if (!preset) return;
    onThemePresetChange(presetId);
    const colors = activeVariant === 'dark' ? preset.dark : preset.light;
    onThemeConfigChange({ ...themeConfig, accent: colors.accent, surface: colors.surface, ink: colors.ink });
    setPresetDropdownOpen(false);
  };

  const handleThemeVariantChange = (t: ThemeMode) => {
    onThemeChange(t);
    const newVariant = t === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : (t === 'light' ? 'light' : 'dark');
    const preset = THEME_PRESETS.find(p => p.id === themePreset);
    if (preset) {
      const colors = newVariant === 'dark' ? preset.dark : preset.light;
      onThemeConfigChange({ ...themeConfig, accent: colors.accent, surface: colors.surface, ink: colors.ink });
    }
  };

  const colorRow = (label: string, value: string, onSet: (v: string) => void) => (
    <div className="settings-row">
      <label>{label}</label>
      <div className="settings-color-input">
        <input type="color" value={value} onChange={e => onSet(e.target.value)} className="settings-color-native" />
        <input
          type="text"
          value={value}
          onChange={e => { const v = e.target.value; if (/^#[0-9a-fA-F]{0,6}$/.test(v)) onSet(v); }}
          onBlur={e => { if (!/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onSet(value); }}
          className="settings-color-hex"
          spellCheck={false}
        />
      </div>
    </div>
  );

  const currentPreset = THEME_PRESETS.find(p => p.id === themePreset) ?? THEME_PRESETS[0];

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
    <DesktopPageShell
      className="settings-page"
      bodyClassName="settings-page__body"
      title="Settings"
      windowControls={windowControls}
    >
      <div className="desktop-page-surface desktop-page-surface--no-padding settings-shell">
        <div className="settings-layout">
          <nav className="settings-tabs">
            {SETTINGS_TAB_KEYS.map((tabDef) => (
              <button
                key={tabDef.id}
                className={`settings-tab${tab === tabDef.id ? ' settings-tab--active' : ''}`}
                onClick={() => setTab(tabDef.id)}
              >
                {t(tabDef.key)}
              </button>
            ))}
          </nav>
          <div className="settings-content">
        {tab === 'general' && (
          <div className="settings-panel">
            <h2>{t('settings.general')}</h2>
            <div className="settings-section">
              <h3>{t('settings.language')}</h3>
              <p className="settings-hint">
                {t('settings.languageDesc')}
              </p>
              <div className="settings-row">
                <label>{t('settings.language')}</label>
                <select
                  className="settings-select"
                  value={i18n.language}
                  onChange={(e) => { void i18n.changeLanguage(e.target.value); }}
                >
                  <option value="en">{t('settings.languageOptions.en')}</option>
                  <option value="zh">{t('settings.languageOptions.zh')}</option>
                </select>
              </div>
            </div>
            <div className="settings-section">
              <h3>{t('settings.connection')}</h3>
              <div className="settings-row">
                <label>{t('settings.webSocketUrl')}</label>
                <input
                  className="settings-input"
                  value={url}
                  onChange={(e) => onUrlChange(e.target.value)}
                  disabled={connState === 'connected'}
                />
              </div>
              <div className="settings-row">
                <label>{t('settings.status')}</label>
                <div className="settings-inline-row">
                  <span
                    className="settings-value--capitalize"
                    style={{
                      fontSize: 13,
                      color: connState === 'connected' ? 'var(--status-active)' : connState === 'connecting' ? 'var(--status-warning)' : 'var(--text-tertiary)',
                    }}
                  >
                    {connState}
                  </span>
                  {connState === 'connected' ? (
                    <button className="btn-small btn-danger" onClick={() => onDisconnect?.()}>{t('settings.disconnect')}</button>
                  ) : connState !== 'connecting' ? (
                    <button className="btn-small btn-primary" onClick={() => onConnect?.(url)}>{t('settings.connect')}</button>
                  ) : null}
                </div>
              </div>
            </div>
            {accountInfo && (
              <div className="settings-section">
                <h3>{t('settings.account')}</h3>
                <div className="settings-row">
                  <label>{t('settings.authType')}</label>
                  <span className="settings-value">{accountInfo.type}</span>
                </div>
                {accountInfo.email && (
                  <div className="settings-row">
                    <label>{t('settings.email')}</label>
                    <span className="settings-value">{accountInfo.email}</span>
                  </div>
                )}
                {accountInfo.planType && (
                  <div className="settings-row">
                    <label>{t('settings.plan')}</label>
                    <span className="settings-value settings-value--capitalize">
                      {accountInfo.planType}
                    </span>
                  </div>
                )}
              </div>
            )}
            {rateLimits && (
              <div className="settings-section">
                <h3>{t('settings.rateLimits')}</h3>
                {rateLimits.limitName && (
                  <div className="settings-row">
                    <label>{t('settings.limit')}</label>
                    <span className="settings-value">{rateLimits.limitName}</span>
                  </div>
                )}
                {rateLimits.planType && (
                  <div className="settings-row">
                    <label>{t('settings.planSnapshot')}</label>
                    <span className="settings-value settings-value--capitalize">
                      {rateLimits.planType}
                    </span>
                  </div>
                )}
                {rateLimits.primary && (
                  <>
                    <div className="settings-row">
                      <label>{t('settings.primaryWindow')}</label>
                      <span className="settings-value">
                        {Math.round(rateLimits.primary.usedPercent)}% used
                        {rateLimits.primary.windowDurationMins ? ` / ${rateLimits.primary.windowDurationMins} min` : ''}
                      </span>
                    </div>
                    <div className="settings-row">
                      <label>{t('settings.primaryReset')}</label>
                      <span className="settings-value">{formatRateLimitResetTime(rateLimits.primary.resetsAt)}</span>
                    </div>
                  </>
                )}
                {rateLimits.secondary && (
                  <>
                    <div className="settings-row">
                      <label>{t('settings.secondaryWindow')}</label>
                      <span className="settings-value">
                        {Math.round(rateLimits.secondary.usedPercent)}% used
                        {rateLimits.secondary.windowDurationMins ? ` / ${rateLimits.secondary.windowDurationMins} min` : ''}
                      </span>
                    </div>
                    <div className="settings-row">
                      <label>{t('settings.secondaryReset')}</label>
                      <span className="settings-value">{formatRateLimitResetTime(rateLimits.secondary.resetsAt)}</span>
                    </div>
                  </>
                )}
                {rateLimits.credits && (
                  <div className="settings-row">
                    <label>{t('settings.credits')}</label>
                    <span className="settings-value">
                      {rateLimits.credits.unlimited
                        ? t('settings.unlimited')
                        : rateLimits.credits.balance
                        ? rateLimits.credits.balance
                        : rateLimits.credits.hasCredits
                        ? t('settings.available')
                        : t('settings.unavailable')}
                    </span>
                  </div>
                )}
              </div>
            )}
            <div className="settings-section">
              <h3>{t('settings.notifications')}</h3>
              <div className="settings-row">
                <label>{t('settings.turnCompletion')}</label>
                <select
                  className="settings-select"
                  value={notificationPref}
                  onChange={(e) => onNotificationPrefChange(e.target.value as NotificationPref)}
                >
                  <option value="always">{t('settings.always')}</option>
                  <option value="unfocused">{t('settings.whenAppUnfocused')}</option>
                  <option value="never">{t('settings.never')}</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {tab === 'connections' && (
          <ConnectionsPanel
            currentUrl={url}
            connState={connState}
            onConnect={(wsUrl) => { onUrlChange(wsUrl); onConnect?.(wsUrl); }}
            onDisconnect={() => onDisconnect?.()}
            serverStarting={serverStarting}
            serverRunning={serverRunning}
            serverLog={serverLog}
            codexBinPath={codexBinPath}
            onCodexBinPathChange={onCodexBinPathChange}
            codexCandidates={codexCandidates}
            onStartServer={onStartServer}
            onStopServer={onStopServer}
            onBrowseCodexBinary={onBrowseCodexBinary}
          />
        )}

        {tab === 'appearance' && (
          <div className="settings-panel">
            <h2>{t('settings.appearance')}</h2>
            <div className="settings-section">
              <h3>{t('settings.theme')}</h3>
              <p className="settings-hint">
                {t('settings.themeDesc')}
              </p>
              <div className="settings-theme-row">
                {(['dark', 'light', 'system'] as ThemeMode[]).map((mode) => (
                  <button
                    key={mode}
                    className={`settings-theme-option${theme === mode ? ' settings-theme-option--active' : ''}`}
                    onClick={() => handleThemeVariantChange(mode)}
                  >
                    <div className={`settings-theme-preview settings-theme-preview--${mode}`} />
                    <span>{t(`settings.${mode}`)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-variant-header">
                <h3>{activeVariant === 'dark' ? t('settings.darkTheme') : t('settings.lightTheme')}</h3>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn-small" onClick={() => { setThemeImportOpen(true); setThemeImportValue(''); }}>{t('common.import')}</button>
                  <button className="btn-small" onClick={() => {
                    const str = exportThemeString(themeConfig, activeVariant);
                    navigator.clipboard.writeText(str).catch(() => {});
                  }}>{t('settings.copyTheme')}</button>
                  <div className="settings-preset-dropdown" ref={presetDropdownRef}>
                    <button
                      className="settings-preset-trigger"
                      onClick={() => setPresetDropdownOpen(!presetDropdownOpen)}
                    >
                      <span className="settings-preset-swatch" style={{ background: currentPreset.previewColor }} />
                      <span>{currentPreset.label}</span>
                      <span className="settings-preset-chevron">{presetDropdownOpen ? 'v' : '>'}</span>
                    </button>
                    {presetDropdownOpen && (
                      <div className="settings-preset-menu">
                        {THEME_PRESETS.map((p) => (
                          <button
                            key={p.id}
                            className={`settings-preset-item${themePreset === p.id ? ' settings-preset-item--active' : ''}`}
                            onClick={() => handlePresetSelect(p.id)}
                          >
                            <span className="settings-preset-swatch" style={{ background: p.previewColor }} />
                            <span>{p.label}</span>
                            {themePreset === p.id && <span style={{ marginLeft: 'auto' }} aria-hidden="true">&#10003;</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {themeImportOpen && (
                <div className="settings-import-row">
                  <input
                    className="settings-input"
                    placeholder={t('settings.pasteThemeString')}
                    value={themeImportValue}
                    onChange={e => setThemeImportValue(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button className="btn-small btn-primary" onClick={() => {
                    const result = importThemeString(themeImportValue);
                    if (result) {
                      onThemeConfigChange(result.theme);
                      setThemeImportOpen(false);
                      setThemeImportValue('');
                    }
                  }}>{t('common.apply')}</button>
                  <button className="btn-small" onClick={() => { setThemeImportOpen(false); setThemeImportValue(''); }}>{t('common.cancel')}</button>
                </div>
              )}
              {colorRow(t('settings.accent'), themeConfig.accent, v => patch({ accent: v }))}
              {colorRow(t('settings.background'), themeConfig.surface, v => patch({ surface: v }))}
              {colorRow(t('settings.foreground'), themeConfig.ink, v => patch({ ink: v }))}
              <div className="settings-row">
                <label>{t('settings.uiFont')}</label>
                <input
                  className="settings-input settings-font-input"
                  value={themeConfig.fonts.ui ?? ''}
                  onChange={e => patchFonts({ ui: e.target.value || null })}
                  placeholder='"DM Sans", system-ui, sans-serif'
                  spellCheck={false}
                />
              </div>
              <div className="settings-row">
                <label>{t('settings.codeFont')}</label>
                <input
                  className="settings-input settings-font-input"
                  value={themeConfig.fonts.code ?? ''}
                  onChange={e => patchFonts({ code: e.target.value || null })}
                  placeholder='ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace'
                  spellCheck={false}
                />
              </div>
              <div className="settings-row">
                <label>{t('settings.translucentSidebar')}</label>
                <button
                  className={`settings-toggle${!themeConfig.opaqueWindows ? ' settings-toggle--on' : ''}`}
                  onClick={() => patch({ opaqueWindows: !themeConfig.opaqueWindows })}
                />
              </div>
              <div className="settings-row">
                <label>{t('settings.contrast')}</label>
                <div className="settings-slider-row">
                  <input
                    type="range"
                    className="settings-slider"
                    min={0} max={100} step={1}
                    value={themeConfig.contrast}
                    onChange={e => patch({ contrast: Number(e.target.value) })}
                  />
                  <span className="settings-slider-value">{themeConfig.contrast}</span>
                </div>
              </div>
              <details style={{ marginTop: 4 }}>
                <summary style={{ fontSize: 11, color: 'var(--text-tertiary)', cursor: 'pointer', userSelect: 'none' }}>{t('settings.semanticColors')}</summary>
                <div style={{ paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {colorRow(t('settings.diffAdded'), themeConfig.semanticColors.diffAdded, v => patchSemantic({ diffAdded: v }))}
                  {colorRow(t('settings.diffRemoved'), themeConfig.semanticColors.diffRemoved, v => patchSemantic({ diffRemoved: v }))}
                  {colorRow('Skill', themeConfig.semanticColors.skill, v => patchSemantic({ skill: v }))}
                </div>
              </details>
            </div>
            <div className="settings-section">
              <h3>{t('settings.general')}</h3>
              <div className="settings-row">
                <div>
                  <label>{t('settings.pointerCursor')}</label>
                  <p className="settings-field-desc">
                    {t('settings.pointerCursorDesc')}
                  </p>
                </div>
                <button
                  className={`settings-toggle${pointerCursor ? ' settings-toggle--on' : ''}`}
                  onClick={() => onPointerCursorChange(!pointerCursor)}
                />
              </div>
              <div className="settings-row">
                <div>
                  <label>{t('settings.uiFontSize')}</label>
                  <p className="settings-field-desc">
                    {t('settings.uiFontSizeDesc')}
                  </p>
                </div>
                <div className="settings-stepper">
                  <button disabled={uiFontSize <= 10} onClick={() => { const v = Math.max(10, uiFontSize - 1); onUiFontSizeChange(v); applyFontSizes(v, codeFontSize); }}>-</button>
                  <span className="settings-stepper-value">{uiFontSize}px</span>
                  <button disabled={uiFontSize >= 22} onClick={() => { const v = Math.min(22, uiFontSize + 1); onUiFontSizeChange(v); applyFontSizes(v, codeFontSize); }}>+</button>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <label>{t('settings.codeFontSize')}</label>
                  <p className="settings-field-desc">
                    {t('settings.codeFontSizeDesc')}
                  </p>
                </div>
                <div className="settings-stepper">
                  <button disabled={codeFontSize <= 10} onClick={() => { const v = Math.max(10, codeFontSize - 1); onCodeFontSizeChange(v); applyFontSizes(uiFontSize, v); }}>-</button>
                  <span className="settings-stepper-value">{codeFontSize}px</span>
                  <button disabled={codeFontSize >= 22} onClick={() => { const v = Math.min(22, codeFontSize + 1); onCodeFontSizeChange(v); applyFontSizes(uiFontSize, v); }}>+</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'config' && (
          <div className="settings-panel">
            <h2>{t('settings.configuration')}</h2>
            <p className="settings-desc">{t('settings.configureApproval')}</p>
            <div className="settings-section">
              <h3>{t('settings.autonomyPreset')}</h3>
              <div className="settings-row">
                <label>{t('settings.preset')}</label>
                {onAutonomyModeChange ? (
                  <select
                    className="settings-select"
                    value={externalAutonomyMode}
                    disabled={isUpdatingAutonomy}
                    onChange={(e) => onAutonomyModeChange(e.target.value)}
                  >
                    <option value="suggest">{t('settings.suggest')}</option>
                    <option value="auto-edit">{t('settings.autoEdit')}</option>
                    <option value="full-auto">{t('settings.fullAuto')}</option>
                    {externalAutonomyMode === 'custom' && <option value="custom">{t('settings.custom')}</option>}
                  </select>
                ) : (
                  <span className="settings-value">
                    {formatAutonomyModeLabel(deriveAutonomyModeFromConfig(codexConfig))}
                  </span>
                )}
              </div>
              {externalAutonomyMode !== 'custom' && (
                <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
                  Preset sets both approval policy and sandbox mode together.
                </p>
              )}
              {(() => {
                const detail = formatAutonomyModeDetail(codexConfig, externalAutonomyMode);
                return detail ? (
                  <p style={{ fontSize: 11, color: 'var(--status-warning)', marginTop: 4 }}>
                    Custom: {detail}
                  </p>
                ) : null;
              })()}
            </div>
            <div className="settings-section">
              <h3>{t('settings.approvalPolicy')}</h3>
              <div className="settings-row">
                <label>{t('settings.policy')}</label>
                {onWriteConfig ? (
                  <select
                    className="settings-select"
                    value={getEffectiveApprovalPolicyValue(codexConfig)}
                    onChange={async (e) => {
                      try {
                        await onWriteConfig('approval_policy', e.target.value);
                      } catch { /* ignore */ }
                    }}
                  >
                    <option value="untrusted">{t('settings.untrusted')}</option>
                    <option value="on-failure">{t('settings.onFailure')}</option>
                    <option value="on-request">{t('settings.onRequest')}</option>
                    <option value="never">{t('settings.never')}</option>
                  </select>
                ) : (
                  <span className="settings-value">
                    {getAutonomyModeSummary(codexConfig).split(' / ')[0]}
                  </span>
                )}
              </div>
              <p className="settings-field-note">
                Controls when Codex asks for user approval before executing commands.
              </p>
            </div>
            <div className="settings-section">
              <h3>{t('settings.sandbox')}</h3>
              <div className="settings-row">
                <label>{t('settings.sandboxMode')}</label>
                {onWriteConfig ? (
                  <select
                    className="settings-select"
                    value={getEffectiveSandboxModeValue(codexConfig)}
                    onChange={async (e) => {
                      try {
                        await onWriteConfig('sandbox_mode', e.target.value);
                      } catch { /* ignore */ }
                    }}
                  >
                    <option value="read-only">{t('settings.readOnly')}</option>
                    <option value="workspace-write">{t('settings.workspaceWrite')}</option>
                    <option value="danger-full-access">{t('settings.fullAccess')}</option>
                  </select>
                ) : (
                  <span className="settings-value settings-value--accent">
                    {getAutonomyModeSummary(codexConfig).split(' / ')[1]}
                  </span>
                )}
              </div>
              <p className="settings-field-note">
                Controls what level of filesystem access Codex has.
              </p>
            </div>
            {codexConfig && Array.isArray((codexConfig as Record<string, unknown>).layers) && (
              <div className="settings-section">
                <h3>Config Layers</h3>
                <p className="settings-section-desc">
                  Configuration is merged from these sources (highest priority first):
                </p>
                {((codexConfig as Record<string, unknown>).layers as Array<Record<string, unknown>>).map((layer, i) => {
                  const name = (layer.name as Record<string, unknown> | undefined);
                  const layerType = typeof name?.type === 'string' ? name.type : 'unknown';
                  const file = typeof name?.file === 'string' ? name.file : null;
                  const dotCodexFolder = typeof name?.dotCodexFolder === 'string' ? name.dotCodexFolder : null;
                  const filePath = file ?? (dotCodexFolder ? `${dotCodexFolder}/config.toml` : null);
                  return (
                    <div key={i} className="settings-row" style={{ alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <label style={{ textTransform: 'capitalize', fontWeight: 500 }}>{layerType}</label>
                        {filePath && (
                          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{filePath}</span>
                        )}
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                        {layer.version != null ? `v${layer.version}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {codexConfig && typeof (codexConfig as Record<string, unknown>).origins === 'object' && (codexConfig as Record<string, unknown>).origins != null && (
              <div className="settings-section">
                <h3>Config Origins</h3>
                <p className="settings-section-desc">
                  Shows which layer each config key originates from.
                </p>
                {Object.entries((codexConfig as Record<string, unknown>).origins as Record<string, unknown>)
                  .filter(([, v]) => v != null)
                  .slice(0, 30)
                  .map(([key, origin]) => {
                    const o = origin as Record<string, unknown> | null;
                    const originName = o?.name as Record<string, unknown> | undefined;
                    const originType = typeof originName?.type === 'string' ? originName.type : '?';
                    return (
                      <div key={key} className="settings-row">
                        <label style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{key}</label>
                        <span className="settings-value--capitalize" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{originType}</span>
                      </div>
                    );
                  })}
              </div>
            )}
            {codexConfig && (
              <div className="settings-section">
                <h3>Effective Config</h3>
                <pre className="settings-text-block" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {JSON.stringify(getConfigRoot(codexConfig) ?? codexConfig, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {tab === 'personalization' && (
          <div className="settings-panel">
            <h2>{t('settings.personalization')}</h2>
            <p className="settings-desc">{t('settings.personalizeDesc')}</p>
            <div className="settings-section">
              <h3>{t('settings.profileName')}</h3>
              {editingProfileName ? (
                <div className="settings-inline-actions">
                  <input
                    value={profileNameValue}
                    onChange={e => setProfileNameValue(e.target.value)}
                    placeholder={t('settings.profileNamePlaceholder')}
                    className="settings-editable-input"
                  />
                  <button className="btn-small btn-primary" disabled={savingProfileName} onClick={async () => {
                    if (!onWriteConfig) return;
                    setSavingProfileName(true);
                    try { await onWriteConfig('profileName', profileNameValue); setEditingProfileName(false); } catch {}
                    setSavingProfileName(false);
                  }}>{savingProfileName ? '...' : t('common.save')}</button>
                  <button className="btn-small" onClick={() => setEditingProfileName(false)}>{t('common.cancel')}</button>
                </div>
              ) : (
                <div className="settings-inline-row">
                  <span className="settings-value">
                    {String(getConfigValue(codexConfig, 'profileName') ?? t('settings.notSet'))}
                  </span>
                  {onWriteConfig && (
                    <button className="btn-small" onClick={() => {
                      const current = getConfigValue(codexConfig, 'profileName');
                      setProfileNameValue(typeof current === 'string' ? current : '');
                      setEditingProfileName(true);
                    }}>{t('common.edit')}</button>
                  )}
                </div>
              )}
            </div>
            <div className="settings-section">
              <h3>{t('settings.responseLang')}</h3>
              <p className="settings-hint">
                {t('settings.responseLangDesc')}
              </p>
              {editingResponseLang ? (
                <div className="settings-inline-actions">
                  <input
                    value={responseLangValue}
                    onChange={e => setResponseLangValue(e.target.value)}
                    placeholder={t('settings.responseLangPlaceholder')}
                    className="settings-editable-input"
                  />
                  <button className="btn-small btn-primary" disabled={savingResponseLang} onClick={async () => {
                    if (!onWriteConfig) return;
                    setSavingResponseLang(true);
                    try { await onWriteConfig('responseLanguage', responseLangValue); setEditingResponseLang(false); } catch {}
                    setSavingResponseLang(false);
                  }}>{savingResponseLang ? '...' : t('common.save')}</button>
                  <button className="btn-small" onClick={() => setEditingResponseLang(false)}>{t('common.cancel')}</button>
                </div>
              ) : (
                <div className="settings-inline-row">
                  <span className="settings-value">
                    {String(getConfigValue(codexConfig, 'responseLanguage') ?? t('settings.notSet'))}
                  </span>
                  {onWriteConfig && (
                    <button className="btn-small" onClick={() => {
                      const current = getConfigValue(codexConfig, 'responseLanguage');
                      setResponseLangValue(typeof current === 'string' ? current : '');
                      setEditingResponseLang(true);
                    }}>{t('common.edit')}</button>
                  )}
                </div>
              )}
            </div>
            <div className="settings-section">
              <h3>{t('settings.customInstructions')}</h3>
              {editingInstructions ? (
                <div className="settings-stack">
                  <textarea
                    value={instructionsValue}
                    onChange={e => setInstructionsValue(e.target.value)}
                    rows={10}
                    className="settings-editable-textarea"
                    placeholder={t('settings.customInstructionsPlaceholder')}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-small btn-primary" disabled={savingInstructions} onClick={async () => {
                      if (!onWriteConfig) return;
                      setSavingInstructions(true);
                      try { await onWriteConfig('instructions', instructionsValue); setEditingInstructions(false); } catch {}
                      setSavingInstructions(false);
                    }}>{savingInstructions ? t('settings.saving') : t('common.save')}</button>
                    <button className="btn-small" onClick={() => setEditingInstructions(false)}>{t('common.cancel')}</button>
                  </div>
                </div>
              ) : (() => {
                const instructions = getConfigValue(codexConfig, 'instructions') ?? getConfigValue(codexConfig, 'customInstructions');
                return (
                  <div className="settings-stack">
                    {instructions ? (
                      <pre className="settings-text-block" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {typeof instructions === 'string' ? instructions : JSON.stringify(instructions, null, 2)}
                      </pre>
                    ) : (
                      <div className="settings-text-block">{t('settings.noCustomInstructions')}</div>
                    )}
                    {onWriteConfig && (
                      <button className="btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => {
                        const current = getConfigValue(codexConfig, 'instructions') ?? getConfigValue(codexConfig, 'customInstructions');
                        setInstructionsValue(typeof current === 'string' ? current : '');
                        setEditingInstructions(true);
                      }}>{t('common.edit')}</button>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {tab === 'mcp' && (
          <McpSettingsPanel mcpServers={mcpServers} client={client} onRefresh={async () => {
            if (onRefreshMcp) await onRefreshMcp();
          }} />
        )}

        {tab === 'git' && (
          <div className="settings-panel">
            <h2>{t('settings.git')}</h2>
            <div className="settings-section">
              <h3>{t('settings.branchPrefix')}</h3>
              <div className="settings-row">
                <label>{t('settings.branchPrefixLabel')}</label>
                {editingBranchPrefix ? (
                  <div className="settings-inline-actions">
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
                    }}>{savingBranchPrefix ? '...' : t('common.save')}</button>
                    <button className="btn-small" onClick={() => setEditingBranchPrefix(false)}>{t('common.cancel')}</button>
                  </div>
                ) : (
                  <div className="settings-inline-row">
                    <span className="settings-value" style={{ fontFamily: 'var(--font-mono)' }}>
                      {String(getConfigValue(codexConfig, 'git.branchPrefix') ?? getConfigValue(codexConfig, 'branchPrefix') ?? 'codex/')}
                    </span>
                    {onWriteConfig && (
                      <button className="btn-small" onClick={() => {
                        const current = getConfigValue(codexConfig, 'git.branchPrefix') ?? getConfigValue(codexConfig, 'branchPrefix') ?? 'codex/';
                        setBranchPrefixValue(String(current));
                        setEditingBranchPrefix(true);
                      }}>{t('common.edit')}</button>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="settings-section">
              <h3>{t('settings.pushSettings')}</h3>
              <div className="settings-row">
                <label>{t('settings.forcePushLease')}</label>
                {onWriteConfig ? (
                  <button className="btn-small" onClick={() => onWriteConfig('git.forcePush', !(getConfigValue(codexConfig, 'git.forcePush') === true))}>
                    {getConfigValue(codexConfig, 'git.forcePush') === true ? t('settings.on') : t('settings.off')}
                  </button>
                ) : (
                  <span className="settings-value">{getConfigValue(codexConfig, 'git.forcePush') === true ? t('settings.on') : t('settings.off')}</span>
                )}
              </div>
              <div className="settings-row">
                <label>{t('settings.draftPullRequests')}</label>
                {onWriteConfig ? (
                  <button className="btn-small" onClick={() => onWriteConfig('git.draftPullRequests', !(getConfigValue(codexConfig, 'git.draftPullRequests') === true))}>
                    {getConfigValue(codexConfig, 'git.draftPullRequests') === true ? t('settings.on') : t('settings.off')}
                  </button>
                ) : (
                  <span className="settings-value">{getConfigValue(codexConfig, 'git.draftPullRequests') === true ? t('settings.on') : t('settings.off')}</span>
                )}
              </div>
            </div>
            <div className="settings-section">
              <h3>{t('settings.commitInstructions')}</h3>
              {editingCommitInstructions ? (
                <div className="settings-stack">
                  <textarea
                    value={commitInstructionsValue}
                    onChange={e => setCommitInstructionsValue(e.target.value)}
                    rows={6}
                    className="settings-editable-textarea"
                    placeholder={t('settings.commitInstructionsPlaceholder')}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-small btn-primary" disabled={savingCommitInstructions} onClick={async () => {
                      if (!onWriteConfig) return;
                      setSavingCommitInstructions(true);
                      try { await onWriteConfig('git.commitInstructions', commitInstructionsValue); setEditingCommitInstructions(false); } catch {}
                      setSavingCommitInstructions(false);
                    }}>{savingCommitInstructions ? t('settings.saving') : t('common.save')}</button>
                    <button className="btn-small" onClick={() => setEditingCommitInstructions(false)}>{t('common.cancel')}</button>
                  </div>
                </div>
              ) : (() => {
                const commitInstructions = getConfigValue(codexConfig, 'git.commitInstructions') ?? getConfigValue(codexConfig, 'commitInstructions');
                return (
                  <div className="settings-stack">
                    {commitInstructions ? (
                      <pre className="settings-text-block" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {String(commitInstructions)}
                      </pre>
                    ) : (
                      <div className="settings-text-block">
                        {t('settings.commitInstructionsHint')}
                      </div>
                    )}
                    {onWriteConfig && (
                      <button className="btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => {
                        const current = getConfigValue(codexConfig, 'git.commitInstructions') ?? getConfigValue(codexConfig, 'commitInstructions');
                        setCommitInstructionsValue(typeof current === 'string' ? current : '');
                        setEditingCommitInstructions(true);
                      }}>{t('common.edit')}</button>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {tab === 'archived' && (
          <div className="settings-panel">
            <h2>{t('settings.archivedThreads')}</h2>
            {loadingArchived ? (
              <div className="settings-text-block">{t('settings.loadingArchived')}</div>
            ) : archivedThreads.length === 0 ? (
              <div className="empty-section-card">
                <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
                  {t('settings.noArchivedThreads')}
                </span>
              </div>
            ) : (
              <div className="archived-list">
                {archivedThreads.map((th) => (
                  <div key={th.id} className="archived-item">
                    <div className="archived-info">
                      <span className="archived-name">{th.name || th.preview || t('sidebar.untitled')}</span>
                      <span className="archived-meta">
                        {new Date((th.updatedAt ?? th.createdAt) * 1000).toLocaleDateString()}
                        {th.cwd && ` · ${folderName(th.cwd)}`}
                      </span>
                    </div>
                    <button className="btn-small" onClick={async () => {
                      try {
                        await client.unarchiveThread(th.id);
                        setArchivedThreads((prev) => prev.filter((x) => x.id !== th.id));
                      } catch { /* ignore */ }
                    }}>
                      {t('settings.unarchive')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
          </div>
        </div>
      </div>
    </DesktopPageShell>
  );
}
