import { useState } from 'react';
import { IconGithub, IconCheck } from '../../lib/icons.js';
import { githubConnectionAtom } from '../../states/githubConnection.atom.js';
import { getGithubConnectUrl, disconnectGithub } from '../../lib/api.js';
import { useToast } from '../../states/toast.atom.js';

const fmtDate = (iso: string): string => {
  try {
    return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
};

export const GithubPanel = () => {
  const [state, actions] = githubConnectionAtom.use();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await getGithubConnectUrl();
      window.location.href = url;
    } catch {
      toast('无法发起 GitHub 连接，请稍后重试', 'error');
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm('断开 GitHub 连接？灵犀将无法再代你操作仓库。')) return;
    setBusy(true);
    try {
      await disconnectGithub();
      await actions.refresh();
      toast('已断开 GitHub 连接');
    } catch {
      toast('断开失败，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  };

  const connected = state.status === 'ready' && state.conn.connected;

  return (
    <div className="card" style={{ padding: 18, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ display: 'inline-flex', width: 44, height: 44, borderRadius: 12, background: 'var(--accent-weak2)', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <IconGithub size={24} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 650, fontSize: 15 }}>GitHub</div>
          {state.status === 'loading' ? (
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>加载中…</div>
          ) : connected && state.conn.connected ? (
            <div className="dim" style={{ fontSize: 12.5, marginTop: 2 }}>
              <IconCheck size={12} color="var(--ok)" /> 已连接 · <span style={{ fontFamily: 'monospace' }}>@{state.conn.login}</span> · {fmtDate(state.conn.connected_at)}
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>未连接 · 让助理代你 clone / push / 提 PR</div>
          )}
        </div>
        {state.status === 'ready' && (connected
          ? (
            <button className="btn btn-soft" disabled={busy} onClick={disconnect} style={{ padding: '6px 12px', fontSize: 13 }}>
              断开
            </button>
          ) : (
            <button className="btn btn-primary" disabled={busy} onClick={connect} style={{ padding: '6px 14px', fontSize: 13 }}>
              <IconGithub size={14} /> 连接 GitHub
            </button>
          ))}
      </div>

      {connected && state.conn.connected ? (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {state.conn.scopes.map((s) => (
              <span key={s} style={{ fontSize: 11.5, fontFamily: 'monospace', padding: '2px 8px', borderRadius: 6, background: 'var(--accent-weak2)', color: 'var(--accent)' }}>{s}</span>
            ))}
          </div>
          <a href="https://github.com/settings/applications" target="_blank" rel="noreferrer" className="dim" style={{ fontSize: 12 }}>
            在 GitHub 上管理已授权应用 →
          </a>
        </div>
      ) : state.status === 'ready' && (
        <div className="muted" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)', fontSize: 12, lineHeight: 1.6 }}>
          连接 GitHub 将允许灵犀代你访问<b>所有</b>仓库（含 private）。如需限制具体仓库，请等待我们的细粒度授权（GitHub App）集成。
        </div>
      )}
    </div>
  );
};
