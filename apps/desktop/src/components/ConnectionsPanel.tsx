import { useState, useCallback, useEffect } from 'react';
import type { ConnectionState } from '@whats-coder/shared';
import { listConnections, saveConnection, deleteConnection, setDefaultConnection, type SavedConnectionRow } from '../lib/db';

export function ConnectionsPanel({ currentUrl, connState, onConnect, onDisconnect, serverStarting, serverRunning, serverLog, codexBinPath, onCodexBinPathChange, codexCandidates, onStartServer, onStopServer, onBrowseCodexBinary }: {
  currentUrl: string;
  connState: ConnectionState;
  onConnect: (url: string) => void;
  onDisconnect: () => void;
  serverStarting?: boolean;
  serverRunning?: boolean;
  serverLog?: string;
  codexBinPath?: string;
  onCodexBinPathChange?: (path: string) => void;
  codexCandidates?: string[];
  onStartServer?: () => void;
  onStopServer?: () => void;
  onBrowseCodexBinary?: () => void;
}) {
  const [connections, setConnections] = useState<SavedConnectionRow[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('4500');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setConnections(await listConnections()); } catch { /* ignore */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const connectedUrl = connState === 'connected' ? currentUrl : null;

  const resetForm = () => {
    setLabel(''); setHost('127.0.0.1'); setPort('4500');
    setShowAdd(false); setEditingId(null);
  };

  const handleSave = async (makeDefault = false) => {
    const trimLabel = label.trim() || `${host}:${port}`;
    const id = editingId ?? `conn-${Date.now()}`;
    const portNum = parseInt(port, 10) || 4500;
    await saveConnection({ id, label: trimLabel, host: host.trim() || '127.0.0.1', port: portNum, isDefault: makeDefault });
    resetForm();
    await refresh();
  };

  const handleDelete = async (id: string) => {
    await deleteConnection(id);
    setConfirmDelete(null);
    await refresh();
  };

  const handleSetDefault = async (id: string) => {
    await setDefaultConnection(id);
    await refresh();
  };

  const buildUrl = (c: SavedConnectionRow) => `ws://${c.host}:${c.port}`;

  const startEdit = (c: SavedConnectionRow) => {
    setEditingId(c.id);
    setLabel(c.label);
    setHost(c.host);
    setPort(String(c.port));
    setShowAdd(true);
  };

  return (
    <div className="settings-panel">
      <h2>Connections</h2>
      <p className="settings-desc">Manage connections to Codex app-server instances. You can run multiple servers on different ports or remote hosts.</p>

      <div className="settings-section">
        <h3>Server</h3>
        <div className="conn-status-row">
          <span className={`sidebar-conn-dot sidebar-conn-dot--${connState === 'connected' ? 'connected' : serverRunning ? 'connecting' : 'disconnected'}`} />
          <span className="conn-status-title">
            {connState === 'connected' ? 'Connected' : serverStarting ? 'Starting...' : serverRunning ? 'Running (not connected)' : 'Stopped'}
          </span>
        </div>
        {serverLog && (
          <code className="conn-log-display">{serverLog}</code>
        )}
        <div className="conn-field-stack">
          <div>
            <label className="conn-field-label">Binary Path</label>
            <div className="conn-input-row">
              <input
                className="conn-input conn-input--flex"
                placeholder="codex (from PATH)"
                value={codexBinPath ?? ''}
                onChange={e => onCodexBinPathChange?.(e.target.value)}
                spellCheck={false}
              />
              {onBrowseCodexBinary && (
                <button className="btn-small" onClick={onBrowseCodexBinary} title="Browse for codex binary">Browse</button>
              )}
            </div>
          </div>
          <div>
            <label className="conn-field-label">Endpoint</label>
            <code className="conn-url-display">{currentUrl}</code>
          </div>
        </div>
        {codexCandidates && codexCandidates.length > 0 && !serverRunning && !serverStarting && (
          <div className="conn-candidates-block">
            <label className="conn-field-label">Detected Binaries</label>
            <div className="conn-candidate-list">
              {codexCandidates.map(p => (
                <button key={p} className="btn-small conn-candidate-btn" onClick={() => onCodexBinPathChange?.(p)} title={p}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="conn-actions-row">
          {!serverRunning && !serverStarting && onStartServer && (
            <button className="btn-small btn-primary" onClick={onStartServer}>Start Server</button>
          )}
          {serverRunning && onStopServer && (
            <button className="btn-small" onClick={onStopServer}>Stop Server</button>
          )}
          {serverRunning && connState !== 'connected' && (
            <button className="btn-small btn-primary" onClick={() => onConnect(currentUrl)}>Reconnect</button>
          )}
        </div>
      </div>

      {connections.length > 0 ? (
        <div className="settings-section">
          <h3>Saved Connections</h3>
          {connections.map((c) => {
            const wsUrl = buildUrl(c);
            const isConnected = connectedUrl === wsUrl;
            return (
              <div key={c.id} className="settings-row conn-saved-row">
                <div className="conn-saved-main">
                  <span className={`sidebar-conn-dot sidebar-conn-dot--${isConnected ? 'connected' : 'disconnected'}`} />
                  <div className="conn-saved-text-wrap">
                    <div className="conn-saved-label">
                      {c.label}
                      {c.is_default ? <span className="conn-default-badge">DEFAULT</span> : null}
                    </div>
                    <div className="conn-saved-url">{wsUrl}</div>
                  </div>
                </div>
                <div className="conn-saved-actions">
                  {isConnected ? (
                    <button className="btn-small" onClick={onDisconnect}>Disconnect</button>
                  ) : (
                    <button className="btn-small btn-primary" onClick={() => onConnect(wsUrl)}>Connect</button>
                  )}
                  <button className="btn-small" onClick={() => startEdit(c)}>Edit</button>
                  {!c.is_default && (
                    <button className="btn-small" onClick={() => handleSetDefault(c.id)}>Set Default</button>
                  )}
                  {confirmDelete === c.id ? (
                    <div className="conn-confirm-row">
                      <button className="btn-small conn-btn-danger-text" onClick={() => handleDelete(c.id)}>Confirm</button>
                      <button className="btn-small" onClick={() => setConfirmDelete(null)}>Cancel</button>
                    </div>
                  ) : (
                    <button className="btn-small" onClick={() => setConfirmDelete(c.id)}>&times;</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-section-card">
          <span className="conn-empty-hint">
            No saved connections. Add one below to get started.
          </span>
        </div>
      )}

      <div className="settings-section">
        {showAdd ? (
          <>
            <h3>{editingId ? 'Edit Connection' : 'Add Connection'}</h3>
            <div className="conn-form-stack">
              <div>
                <label className="conn-field-label">Label</label>
                <input className="conn-input" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Local Server" />
              </div>
              <div className="conn-host-port-row">
                <div className="conn-host-field">
                  <label className="conn-field-label">Host</label>
                  <input className="conn-input" value={host} onChange={e => setHost(e.target.value)} placeholder="127.0.0.1" />
                </div>
                <div className="conn-port-field">
                  <label className="conn-field-label">Port</label>
                  <input className="conn-input" value={port} onChange={e => setPort(e.target.value)} placeholder="4500" type="number" />
                </div>
              </div>
              <div className="conn-form-actions">
                <button className="btn-small btn-primary" onClick={() => handleSave(false)}>
                  {editingId ? 'Update' : 'Save'}
                </button>
                {!editingId && <button className="btn-small" onClick={() => handleSave(true)}>Save as Default</button>}
                <button className="btn-small" onClick={resetForm}>Cancel</button>
              </div>
            </div>
          </>
        ) : (
          <button className="btn-small btn-primary conn-add-connection-btn" onClick={() => { resetForm(); setShowAdd(true); }}>
            + Add Connection
          </button>
        )}
      </div>

      <div className="settings-section">
        <h3>Quick Connect</h3>
        <p className="conn-quick-desc">
          Connect directly without saving. The current URL from the General tab is used.
        </p>
        <div className="settings-row">
          <label className="conn-url-display">{currentUrl}</label>
          {connState === 'connected' ? (
            <button className="btn-small" onClick={onDisconnect}>Disconnect</button>
          ) : (
            <button className="btn-small btn-primary" onClick={() => onConnect(currentUrl)}>Connect</button>
          )}
        </div>
      </div>
    </div>
  );
}
