import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderAppType, ProviderRow } from '../lib/db';
import { getPresetsGrouped, type ProviderPreset } from '../config/providerPresets';

export type ProviderFormData = {
  name: string;
  settingsConfig: string;
  websiteUrl: string;
  notes: string;
  category: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  appType: ProviderAppType;
  provider?: ProviderRow | null;
  onSave: (data: ProviderFormData) => void;
  onValidationError?: (msg: string) => void;
};

type FormMode = 'simple' | 'advanced';

// ── Claude config helpers (preserve unrelated keys) ──

interface ClaudeFields {
  apiKey: string;
  baseUrl: string;
  authField: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  model: string;
  reasoningModel: string;
  haikuModel: string;
  sonnetModel: string;
  opusModel: string;
}

const EMPTY_CLAUDE: ClaudeFields = {
  apiKey: '', baseUrl: '', authField: 'ANTHROPIC_AUTH_TOKEN',
  model: '', reasoningModel: '', haikuModel: '', sonnetModel: '', opusModel: '',
};

function parseClaudeFields(raw: string): ClaudeFields {
  try {
    const obj = JSON.parse(raw);
    const env = obj?.env ?? {};
    const hasToken = typeof env.ANTHROPIC_AUTH_TOKEN === 'string';
    const hasKey = typeof env.ANTHROPIC_API_KEY === 'string';
    return {
      apiKey: (hasToken ? env.ANTHROPIC_AUTH_TOKEN : hasKey ? env.ANTHROPIC_API_KEY : '') ?? '',
      baseUrl: env.ANTHROPIC_BASE_URL ?? '',
      authField: hasKey && !hasToken ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN',
      model: env.ANTHROPIC_MODEL ?? '',
      reasoningModel: env.ANTHROPIC_REASONING_MODEL ?? '',
      haikuModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '',
      sonnetModel: env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '',
      opusModel: env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '',
    };
  } catch {
    return { ...EMPTY_CLAUDE };
  }
}

function mergeClaudeFields(raw: string, f: ClaudeFields): string {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(raw); } catch { obj = {}; }
  if (!obj.env || typeof obj.env !== 'object') obj.env = {};
  const env = obj.env as Record<string, unknown>;

  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  if (f.apiKey.trim()) env[f.authField] = f.apiKey.trim();

  const setOrDel = (key: string, val: string) => {
    if (val.trim()) env[key] = val.trim(); else delete env[key];
  };
  setOrDel('ANTHROPIC_BASE_URL', f.baseUrl);
  setOrDel('ANTHROPIC_MODEL', f.model);
  setOrDel('ANTHROPIC_REASONING_MODEL', f.reasoningModel);
  setOrDel('ANTHROPIC_DEFAULT_HAIKU_MODEL', f.haikuModel);
  setOrDel('ANTHROPIC_DEFAULT_SONNET_MODEL', f.sonnetModel);
  setOrDel('ANTHROPIC_DEFAULT_OPUS_MODEL', f.opusModel);

  return JSON.stringify(obj, null, 2);
}

// ── Codex config helpers (preserve unrelated TOML keys) ──

interface CodexFields {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const EMPTY_CODEX: CodexFields = { apiKey: '', baseUrl: '', model: '' };

function parseCodexFields(raw: string): CodexFields & { authRaw: string; configRaw: string } {
  try {
    const obj = JSON.parse(raw);
    const authStr: string = typeof obj?.auth === 'string' ? obj.auth : '';
    const configStr: string = typeof obj?.config === 'string' ? obj.config : '';
    const apiKeyMatch = authStr.match(/api_key\s*=\s*"([^"]*)"/);
    const baseUrlMatch = configStr.match(/base_url\s*=\s*"([^"]*)"/);
    const modelMatch = configStr.match(/model\s*=\s*"([^"]*)"/);
    return {
      apiKey: apiKeyMatch?.[1] ?? '',
      baseUrl: baseUrlMatch?.[1] ?? '',
      model: modelMatch?.[1] ?? '',
      authRaw: authStr,
      configRaw: configStr,
    };
  } catch {
    return { ...EMPTY_CODEX, authRaw: '', configRaw: '' };
  }
}

