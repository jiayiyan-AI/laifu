import type { ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { IconRefresh } from '../../lib/icons.js';
import type { IMProvider } from './providers.js';
import { useWechatBind, WECHAT_SUB_HINT } from './useWechatBind.js';
import { useFeishuBind } from './useFeishuBind.js';
import { useToast } from '../../states/toast.atom.js';

interface Props {
  provider: IMProvider;
  assistantName: string;
  onClose: () => void;
  onBound: () => void;   // Hub: 刷新计数
}

export const IMBindDialog = ({ provider, assistantName, onClose, onBound }: Props) => {
  const toast = useToast();

  if (provider.id === 'wechat') {
    return (
      <WechatBindDialog
        provider={provider}
        assistantName={assistantName}
        onClose={onClose}
        onBound={onBound}
        toast={toast}
      />
    );
  }

  if (provider.id === 'feishu') {
    return (
      <FeishuBindDialog
        provider={provider}
        assistantName={assistantName}
        onClose={onClose}
        onBound={onBound}
        toast={toast}
      />
    );
  }

  return (
    <Backdrop onClose={onClose}>
      <div style={{ padding: 28, background: '#fff', borderRadius: 14 }}>
        {provider.name}绑定即将上线
      </div>
    </Backdrop>
  );
};

// ── 微信绑定弹窗 ──────────────────────────────────────────────────────────────

interface InternalProps extends Props { toast: (msg: string, level?: string) => void; }

const WechatBindDialog = ({ provider, assistantName, onClose, onBound, toast }: InternalProps) => {
  const { state, start, unbind } = useWechatBind({
    onBound: () => { toast(`${provider.name}绑定成功`); onBound(); },
    onError: (m) => toast(m, 'error'),
  });

  const handleUnbind = async () => { await unbind(); toast(`${provider.name}已解绑`); onBound(); onClose(); };

  return (
    <Backdrop onClose={onClose}>
      <div style={{ width: 480, background: '#fff', borderRadius: 14, overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <DialogHeader provider={provider} assistantName={assistantName} />
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
              <QRBox>
                {state.qr_content ? <QRCodeSVG value={state.qr_content} size={180} level="M" /> : <div className="dim">无 QR</div>}
                {(state.sub === 'expired' || state.sub === 'redirect') && (
                  <QROverlay>{state.sub === 'expired' ? '二维码已过期' : '需重试'}</QROverlay>
                )}
              </QRBox>
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

// ── 飞书绑定弹窗（两步：扫码 → 等管理员审批） ───────────────────────────────

const FeishuBindDialog = ({ provider, assistantName, onClose, onBound, toast }: InternalProps) => {
  const { state, start, activate, unbind } = useFeishuBind({
    onBound: () => { toast(`${provider.name}绑定成功`); onBound(); },
    onError: (m) => toast(m, 'error'),
  });

  const handleUnbind = async () => { await unbind(); toast(`${provider.name}已解绑`); onBound(); onClose(); };

  return (
    <Backdrop onClose={onClose}>
      <div style={{ width: 500, background: '#fff', borderRadius: 14, overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <DialogHeader provider={provider} assistantName={assistantName} />
        <div style={{ padding: 22 }}>
          {(state.kind === 'loading') && <div className="dim">加载中…</div>}

          {/* 未绑定：展示步骤 + 获取二维码按钮 */}
          {state.kind === 'idle' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-start' }}>
              <Steps steps={provider.steps} />
              <button className="btn btn-primary" style={{ background: provider.brand }} onClick={start}>
                获取飞书二维码
              </button>
            </div>
          )}

          {state.kind === 'starting' && <div className="dim">正在请求二维码…</div>}

          {/* 第一步：扫码中 */}
          {state.kind === 'scanning' && (
            <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'center' }}>
              <QRBox>
                <QRCodeSVG value={state.qrUrl} size={180} level="M" />
              </QRBox>
              <div style={{ flex: 1, minWidth: 200 }}>
                <Steps steps={provider.steps} activeStep={0} brand={provider.brand} />
                <div className="muted" style={{ fontSize: 13, margin: '10px 0' }}>等待扫码…扫完后系统将自动为你创建飞书应用</div>
                <button className="btn btn-ghost" onClick={start}><IconRefresh size={15} />刷新二维码</button>
              </div>
            </div>
          )}

          {/* 第二步：等管理员审批 */}
          {(state.kind === 'pending_approval' || state.kind === 'activating') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Steps steps={provider.steps} activeStep={1} brand={provider.brand} />
              <div style={{
                background: '#fff7e6', border: '1px solid #ffd591', borderRadius: 10,
                padding: '12px 16px', fontSize: 13, lineHeight: 1.8,
              }}>
                <div style={{ fontWeight: 650, marginBottom: 6 }}>⏳ 等待企业管理员审批</div>
                <div>飞书应用已创建，需要企业管理员在飞书管理后台审批该应用后才能使用。</div>
                <div style={{ marginTop: 6 }}>
                  审批路径：飞书管理后台 → 应用管理 → 待审核应用
                </div>
                {state.adminConsoleUrl && (
                  <div style={{ marginTop: 8 }}>
                    <a
                      href={state.adminConsoleUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: provider.brand, fontWeight: 600, textDecoration: 'underline' }}
                    >
                      前往飞书管理后台审批 ↗
                    </a>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  className="btn btn-primary"
                  style={{ background: provider.brand }}
                  disabled={state.kind === 'activating'}
                  onClick={() => void activate(state.adminConsoleUrl)}
                >
                  {state.kind === 'activating' ? '验证中…' : '我已审批'}
                </button>
                <button className="btn btn-ghost" onClick={start}>
                  <IconRefresh size={15} />重新扫码
                </button>
              </div>
            </div>
          )}

          {/* 已激活 */}
          {state.kind === 'active' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontWeight: 650, color: 'var(--ok)' }}>✓ 飞书已接入 · App {state.appId.slice(0, 8)}…</div>
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.8 }}>
                助理正在替你监听飞书消息。联系人不会知道是 AI 回复。
              </div>
              <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', color: 'var(--bad)' }} onClick={handleUnbind}>
                解绑
              </button>
            </div>
          )}

          {/* 错误态 */}
          {state.kind === 'error' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ color: 'var(--bad)', fontSize: 13 }}>{state.message}</div>
              <button className="btn btn-primary" style={{ background: provider.brand, alignSelf: 'flex-start' }} onClick={start}>
                重新扫码
              </button>
            </div>
          )}
        </div>
      </div>
    </Backdrop>
  );
};

