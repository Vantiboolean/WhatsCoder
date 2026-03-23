import { useState } from 'react';
import type { CodexClient } from '@whats-coder/shared';

export function McpSettingsPanel({ mcpServers, client, onRefresh }: {
  mcpServers: Array<{ name: string; status: string }>;
  client: CodexClient;
  onRefresh: () => Promise<void>;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState('');
  const [addType, setAddType] = useState<'stdio' | 'sse'>('stdio');
  const [addCommand, setAddCommand] = useState('');
  const [addArgs, setAddArgs] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addEnvText, setAddEnvText] = useState('');
  const [saving, setSaving] = useState(false);
  const [togglingServer, setTogglingServer] = useState<string | null>(null);
  const [removingServer, setRemovingServer] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setAddName('');
    setAddCommand('');
    setAddArgs('');
    setAddUrl('');
    setAddEnvText('');
    setAddType('stdio');
    setShowAddForm(false);
    setError(null);
  };

  const handleAdd = async () => {
    const key = addName.trim().replace(/\s+/g, '-').toLowerCase();
    if (!key) { setError('Server name is required'); return; }

    const config: Record<string, unknown> = {};
    if (addType === 'stdio') {
      if (!addCommand.trim()) { setError('Command is required for stdio servers'); return; }
      config.command = addCommand.trim();
      if (addArgs.trim()) {
        config.args = addArgs.split(/\s+/).filter(Boolean);
      }
    } else {
      if (!addUrl.trim()) { setError('URL is required for SSE servers'); return; }
      config.url = addUrl.trim();
    }

    if (addEnvText.trim()) {
      const env: Record<string, string> = {};
      for (const line of addEnvText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes('=')) continue;
        const eqIdx = trimmed.indexOf('=');
        const k = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (k) env[k] = val;
      }
      if (Object.keys(env).length > 0) config.env = env;
    }

    setSaving(true);
    setError(null);
    try {
      await client.addMcpServer(key, config as { command?: string; args?: string[]; url?: string; env?: Record<string, string> });
      resetForm();
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add server');
    }
    setSaving(false);
  };

  const handleToggle = async (serverName: string, currentStatus: string) => {
    setTogglingServer(serverName);
    try {
      const shouldEnable = currentStatus === 'disabled' || currentStatus === 'stopped';
      await client.enableMcpServer(serverName, shouldEnable);
      await onRefresh();
    } catch { /* ignore */ }
    setTogglingServer(null);
  };

  const handleRemove = async (serverName: string) => {
    setRemovingServer(serverName);
    try {
      await client.removeMcpServer(serverName);
      setConfirmRemove(null);
      await onRefresh();
    } catch { /* ignore */ }
    setRemovingServer(null);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12,
    background: 'var(--bg-secondary)', color: 'var(--text-primary)',
    border: '1px solid var(--border-default)', borderRadius: 6,
    padding: '6px 10px', boxSizing: 'border-box',
  };

  return (
    <div className="settings-panel">
      <h2>MCP Servers</h2>
      <p className="settings-desc">Connect external tools and data sources via the Model Context Protocol.</p>

      {mcpServers.length > 0 ? (
        <div className="settings-section">
          <h3>Servers ({mcpServers.length})</h3>
          {mcpServers.map((s) => (
            <div key={s.name} className="settings-row" style={{ alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                <span className={`sidebar-conn-dot sidebar-conn-dot--${s.status === 'running' ? 'connected' : 'disconnected'}`} />
                <label style={{ fontFamily: 'var(--font-mono)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: s.status === 'running' ? 'var(--status-active)' : 'var(--text-tertiary)', textTransform: 'capitalize', minWidth: 52, textAlign: 'right' }}>
                  {s.status}
                </span>
                <button
                  className="btn-small"
                  disabled={togglingServer === s.name}
                  onClick={() => handleToggle(s.name, s.status)}
                  style={{ minWidth: 60, fontSize: 11 }}
                >
                  {togglingServer === s.name ? '...' : s.status === 'running' ? 'Disable' : 'Enable'}
                </button>
                {confirmRemove === s.name ? (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn-small" style={{ fontSize: 11, color: 'var(--status-error)' }} disabled={removingServer === s.name} onClick={() => handleRemove(s.name)}>
                      {removingServer === s.name ? '...' : 'Confirm'}
                    </button>
                    <button className="btn-small" style={{ fontSize: 11 }} onClick={() => setConfirmRemove(null)}>Cancel</button>
                  </div>
                ) : (
                  <button className="btn-small" style={{ fontSize: 11 }} onClick={() => setConfirmRemove(s.name)}>Remove</button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-section-card">
          <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
            No MCP servers configured. Add one below or configure servers in your Codex config.
          </span>
        </div>
      )}

      <div className="settings-section">
        {showAddForm ? (
          <>
            <h3>Add MCP Server</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Server Name *</label>
                  <input style={inputStyle} value={addName} onChange={e => setAddName(e.target.value)} placeholder="e.g. my-server" />
                </div>
                <div style={{ width: 120 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Type</label>
                  <select value={addType} onChange={e => setAddType(e.target.value as 'stdio' | 'sse')} style={{ ...inputStyle, cursor: 'pointer' }}>
                    <option value="stdio">stdio</option>
                    <option value="sse">SSE (HTTP)</option>
                  </select>
                </div>
              </div>

              {addType === 'stdio' ? (
                <>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Command *</label>
                    <input style={inputStyle} value={addCommand} onChange={e => setAddCommand(e.target.value)} placeholder="e.g. npx, uvx, node" />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Arguments (space-separated)</label>
                    <input style={inputStyle} value={addArgs} onChange={e => setAddArgs(e.target.value)} placeholder="e.g. -y @modelcontextprotocol/server-filesystem ." />
                  </div>
                </>
              ) : (
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>URL *</label>
                  <input style={inputStyle} value={addUrl} onChange={e => setAddUrl(e.target.value)} placeholder="e.g. http://localhost:3001/sse" />
                </div>
              )}

              <div>
                <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Environment Variables (one per line: KEY=VALUE)</label>
                <textarea
                  style={{ ...inputStyle, resize: 'vertical', minHeight: 48 }}
                  rows={2}
                  value={addEnvText}
                  onChange={e => setAddEnvText(e.target.value)}
                  placeholder="API_KEY=sk-..."
                />
              </div>

              {error && <div style={{ color: 'var(--status-error)', fontSize: 12 }}>{error}</div>}

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-small btn-primary" disabled={saving} onClick={handleAdd}>
                  {saving ? 'Adding...' : 'Add Server'}
                </button>
                <button className="btn-small" onClick={resetForm}>Cancel</button>
              </div>
            </div>
          </>
        ) : (
          <button className="btn-small btn-primary" onClick={() => setShowAddForm(true)} style={{ marginTop: 4 }}>
            + Add MCP Server
          </button>
        )}
      </div>

      <div className="settings-section">
        <h3>Recommended</h3>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 8px' }}>
          Popular MCP servers you can add with one click.
        </p>
        {[
          { name: 'filesystem', desc: 'File system access', cmd: 'npx', args: '-y @modelcontextprotocol/server-filesystem .' },
          { name: 'playwright', desc: 'Browser automation', cmd: 'npx', args: '-y @playwright/mcp@latest' },
          { name: 'memory', desc: 'Persistent memory store', cmd: 'npx', args: '-y @modelcontextprotocol/server-memory' },
        ].map((rec) => {
          const isInstalled = mcpServers.some(s => s.name === rec.name);
          return (
            <div key={rec.name} className="settings-row">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <label style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{rec.name}</label>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{rec.desc}</span>
              </div>
              <button
                className="btn-small"
                disabled={isInstalled}
                onClick={async () => {
                  try {
                    await client.addMcpServer(rec.name, {
                      command: rec.cmd,
                      args: rec.args.split(' ').filter(Boolean),
                    });
                    await onRefresh();
                  } catch { /* ignore */ }
                }}
              >
                {isInstalled ? 'Installed' : 'Add'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
