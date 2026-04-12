import { useState, useEffect, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-shell';
import {
  codexGetAuthUrl,
  codexCheckAuth,
  codexHandleOAuthCallback,
  codexLogout,
  type CodexAuthStatus,
} from '../../lib/api/rustBridge';

export function ConnectionsPanel() {
  const [authStatus, setAuthStatus] = useState<CodexAuthStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const refresh = useCallback(async () => {
    try {
      const status = await codexCheckAuth();
      setAuthStatus(status);
    } catch {
      setAuthStatus({ authenticated: false, email: null, plan: null, accountId: null });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const waitForCallbackListenerReady = useCallback(async () => {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let dispose: (() => void) | null = null;
      const timeoutId = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        dispose?.();
        reject(new Error('OAuth callback listener did not start in time.'));
      }, 3000);

      listen('codex-auth-listener-ready', () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        dispose?.();
        resolve();
      })
        .then((unlisten) => {
          dispose = unlisten;
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeoutId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }, []);

  const handleLogin = useCallback(async () => {
    setLoading(true);
    setStatusMsg('Preparing local callback listener…');
    try {
      const url = await codexGetAuthUrl();
      const readyPromise = waitForCallbackListenerReady();
      const statusPromise = codexHandleOAuthCallback();
      void readyPromise.catch(() => {});
      void statusPromise.catch(() => {});
      await Promise.race([
        readyPromise,
        statusPromise.then(() => undefined),
      ]);
      setStatusMsg('Opening browser for login…');
      await open(url);
      setStatusMsg('Waiting for OAuth callback…');
      const status = await statusPromise;
      setAuthStatus(status);
      setStatusMsg(status.authenticated ? 'Login successful!' : 'Login failed — please try again.');
    } catch (e) {
      setStatusMsg(String(e));
    } finally {
      setLoading(false);
    }
  }, [waitForCallbackListenerReady]);

  const handleLogout = async () => {
    setLoading(true);
    try {
      await codexLogout();
      setAuthStatus({ authenticated: false, email: null, plan: null, accountId: null });
      setStatusMsg('Logged out.');
    } catch (e) {
      setStatusMsg(String(e));
    } finally {
      setLoading(false);
    }
  };

  const planLabel = (plan: string | null) => {
    if (!plan) return null;
    const map: Record<string, string> = {
      plus: 'ChatGPT Plus',
      pro: 'ChatGPT Pro',
      free: 'Free',
    };
    return map[plan.toLowerCase()] ?? plan;
  };

  return (
    <div className="settings-panel">
      <h2>Codex Login</h2>
      <p className="settings-desc">
        Sign in with your OpenAI account (ChatGPT Plus / Pro) to use Codex directly — no local server required.
      </p>

      <div className="settings-section">
        <h3>Account Status</h3>
        {authStatus === null ? (
          <span className="settings-desc">Checking…</span>
        ) : authStatus.authenticated ? (
          <div className="conn-field-stack">
            <div className="conn-status-row">
              <span className="sidebar-conn-dot sidebar-conn-dot--connected" />
              <span className="conn-status-title">Connected</span>
            </div>
            {authStatus.email && (
              <div className="settings-row">
                <span className="conn-field-label">Email</span>
                <span>{authStatus.email}</span>
              </div>
            )}
            {authStatus.plan && (
              <div className="settings-row">
                <span className="conn-field-label">Plan</span>
                <span>{planLabel(authStatus.plan)}</span>
              </div>
            )}
            <div className="conn-actions-row">
              <button className="btn-small" onClick={handleLogout} disabled={loading}>
                {loading ? 'Logging out…' : 'Logout'}
              </button>
            </div>
          </div>
        ) : (
          <div className="conn-field-stack">
            <div className="conn-status-row">
              <span className="sidebar-conn-dot sidebar-conn-dot--disconnected" />
              <span className="conn-status-title">Not logged in</span>
            </div>
            <p className="settings-desc">
              Requires a ChatGPT Plus or Pro subscription. Login opens your browser — return here after authorizing.
            </p>
            <div className="conn-actions-row">
              <button className="btn-small btn-primary" onClick={handleLogin} disabled={loading}>
                {loading ? 'Waiting for browser…' : 'Login with OpenAI'}
              </button>
            </div>
          </div>
        )}

        {statusMsg && (
          <p className="settings-desc" style={{ marginTop: 8, opacity: 0.7 }}>{statusMsg}</p>
        )}
      </div>
    </div>
  );
}
