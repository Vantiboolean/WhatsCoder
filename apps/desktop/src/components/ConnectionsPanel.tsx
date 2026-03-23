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

  const inputStyle: React.CSSProperties = {
    width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12,
    background: 'var(--bg-secondary)', color: 'var(--text-primary)',
    border: '1px solid var(--border-default)', borderRadius: 6,
    padding: '6px 10px', boxSizing: 'border-box',
  };

  return (
    <div className="settings-panel">
      <h2>Connections</h2>
      <p className="settings-desc">Manage connections to Codex app-server instances. You can run multiple servers on different ports or remote hosts.</p>

      <div className="settings-section">
        <h3>Server</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span className={`sidebar-conn-dot sidebar-conn-dot--${connState === 'connected' ? 'connected' : serverRunning ? 'connecting' : 'disconnected'}`} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {connState === 'connected' ? 'Connected' : serverStarting ? 'Starting...' : serverRunning ? 'Running (not connected)' : 'Stopped'}
          </span>
        </div>
        {serverLog && (
          <code style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', borderRadius: 6, padding: '6px 10px', marginBottom: 10, wordBreak: 'break-all' }}>{serverLog}</code>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Binary Path</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 6, padding: '6px 10px', boxSizing: 'border-box' as const }}
                placeholder="codex (from PATH)"
                value={codexBinPath ?? ''}
                onChange={e => onCodexBinPathChange?.(e.target.value)}
                spellCheck={false}
              />
              {onBrowseCodexBinary && (
                <button className="btn-small" onClick={onBrowseCodexBinary} title="Browse for codex binary" style={{ fontSize: 11, flexShrink: 0 }}>Browse</button>
              )}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Endpoint</label>
            <code style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>{currentUrl}</code>
          </div>
        </div>
        {codexCandidates && codexCandidates.length > 0 && !serverRunning && !serverStarting && (
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Detected Binaries</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {codexCandidates.map(p => (
                <button key={p} className="btn-small" style={{ fontSize: 11, textAlign: 'left', justifyContent: 'flex-start' }} onClick={() => onCodexBinPathChange?.(p)} title={p}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {!serverRunning && !serverStarting && onStartServer && (
            <button className="btn-small btn-primary" onClick={onStartServer} style={{ fontSize: 11 }}>Start Server</button>
          )}
          {serverRunning && onStopServer && (
            <button className="btn-small" onClick={onStopServer} style={{ fontSize: 11 }}>Stop Server</button>
          )}
          {serverRunning && connState !== 'connected' && (
            <button className="btn-small btn-primary" onClick={() => onConnect(currentUrl)} style={{ fontSize: 11 }}>Reconnect</button>
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
              <div key={c.id} className="settings-row" style={{ alignItems: 'center', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                  <span className={`sidebar-conn-dot sidebar-conn-dot--${isConnected ? 'connected' : 'disconnected'}`} />
                  <div style={{ minWidth: 0, overflow: 'hidden' }}>
                    <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.label}
                      {c.is_default ? <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 6 }}>DEFAULT</span> : null}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>{wsUrl}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  {isConnected ? (
                    <button className="btn-small" onClick={onDisconnect} style={{ fontSize: 11 }}>Disconnect</button>
                  ) : (
                    <button className="btn-small btn-primary" onClick={() => onConnect(wsUrl)} style={{ fontSize: 11 }}>Connect</button>
                  )}
                  <button className="btn-small" onClick={() => startEdit(c)} style={{ fontSize: 11 }}>Edit</button>
                  {!c.is_default && (
                    <button className="btn-small" onClick={() => handleSetDefault(c.id)} style={{ fontSize: 11 }}>Set Default</button>
                  )}
                  {confirmDelete === c.id ? (
                    <div style={{ display: 'flex', gap: 3 }}>
                      <button className="btn-small" style={{ fontSize: 11, color: 'var(--status-error)' }} onClick={() => handleDelete(c.id)}>Confirm</button>
                      <button className="btn-small" style={{ fontSize: 11 }} onClick={() => setConfirmDelete(null)}>Cancel</button>
                    </div>
                  ) : (
                    <button className="btn-small" onClick={() => setConfirmDelete(c.id)} style={{ fontSize: 11 }}>&times;</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-section-card">
          <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
            No saved connections. Add one below to get started.
          </span>
        </div>
      )}

      <div className="settings-section">
        {showAdd ? (
          <>
            <h3>{editingId ? 'Edit Connection' : 'Add Connection'}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Label</label>
                <input style={inputStyle} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Local Server" />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Host</label>
                  <input style={inputStyle} value={host} onChange={e => setHost(e.target.value)} placeholder="127.0.0.1" />
                </div>
                <div style={{ width: 100 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Port</label>
                  <input style={inputStyle} value={port} onChange={e => setPort(e.target.value)} placeholder="4500" type="number" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-small btn-primary" onClick={() => handleSave(false)}>
                  {editingId ? 'Update' : 'Save'}
                </button>
                {!editingId && <button className="btn-small" onClick={() => handleSave(true)}>Save as Default</button>}
                <button className="btn-small" onClick={resetForm}>Cancel</button>
              </div>
            </div>
          </>
        ) : (
          <button className="btn-small btn-primary" onClick={() => { resetForm(); setShowAdd(true); }} style={{ marginTop: 4 }}>
            + Add Connection
          </button>
        )}
      </div>

      <div className="settings-section">
        <h3>Quick Connect</h3>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 8px' }}>
          Connect directly without saving. The current URL from the General tab is used.
        </p>
        <div className="settings-row">
          <label style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{currentUrl}</label>
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