// ── 共用小组件 ────────────────────────────────────────────────────────────────

const DialogHeader = ({ provider, assistantName }: { provider: IMProvider; assistantName: string }) => (
  <div style={{ background: provider.brandWeak, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
    <span style={{ display: 'inline-flex' }}>{provider.icon}</span>
    <span style={{ fontWeight: 650 }}>{provider.bindTitlePrefix} {assistantName}</span>
  </div>
);

const Steps = ({ steps, activeStep, brand }: { steps: readonly string[]; activeStep?: number; brand?: string }) => (
  <div className="muted" style={{ fontSize: 13, lineHeight: 1.9 }}>
    {steps.map((s, i) => (
      <div key={i} style={activeStep === i ? { color: brand ?? 'inherit', fontWeight: 600 } : {}}>
        {i + 1} · {s}
      </div>
    ))}
  </div>
);

const QRBox = ({ children }: { children: ReactNode }) => (
  <div style={{
    width: 200, height: 200, background: '#fff',
    border: '1px solid var(--border)', borderRadius: 14, padding: 10,
    position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  }}>
    {children}
  </div>
);

const QROverlay = ({ children }: { children: ReactNode }) => (
  <div style={{
    position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.85)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 13, color: 'var(--bad)', fontWeight: 600, borderRadius: 14,
  }}>
    {children}
  </div>
);

const Backdrop = ({ children, onClose }: { children: ReactNode; onClose: () => void }) => (
  <div
    onClick={onClose}
    style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
  >
    {children}
  </div>
);