function setTomlField(toml: string, key: string, value: string): string {
  const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, 'm');
  const trimmed = value.trim();
  if (pattern.test(toml)) {
    if (!trimmed) return toml.replace(pattern, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    return toml.replace(pattern, `$1"${trimmed}"`);
  }
  if (!trimmed) return toml;
  const line = `${key} = "${trimmed}"`;
  return toml.trim() ? toml.trimEnd() + '\n' + line + '\n' : line + '\n';
}

function mergeCodexFields(raw: string, f: CodexFields): string {
  let authStr: string, configStr: string;
  try {
    const obj = JSON.parse(raw);
    authStr = typeof obj?.auth === 'string' ? obj.auth : '';
    configStr = typeof obj?.config === 'string' ? obj.config : '';
  } catch {
    authStr = '';
    configStr = '';
  }

  if (f.apiKey.trim()) {
    authStr = setTomlField(authStr || '', 'api_key', f.apiKey);
  } else {
    authStr = setTomlField(authStr || '', 'api_key', '');
  }
  configStr = setTomlField(configStr, 'base_url', f.baseUrl);
  configStr = setTomlField(configStr, 'model', f.model);

  return JSON.stringify({ auth: authStr, config: configStr });
}

// ── Eye icon SVGs ──

const EyeIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="8" cy="8" rx="7" ry="5"/><circle cx="8" cy="8" r="2"/></svg>
);
const EyeOffIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 2l12 12"/><path d="M6.5 6.5a2 2 0 002.8 2.8"/><path d="M3.6 3.6C2.4 4.6 1.5 6.1 1 8c1.1 3.8 4 6 7 6 1.3 0 2.6-.4 3.7-1.1"/><path d="M10 4.2C13 5.2 15 7 15 8c-.3 1-.8 2-1.6 2.8"/></svg>
);

// ── Component ──

// ── Config validation ──

function validateConfig(
  raw: string,
  appType: ProviderAppType,
  t: (key: string) => string,
): string | null {
  if (!raw.trim()) return t('providerDialog.configEmpty');
  if (appType === 'claude') {
    try {
      const obj = JSON.parse(raw);
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return 'Claude config must be a JSON object';
    } catch { return t('providerDialog.invalidJson'); }
  } else {
    try {
      const obj = JSON.parse(raw);
      if (typeof obj !== 'object' || obj === null) return 'Codex config must be a JSON object with auth and config fields';
      if (typeof obj.auth !== 'string' && typeof obj.auth !== 'undefined') {
        if (typeof obj.auth !== 'string') return 'auth field must be a TOML string';
      }
    } catch { return 'Invalid JSON wrapper for Codex config'; }
  }
  return null;
}

// ── Claude config sanitization ──

const CLAUDE_STRIP_KEYS = ['api_format', 'apiFormat', 'openrouter_compat_mode', 'openrouterCompatMode'];

export function sanitizeClaudeConfig(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    for (const key of CLAUDE_STRIP_KEYS) delete obj[key];
    return JSON.stringify(obj, null, 2);
  } catch { return raw; }
}

