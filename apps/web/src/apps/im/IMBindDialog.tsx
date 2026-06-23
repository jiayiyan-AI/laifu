import type { ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { IconRefresh } from '../../lib/icons.js';
import type { IMProvider } from './providers.js';
import { useWechatBind, WECHAT_SUB_HINT } from './useWechatBind.js';
import { useToast } from '../../states/toast.atom.js';

interface Props {
  provider: IMProvider;
  assistantName: string;
  onClose: () => void;
  onBound: () => void;   // Hub: 刷新计数
}

export const IMBindDialog = ({ provider, assistantName, onClose, onBound }: Props) => {
  const toast = useToast();
  const { state, start, unbind } = useWechatBind({
    onBound: () => { toast(`${provider.name}绑定成功`); onBound(); },
    onError: (m) => toast(m, 'error'),
  });

  if (provider.id !== 'wechat') {
    return <Backdrop onClose={onClose}><div style={{ padding: 28, background: '#fff', borderRadius: 14 }}>{provider.name}绑定即将上线</div></Backdrop>;
  }

  const handleUnbind = async () => { await unbind(); toast(`${provider.name}已解绑`); onBound(); onClose(); };

  return (
    <Backdrop onClose={onClose}>
      <div style={{ width: 480, background: '#fff', borderRadius: 14, overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ background: provider.brandWeak, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'inline-flex' }}>{provider.icon}</span>
          <span style={{ fontWeight: 650 }}>{provider.bindTitlePrefix} {assistantName}</span>
        </div>
        <div style={{ padding: 22 }}>
          {state.kind === 'loading' && <div className="dim">加载中…</div>}
          {state.kind === 'unbound' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-start' }}>
              <Steps steps={provider.steps} />
              <button className="btn btn-primary" style={{ background: provider.brand }} onClick={start}>获取二维码</button>
            </div>
          )}
          {state.kind === 'starting' && <div className="dim">正在请求二维码…</div>}
          {state.kind === 'awaiting_scan' && (
            <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ width: 200, height: 200, background: '#fff', border: '1px solid var(--border)', borderRadius: 14, padding: 10, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {state.qr_content ? <QRCodeSVG value={state.qr_content} size={180} level="M" /> : <div className="dim">无 QR</div>}
                {(state.sub === 'expired' || state.sub === 'redirect') && (
                  <div style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--bad)', fontWeight: 600, borderRadius: 14 }}>
                    {state.sub === 'expired' ? '二维码已过期' : '需重试'}
                  </div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <Steps steps={provider.steps} />
                <div className="muted" style={{ fontSize: 13, margin: '10px 0' }}>{WECHAT_SUB_HINT[state.sub]}</div>
                <button className="btn btn-ghost" onClick={start}><IconRefresh size={15} />刷新二维码</button>
              </div>
            </div>
          )}
          {state.kind === 'bound' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontWeight: 650 }}>✓ 已绑定{provider.name} · bot …{state.ilink_bot_id.slice(-4)}</div>
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.8 }}>助理正在替你监听{provider.name}。联系人不会知道是 AI 回复。</div>
              <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', color: 'var(--bad)' }} onClick={handleUnbind}>解绑</button>
            </div>
          )}
        </div>
      </div>
    </Backdrop>
  );
};

const Steps = ({ steps }: { steps: readonly string[] }) => (
  <div className="muted" style={{ fontSize: 13, lineHeight: 1.9 }}>
    {steps.map((s, i) => <div key={i}>{i + 1} · {s}</div>)}
  </div>
);

const Backdrop = ({ children, onClose }: { children: ReactNode; onClose: () => void }) => (
  <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    {children}
  </div>
);
