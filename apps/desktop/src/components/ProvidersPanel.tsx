import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  listProviders,
  getCurrentProviderId,
  addProvider as dbAddProvider,
  updateProvider as dbUpdateProvider,
  deleteProvider as dbDeleteProvider,
  switchCurrentProvider,
  type ProviderAppType,
  type ProviderRow,
} from '../lib/db';
import { DesktopEmptyState, DesktopPageShell } from './DesktopPageShell';
import { ProviderCard } from './ProviderCard';
import { ProviderDialog, type ProviderFormData, sanitizeClaudeConfig } from './ProviderDialog';

const STORAGE_KEY = 'providers-active-app';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

import type { ReactNode } from 'react';

type Props = {
  onToast?: (msg: string, type: 'info' | 'error' | 'success') => void;
  windowControls?: ReactNode;
};

export function ProvidersPanel({ onToast, windowControls }: Props) {
  const { t } = useTranslation();
  const [activeApp, setActiveApp] = useState<ProviderAppType>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'codex' ? 'codex' : 'claude';
  });
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProviderRow | null>(null);

  const toast = useCallback((msg: string, type: 'info' | 'error' | 'success' = 'info') => {
    onToast?.(msg, type);
  }, [onToast]);

  const refresh = useCallback(async () => {
    const list = await listProviders(activeApp);
    setProviders(list);
    const cur = await getCurrentProviderId(activeApp);
    setCurrentId(cur);
  }, [activeApp]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSwitchApp = useCallback((app: ProviderAppType) => {
    setActiveApp(app);
    localStorage.setItem(STORAGE_KEY, app);
  }, []);

  // ── Switch provider (backfill old → write new to disk) ──
  const handleSwitch = useCallback(async (provider: ProviderRow) => {
    try {
      // Backfill: save live config to old provider before overwriting
      if (currentId) {
        try {
          const liveResult = await invoke<{ settingsConfig: string }>(
            'import_current_provider_config', { appType: activeApp }
          );
          await dbUpdateProvider({
            id: currentId,
            name: providers.find(p => p.id === currentId)?.name ?? 'unknown',
            settingsConfig: liveResult.settingsConfig,
          });
        } catch {
          // backfill is best-effort
        }
      }

      await switchCurrentProvider(provider.id, activeApp);

      // Sanitize Claude config before writing
      if (activeApp === 'claude') {
        const sanitized = sanitizeClaudeConfig(provider.settings_config);
        await invoke('write_claude_settings', { json: sanitized });
      } else {
        const parsed = JSON.parse(provider.settings_config);
        await invoke('write_codex_full_config', {
          auth: parsed.auth ?? '',
          config: parsed.config ?? '',
        });
      }

      await refresh();
      toast(`Switched to "${provider.name}"`, 'success');
    } catch (err) {
      console.error('Failed to switch provider:', err);
      toast(`Switch failed: ${err}`, 'error');
    }
  }, [activeApp, currentId, providers, refresh, toast]);

  // ── Add provider ──
  const handleAdd = useCallback(async (data: ProviderFormData) => {
    try {
      await dbAddProvider({
        id: generateId(),
        name: data.name,
        appType: activeApp,
        settingsConfig: data.settingsConfig,
        websiteUrl: data.websiteUrl || undefined,
        notes: data.notes || undefined,
        category: data.category || undefined,
      });
      setDialogOpen(false);
      await refresh();
      toast(`Provider "${data.name}" added`, 'success');
    } catch (err) {
      console.error('Failed to add provider:', err);
      toast(`Add failed: ${err}`, 'error');
    }
  }, [activeApp, refresh, toast]);

  // ── Edit (open dialog, with live config sync for current provider) ──
  const handleEdit = useCallback(async (provider: ProviderRow) => {
    if (provider.id === currentId) {
      try {
        const result = await invoke<{ settingsConfig: string }>(
          'import_current_provider_config',
          { appType: activeApp }
        );
        setEditingProvider({ ...provider, settings_config: result.settingsConfig });
        return;
      } catch {
        // fall through to use saved config
      }
    }
    setEditingProvider(provider);
  }, [currentId, activeApp]);

  // ── Update provider ──
  const handleUpdate = useCallback(async (data: ProviderFormData) => {
    if (!editingProvider) return;
    try {
      await dbUpdateProvider({
        id: editingProvider.id,
        name: data.name,
        settingsConfig: data.settingsConfig,
        websiteUrl: data.websiteUrl || undefined,
        notes: data.notes || undefined,
        category: data.category || undefined,
      });

      if (editingProvider.id === currentId) {
        if (activeApp === 'claude') {
          await invoke('write_claude_settings', { json: sanitizeClaudeConfig(data.settingsConfig) });
        } else {
          const parsed = JSON.parse(data.settingsConfig);
          await invoke('write_codex_full_config', {
            auth: parsed.auth ?? '',
            config: parsed.config ?? '',
          });
        }
      }

      setEditingProvider(null);
      await refresh();
      toast(`Provider "${data.name}" updated`, 'success');
    } catch (err) {
      console.error('Failed to update provider:', err);
      toast(`Update failed: ${err}`, 'error');
    }
  }, [editingProvider, currentId, activeApp, refresh, toast]);

  // ── Duplicate provider ──
  const handleDuplicate = useCallback(async (provider: ProviderRow) => {
    try {
      await dbAddProvider({
        id: generateId(),
        name: `${provider.name} (copy)`,
        appType: activeApp,
        settingsConfig: provider.settings_config,
        websiteUrl: provider.website_url || undefined,
        notes: provider.notes || undefined,
        category: provider.category || undefined,
        icon: provider.icon || undefined,
        iconColor: provider.icon_color || undefined,
      });
      await refresh();
      toast(`Duplicated "${provider.name}"`, 'success');
    } catch (err) {
      console.error('Failed to duplicate provider:', err);
      toast(`Duplicate failed: ${err}`, 'error');
    }
  }, [activeApp, refresh, toast]);

  // ── Delete provider (blocks active provider) ──
  const handleDeleteConfirm = useCallback(async () => {
    if (!confirmDelete) return;
    if (confirmDelete.id === currentId) {
      toast('Cannot delete the active provider. Switch to another provider first.', 'error');
      setConfirmDelete(null);
      return;
    }
    try {
      const name = confirmDelete.name;
      await dbDeleteProvider(confirmDelete.id);
      setConfirmDelete(null);
      await refresh();
      toast(`Provider "${name}" deleted`, 'info');
    } catch (err) {
      console.error('Failed to delete provider:', err);
      toast(`Delete failed: ${err}`, 'error');
    }
  }, [confirmDelete, currentId, refresh, toast]);

  // ── Import current live config from disk ──
  const handleImportCurrent = useCallback(async () => {
    try {
      const result = await invoke<{ settingsConfig: string }>('import_current_provider_config', { appType: activeApp });
      const name = activeApp === 'claude' ? 'Claude (imported)' : 'Codex (imported)';
      await dbAddProvider({
        id: generateId(),
        name,
        appType: activeApp,
        settingsConfig: result.settingsConfig,
      });
      await refresh();
      toast(`Imported current ${activeApp === 'claude' ? 'Claude' : 'Codex'} config`, 'success');
    } catch (err) {
      console.error('Failed to import current config:', err);
      toast(`Import failed: ${err}`, 'error');
    }
  }, [activeApp, refresh, toast]);

  return (
    <DesktopPageShell
      className="providers-panel"
      title={t('providers.title')}
      windowControls={windowControls}
      toolbar={(
        <div className="providers-tabs-row">
          <div className="providers-tabs">
            <button
              className={`providers-tab${activeApp === 'claude' ? ' providers-tab--active' : ''}`}
              onClick={() => handleSwitchApp('claude')}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6" />
                <path d="M5.5 8.5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5" />
              </svg>
              {t('providers.claude')}
            </button>
            <button
              className={`providers-tab${activeApp === 'codex' ? ' providers-tab--active' : ''}`}
              onClick={() => handleSwitchApp('codex')}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="10" height="10" rx="2" />
                <path d="M6 6l4 4M10 6l-4 4" />
              </svg>
              {t('providers.codex')}
            </button>
          </div>
          <div className="providers-toolbar">
            <button className="providers-toolbar-btn providers-toolbar-btn--primary" onClick={() => setDialogOpen(true)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" />
              </svg>
              {t('common.add')}
            </button>
            <button className="providers-toolbar-btn" onClick={handleImportCurrent}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v7M5 7l3 3 3-3" /><path d="M3 12h10" />
              </svg>
              {t('common.import')}
            </button>
          </div>
        </div>
      )}
    >
      <div className="desktop-page-surface desktop-page-surface--scroll">
        <div className="providers-list">
          {providers.length === 0 ? (
            <DesktopEmptyState
              icon={(
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="6" width="28" height="28" rx="6" />
                  <line x1="20" y1="14" x2="20" y2="26" /><line x1="14" y1="20" x2="26" y2="20" />
                </svg>
              )}
              title={t('providers.noProviders', {
                app: t(activeApp === 'claude' ? 'providers.claude' : 'providers.codex'),
              })}
              description={t('providers.clickAddToCreate')}
            />
          ) : (
            providers.map(p => (
              <ProviderCard
                key={p.id}
                provider={p}
                isCurrent={p.id === currentId}
                appType={activeApp}
                onSwitch={handleSwitch}
                onEdit={handleEdit}
                onDelete={setConfirmDelete}
                onDuplicate={handleDuplicate}
              />
            ))
          )}
        </div>
      </div>

      <ProviderDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        appType={activeApp}
        onSave={handleAdd}
        onValidationError={msg => toast(msg, 'error')}
      />

      <ProviderDialog
        open={!!editingProvider}
        onClose={() => setEditingProvider(null)}
        appType={activeApp}
        provider={editingProvider}
        onSave={handleUpdate}
        onValidationError={msg => toast(msg, 'error')}
      />

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t('providers.deleteProvider')}</h3>
              <button className="modal-close" onClick={() => setConfirmDelete(null)}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="2" y1="2" x2="10" y2="10" /><line x1="10" y1="2" x2="2" y2="10" />
                </svg>
              </button>
            </div>
            <div className="provider-confirm-text">
              {t('providers.deleteProviderConfirm', { name: confirmDelete.name })}
            </div>
            <div className="pd-footer">
              <button className="pd-btn pd-btn--ghost" onClick={() => setConfirmDelete(null)}>{t('common.cancel')}</button>
              <button
                className="pd-btn pd-btn--primary"
                style={{ background: 'var(--status-error)' }}
                onClick={handleDeleteConfirm}
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </DesktopPageShell>
  );
}