export function ProviderDialog({ open, onClose, appType, provider, onSave, onValidationError }: Props) {
  const { t } = useTranslation();
  const isEdit = !!provider;

  const categories = useMemo(
    () => [
      { value: 'official', label: t('providers.categories.official') },
      { value: 'third_party', label: t('providers.categories.thirdParty') },
      { value: 'aggregator', label: t('providers.categories.aggregator') },
      { value: 'custom', label: t('providers.categories.custom') },
    ],
    [t],
  );

  const [mode, setMode] = useState<FormMode>('simple');
  const [name, setName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [category, setCategory] = useState('custom');
  const [showApiKey, setShowApiKey] = useState(false);
  const [showExtra, setShowExtra] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [validationErr, setValidationErr] = useState<string | null>(null);

  // Claude fields
  const [claude, setClaude] = useState<ClaudeFields>({ ...EMPTY_CLAUDE });
  // Codex fields
  const [codex, setCodex] = useState<CodexFields>({ ...EMPTY_CODEX });

  // Raw editors
  const [rawConfig, setRawConfig] = useState('');
  // Codex split editors
  const [codexAuthRaw, setCodexAuthRaw] = useState('');
  const [codexConfigRaw, setCodexConfigRaw] = useState('');

  // Stored raw for merge (to preserve other keys)
  const [baseRaw, setBaseRaw] = useState('');

  useEffect(() => {
    if (!open) return;
    setShowApiKey(false);
    setShowModels(false);
    const raw = provider?.settings_config ?? '';
    setBaseRaw(raw);

    if (provider) {
      setName(provider.name);
      setWebsiteUrl(provider.website_url ?? '');
      setNotes(provider.notes ?? '');
      setCategory(provider.category ?? 'custom');
      setShowExtra(!!(provider.website_url || provider.notes));

      if (appType === 'claude') {
        const fields = parseClaudeFields(raw);
        setClaude(fields);
        setRawConfig(raw || '{\n  "env": {}\n}');
        if (fields.model || fields.reasoningModel || fields.haikuModel || fields.sonnetModel || fields.opusModel) {
          setShowModels(true);
        }
      } else {
        const parsed = parseCodexFields(raw);
        setCodex({ apiKey: parsed.apiKey, baseUrl: parsed.baseUrl, model: parsed.model });
        setCodexAuthRaw(parsed.authRaw);
        setCodexConfigRaw(parsed.configRaw);
        setRawConfig(raw || '{\n  "auth": "",\n  "config": ""\n}');
      }
      setMode('simple');
    } else {
      setName('');
      setWebsiteUrl('');
      setNotes('');
      setCategory('custom');
      setShowExtra(false);
      setClaude({ ...EMPTY_CLAUDE });
      setCodex({ ...EMPTY_CODEX });
      setRawConfig('');
      setCodexAuthRaw('');
      setCodexConfigRaw('');
      setBaseRaw('');
      setMode('simple');
    }
  }, [open, provider, appType]);

  // ── Sync between modes ──

  const buildSimpleConfig = useCallback((): string => {
    if (appType === 'claude') return mergeClaudeFields(baseRaw, claude);
    return mergeCodexFields(baseRaw, codex);
  }, [appType, baseRaw, claude, codex]);

  const handleSwitchMode = useCallback((newMode: FormMode) => {
    if (newMode === 'advanced' && mode === 'simple') {
      const built = buildSimpleConfig();
      if (appType === 'claude') {
        setRawConfig(built);
      } else {
        try {
          const obj = JSON.parse(built);
          setCodexAuthRaw(obj.auth ?? '');
          setCodexConfigRaw(obj.config ?? '');
        } catch { /* keep existing */ }
      }
    } else if (newMode === 'simple' && mode === 'advanced') {
      if (appType === 'claude') {
        const fields = parseClaudeFields(rawConfig);
        setClaude(fields);
        setBaseRaw(rawConfig);
      } else {
        const combined = JSON.stringify({ auth: codexAuthRaw, config: codexConfigRaw });
        const parsed = parseCodexFields(combined);
        setCodex({ apiKey: parsed.apiKey, baseUrl: parsed.baseUrl, model: parsed.model });
        setBaseRaw(combined);
      }
    }
    setMode(newMode);
  }, [mode, appType, rawConfig, codexAuthRaw, codexConfigRaw, buildSimpleConfig]);

  // ── Apply preset ──

  const handleApplyPreset = useCallback((preset: ProviderPreset) => {
    setName(preset.name);
    setWebsiteUrl(preset.websiteUrl);
    setCategory(preset.category);
    setBaseRaw(preset.settingsConfig);
    setRawConfig(preset.settingsConfig);

    if (appType === 'claude') {
      const fields = parseClaudeFields(preset.settingsConfig);
      setClaude(fields);
      if (fields.model || fields.reasoningModel || fields.haikuModel || fields.sonnetModel || fields.opusModel) {
        setShowModels(true);
      }
    } else {
      const parsed = parseCodexFields(preset.settingsConfig);
      setCodex({ apiKey: parsed.apiKey, baseUrl: parsed.baseUrl, model: parsed.model });
      setCodexAuthRaw(parsed.authRaw);
      setCodexConfigRaw(parsed.configRaw);
    }
    setValidationErr(null);
    setMode('simple');
  }, [appType]);

  // ── Submit ──

  const handleSubmit = useCallback(() => {
    let config: string;
    if (mode === 'simple') {
      config = buildSimpleConfig();
    } else if (appType === 'codex') {
      config = JSON.stringify({ auth: codexAuthRaw, config: codexConfigRaw });
    } else {
      config = rawConfig;
    }
    if (!name.trim() || !config.trim()) return;

    const err = validateConfig(config, appType, t);
    if (err) {
      setValidationErr(err);
      onValidationError?.(err);
      return;
    }
    setValidationErr(null);
    onSave({ name, settingsConfig: config, websiteUrl, notes, category });
  }, [mode, appType, name, rawConfig, codexAuthRaw, codexConfigRaw, websiteUrl, notes, category, buildSimpleConfig, onSave, onValidationError, t]);

  const canSave = name.trim().length > 0 && (
    mode === 'simple'
      ? (appType === 'claude' ? claude.apiKey.trim().length > 0 : codex.apiKey.trim().length > 0)
      : (appType === 'codex' ? (codexAuthRaw.trim().length > 0 || codexConfigRaw.trim().length > 0) : rawConfig.trim().length > 0)
  );

  if (!open) return null;

  const appLabel = appType === 'claude' ? t('providers.claude') : t('providers.codex');

  const updateClaude = (patch: Partial<ClaudeFields>) => setClaude(prev => ({ ...prev, ...patch }));
  const updateCodex = (patch: Partial<CodexFields>) => setCodex(prev => ({ ...prev, ...patch }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="pd" onClick={e => e.stopPropagation()}>

        {/* ── Accent stripe ── */}
        <div className="pd-stripe" data-app={appType} />

        {/* ── Header ── */}
        <div className="pd-header">
          <div className="pd-header-left">
            <div className="pd-icon" data-app={appType}>
              {appType === 'claude'
                ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h2v-2h-2v2zm0-4h2V7h-2v6z" fill="currentColor"/></svg>
                : <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              }
            </div>
            <div>
              <div className="pd-heading">{isEdit ? t('providerDialog.editProvider') : t('providerDialog.newProvider')}</div>
              <div className="pd-subheading">
                {appType === 'claude' ? t('providerDialog.claudeConfig') : t('providerDialog.codexConfig')}
              </div>
            </div>
          </div>
          <button className="pd-close" onClick={onClose} title={t('common.close')}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
          </button>
        </div>

        {/* ── Body ── */}
        <div className="pd-body">

          {/* Mode tabs */}
          <div className="pd-tabs" data-app={appType}>
            <div className="pd-tabs-track">
              <div className={`pd-tabs-indicator${mode === 'advanced' ? ' pd-tabs-indicator--right' : ''}`} />
              <button className={`pd-tab${mode === 'simple' ? ' pd-tab--active' : ''}`} onClick={() => handleSwitchMode('simple')} type="button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12h6"/></svg>
                {t('providerDialog.simple')}
              </button>
              <button className={`pd-tab${mode === 'advanced' ? ' pd-tab--active' : ''}`} onClick={() => handleSwitchMode('advanced')} type="button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
                {t('providerDialog.advanced')}
              </button>
            </div>
          </div>

          {/* ═══ SIMPLE MODE ═══ */}
          {mode === 'simple' ? (
            <>
              {/* Preset (Add only) */}
              {!isEdit && (() => {
                const groups = getPresetsGrouped(appType);
                let globalIdx = 0;
                return (
                  <div className="pd-card">
                    <div className="pd-card-label">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                      {t('providerDialog.quickStart')}
                    </div>
                    <select className="pd-select" value="" onChange={e => {
                      const idx = parseInt(e.target.value, 10);
                      if (isNaN(idx)) return;
                      let i = 0;
                      for (const g of groups) { for (const p of g.presets) { if (i === idx) { handleApplyPreset(p); return; } i++; } }
                    }}>
                      <option value="">{t('providerDialog.choosePreset')}</option>
                      {groups.map(g => {
                        const opts = g.presets.map(p => { const idx = globalIdx++; return <option key={p.name} value={idx}>{p.name}</option>; });
                        return <optgroup key={g.label} label={g.label}>{opts}</optgroup>;
                      })}
                    </select>
                  </div>
                );
              })()}

              {/* Name field */}
              <div className="pd-field">
                <label className="pd-label">{t('common.name')}</label>
                <input className="pd-input" value={name} onChange={e => setName(e.target.value)} placeholder={`My ${appLabel} Provider`} autoFocus />
              </div>

              {/* Connection card */}
              <div className="pd-card">
                <div className="pd-card-label">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                  {t('providerDialog.connectionLabel')}
                </div>

                <div className="pd-field">
                  <label className="pd-label">
                    {t('providers.apiKey')}
                    {appType === 'claude' && <span className="pd-tag">{claude.authField}</span>}
                  </label>
                  <div className="pd-secret-wrap">
                    <input
                      className="pd-input pd-input--mono"
                      type={showApiKey ? 'text' : 'password'}
                      value={appType === 'claude' ? claude.apiKey : codex.apiKey}
                      onChange={e => appType === 'claude' ? updateClaude({ apiKey: e.target.value }) : updateCodex({ apiKey: e.target.value })}
                      placeholder={appType === 'claude' ? 'sk-ant-...' : 'sk-...'}
                    />
                    <button className="pd-secret-toggle" onClick={() => setShowApiKey(!showApiKey)} type="button" title={showApiKey ? 'Hide' : 'Show'}>
                      {showApiKey ? EyeOffIcon : EyeIcon}
                    </button>
                  </div>
                </div>

                <div className="pd-row">
                  <div className="pd-field pd-field--grow">
                    <label className="pd-label">{t('providerDialog.baseUrl')}</label>
                    <input
                      className="pd-input"
                      value={appType === 'claude' ? claude.baseUrl : codex.baseUrl}
                      onChange={e => appType === 'claude' ? updateClaude({ baseUrl: e.target.value }) : updateCodex({ baseUrl: e.target.value })}
                      placeholder={appType === 'claude' ? 'https://api.anthropic.com' : 'https://api.openai.com'}
                    />
                  </div>
                  {appType === 'codex' && (
                    <div className="pd-field pd-field--grow">
                      <label className="pd-label">{t('providerDialog.modelOptional')}</label>
                      <input className="pd-input" value={codex.model} onChange={e => updateCodex({ model: e.target.value })} placeholder="codex-mini-latest" />
                    </div>
                  )}
                  {appType === 'claude' && (
                    <div className="pd-field" style={{ width: '180px', flexShrink: 0 }}>
                      <label className="pd-label">{t('providerDialog.authField')}</label>
                      <select className="pd-select" value={claude.authField} onChange={e => updateClaude({ authField: e.target.value as ClaudeFields['authField'] })}>
                        <option value="ANTHROPIC_AUTH_TOKEN">AUTH_TOKEN</option>
                        <option value="ANTHROPIC_API_KEY">API_KEY</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>

              {/* Claude: Model Settings */}
              {appType === 'claude' && (
                <div className="pd-card pd-card--collapsible">
                  <button className="pd-card-toggle" onClick={() => setShowModels(!showModels)} type="button">
                    <div className="pd-card-label">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                      {t('providerDialog.modelSettings')}
                    </div>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`pd-caret${showModels ? ' pd-caret--open' : ''}`}><path d="M4 2l4 4-4 4"/></svg>
                  </button>
                  {showModels && (
                    <div className="pd-card-body">
                      <div className="pd-grid-2">
                        <div className="pd-field">
                          <label className="pd-label pd-label--sm">{t('providerDialog.mainModel')}</label>
                          <input className="pd-input pd-input--sm" value={claude.model} onChange={e => updateClaude({ model: e.target.value })} placeholder="claude-sonnet-4-20250514" />
                        </div>
                        <div className="pd-field">
                          <label className="pd-label pd-label--sm">{t('providerDialog.reasoningModel')}</label>
                          <input className="pd-input pd-input--sm" value={claude.reasoningModel} onChange={e => updateClaude({ reasoningModel: e.target.value })} placeholder="" />
                        </div>
                      </div>
                      <div className="pd-grid-3">
                        <div className="pd-field">
                          <label className="pd-label pd-label--sm">Haiku</label>
                          <input className="pd-input pd-input--sm" value={claude.haikuModel} onChange={e => updateClaude({ haikuModel: e.target.value })} placeholder="" />
                        </div>
                        <div className="pd-field">
                          <label className="pd-label pd-label--sm">Sonnet</label>
                          <input className="pd-input pd-input--sm" value={claude.sonnetModel} onChange={e => updateClaude({ sonnetModel: e.target.value })} placeholder="" />
                        </div>
                        <div className="pd-field">
                          <label className="pd-label pd-label--sm">Opus</label>
                          <input className="pd-input pd-input--sm" value={claude.opusModel} onChange={e => updateClaude({ opusModel: e.target.value })} placeholder="" />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Metadata card (collapsible) */}
              <div className="pd-card pd-card--collapsible">
                <button className="pd-card-toggle" onClick={() => setShowExtra(!showExtra)} type="button">
                  <div className="pd-card-label">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                    {t('providerDialog.metadata')}
                  </div>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`pd-caret${showExtra ? ' pd-caret--open' : ''}`}><path d="M4 2l4 4-4 4"/></svg>
                </button>
                {showExtra && (
                  <div className="pd-card-body">
                    <div className="pd-row">
                      <div className="pd-field pd-field--grow">
                        <label className="pd-label pd-label--sm">Category</label>
                        <select className="pd-select pd-select--sm" value={category} onChange={e => setCategory(e.target.value)}>
                          {categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </select>
                      </div>
                      <div className="pd-field pd-field--grow">
                        <label className="pd-label pd-label--sm">{t('providerDialog.websiteUrl')}</label>
                        <input className="pd-input pd-input--sm" value={websiteUrl} onChange={e => setWebsiteUrl(e.target.value)} placeholder="https://..." />
                      </div>
                    </div>
                    <div className="pd-field">
                      <label className="pd-label pd-label--sm">{t('providerDialog.notes')}</label>
                      <textarea className="pd-code pd-code--notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('providerDialog.notesPlaceholder')} />
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            /* ═══ ADVANCED MODE ═══ */
            appType === 'claude' ? (
              <div className="pd-editor">
                <div className="pd-editor-tab pd-editor-tab--json">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H7a2 2 0 00-2 2v5a2 2 0 01-2 2 2 2 0 012 2v5a2 2 0 002 2h1"/><path d="M16 3h1a2 2 0 012 2v5a2 2 0 002 2 2 2 0 00-2 2v5a2 2 0 01-2 2h-1"/></svg>
                  settings.json
                </div>
                <textarea className="pd-editor-area" value={rawConfig} onChange={e => setRawConfig(e.target.value)} placeholder={'{\n  "env": {\n    "ANTHROPIC_AUTH_TOKEN": "sk-ant-...",\n    "ANTHROPIC_BASE_URL": "https://..."\n  }\n}'} spellCheck={false} />
              </div>
            ) : (
              <>
                <div className="pd-editor">
                  <div className="pd-editor-tab pd-editor-tab--toml-auth">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                    auth.toml
                  </div>
                  <textarea className="pd-editor-area pd-editor-area--sm" value={codexAuthRaw} onChange={e => setCodexAuthRaw(e.target.value)} placeholder={'api_key = "sk-..."'} spellCheck={false} />
                </div>
                <div className="pd-editor">
                  <div className="pd-editor-tab pd-editor-tab--toml-config">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                    config.toml
                  </div>
                  <textarea className="pd-editor-area pd-editor-area--config" value={codexConfigRaw} onChange={e => setCodexConfigRaw(e.target.value)} placeholder={'model = "codex-mini-latest"\nbase_url = "https://api.openai.com"'} spellCheck={false} />
                </div>
              </>
            )
          )}
        </div>

        {/* ── Validation error ── */}
        {validationErr && (
          <div className="pd-error">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            {validationErr}
          </div>
        )}

        {/* ── Footer ── */}
        <div className="pd-footer">
          <button className="pd-btn pd-btn--ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button className="pd-btn pd-btn--primary" data-app={appType} disabled={!canSave} onClick={handleSubmit}>
            {isEdit ? t('providerDialog.saveChanges') : t('providerDialog.addProvider')}
          </button>
        </div>
      </div>
    </div>
  );
}
