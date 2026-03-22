import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderRow, ProviderAppType } from '../lib/db';

type Props = {
  provider: ProviderRow;
  isCurrent: boolean;
  appType: ProviderAppType;
  onSwitch: (provider: ProviderRow) => void;
  onEdit: (provider: ProviderRow) => void;
  onDelete: (provider: ProviderRow) => void;
  onDuplicate: (provider: ProviderRow) => void;
};

function extractDisplayUrl(provider: ProviderRow): string {
  if (provider.website_url) return provider.website_url;

  try {
    const config = JSON.parse(provider.settings_config);
    if (provider.app_type === 'claude') {
      const base = config?.env?.ANTHROPIC_BASE_URL;
      if (typeof base === 'string' && base.trim()) return base;
    }
    if (provider.app_type === 'codex') {
      const configStr = config?.config;
      if (typeof configStr === 'string') {
        const match = configStr.match(/base_url\s*=\s*"([^"]+)"/);
        if (match) return match[1];
      }
    }
  } catch { /* ignore */ }

  return '';
}

function extractApiKeyHint(provider: ProviderRow): string {
  try {
    const config = JSON.parse(provider.settings_config);
    if (provider.app_type === 'claude') {
      const key = config?.env?.ANTHROPIC_AUTH_TOKEN ?? config?.env?.ANTHROPIC_API_KEY ?? '';
      if (key.length > 8) return `${key.slice(0, 6)}...${key.slice(-4)}`;
      return key ? '***' : '';
    }
    if (provider.app_type === 'codex') {
      const authStr = config?.auth ?? '';
      const match = authStr.match(/api_key\s*=\s*"([^"]*)"/);
      if (match) {
        const key = match[1];
        if (key.length > 8) return `${key.slice(0, 6)}...${key.slice(-4)}`;
        return key ? '***' : '';
      }
    }
  } catch { /* ignore */ }
  return '';
}

const CATEGORY_KEYS: Record<string, string> = {
  official: 'providers.categories.official',
  cn_official: 'providers.categories.cnOfficial',
  cloud_provider: 'providers.categories.cloud',
  aggregator: 'providers.categories.aggregator',
  third_party: 'providers.categories.thirdParty',
  custom: 'providers.categories.custom',
};

function appIcon(appType: ProviderAppType): string {
  return appType === 'claude' ? 'C' : 'X';
}

export const ProviderCard = memo(function ProviderCard({
  provider,
  isCurrent,
  appType,
  onSwitch,
  onEdit,
  onDelete,
  onDuplicate,
}: Props) {
  const { t } = useTranslation();
  const displayUrl = extractDisplayUrl(provider);
  const keyHint = extractApiKeyHint(provider);
  const categoryLabel = provider.category
    ? (CATEGORY_KEYS[provider.category] ? t(CATEGORY_KEYS[provider.category]) : provider.category)
    : null;

  return (
    <div className={`provider-card${isCurrent ? ' provider-card--active' : ''}`}>
      <div className="provider-card-icon" style={provider.icon_color ? { color: provider.icon_color } : undefined}>
        {provider.icon || appIcon(appType)}
      </div>

      <div className="provider-card-info">
        <div className="provider-card-name">
          {provider.name}
          {categoryLabel && <span className="provider-card-category">{categoryLabel}</span>}
        </div>
        <div className="provider-card-meta">
          {keyHint && <span className="provider-card-key" title={t('providers.apiKey')}>🔑 {keyHint}</span>}
          {displayUrl && <span className="provider-card-url" title={displayUrl}>{displayUrl}</span>}
          {provider.notes?.trim() && <span className="provider-card-notes" title={provider.notes}>{provider.notes}</span>}
        </div>
      </div>

      {isCurrent && <span className="provider-card-badge">{t('providers.activeLabel')}</span>}

      <div className="provider-card-actions">
        <button
          className="provider-action-btn--switch provider-action-btn"
          onClick={() => onSwitch(provider)}
          disabled={isCurrent}
          title={isCurrent ? t('providers.alreadyActive') : t('providers.switchToProvider')}
        >
          {isCurrent ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="2,8 6,12 14,4" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="6,3 14,8 6,13" /></svg>
          )}
        </button>
        <button className="provider-action-btn" onClick={() => onEdit(provider)} title={t('common.edit')}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3z" /></svg>
        </button>
        <button className="provider-action-btn" onClick={() => onDuplicate(provider)} title={t('providers.duplicate')}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3 11V3a1.5 1.5 0 011.5-1.5H11"/></svg>
        </button>
        <button className="provider-action-btn provider-action-btn--danger" onClick={() => onDelete(provider)} title={t('common.delete')}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h10M5.5 5V3.5a1 1 0 011-1h3a1 1 0 011 1V5M6.5 7.5v4M9.5 7.5v4" /><path d="M4 5l.7 8.4a1 1 0 001 .9h4.6a1 1 0 001-.9L12 5" /></svg>
        </button>
      </div>
    </div>
  );
});
