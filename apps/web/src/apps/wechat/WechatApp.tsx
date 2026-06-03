import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { IconMessage, IconRefresh } from '../../lib/icons.js';
import {
  startWechatBind,
  pollWechatBind,
  getMyWechatBind,
  unbindWechat,
} from '../../lib/api.js';

type SubStatus = 'wait' | 'scaned' | 'expired' | 'redirect';

type State =
  | { kind: 'loading' }
  | { kind: 'unbound' }
  | { kind: 'starting' }
  | { kind: 'awaiting_scan'; qrcode: string; qr_content: string; sub: SubStatus }
  | { kind: 'bound'; ilink_bot_id: string; bound_at: string };

const POLL_INTERVAL_MS = 3000;

const SUB_HINT: Record<SubStatus, string> = {
  wait: '等待扫码…',
  scaned: '已扫码,请在微信里确认',
  expired: '二维码已过期,请点击刷新',
  redirect: 'iLink 返回 redirect,本地暂不支持,请重试',
};

export const WechatApp = () => {
  const [state, setState] = useState<State>({ kind: 'loading' });

  // mount: 拉当前绑定状态。带 5s 超时兜底,避免 fetch hang 时 UI 永远卡在 loading
  useEffect(() => {
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (!cancelled) {
        console.warn('[wechat-bind] info fetch timed out (>5s), defaulting to unbound');
        setState({ kind: 'unbound' });
      }
    }, 5000);

    void (async () => {
      try {
        const info = await getMyWechatBind();
        if (cancelled) return;
        window.clearTimeout(timeoutId);
        if (info.bound) {
          setState({ kind: 'bound', ilink_bot_id: info.ilink_bot_id, bound_at: info.bound_at });
        } else {
          setState({ kind: 'unbound' });
        }
      } catch (e) {
        if (cancelled) return;
        window.clearTimeout(timeoutId);
        console.error('[wechat-bind] info failed', e);
        setState({ kind: 'unbound' });
      }
    })();

    return () => { cancelled = true; window.clearTimeout(timeoutId); };
  }, []);

  // 轮询: 仅当 awaiting_scan 且 sub 还在 active 状态 (wait/scaned)
  const pollKey = state.kind === 'awaiting_scan' && (state.sub === 'wait' || state.sub === 'scaned')
    ? state.qrcode : null;

  useEffect(() => {
    if (!pollKey) return;
    let cancelled = false;
    const qrcode = pollKey;

    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await pollWechatBind(qrcode);
        if (cancelled) return;
        if (r.status === 'confirmed') {
          const info = await getMyWechatBind();
          if (cancelled || !info.bound) return;
          setState({ kind: 'bound', ilink_bot_id: info.ilink_bot_id, bound_at: info.bound_at });
        } else if (r.status === 'expired') {
          setState((s) => s.kind === 'awaiting_scan' ? { ...s, sub: 'expired' } : s);
        } else if (r.status === 'scaned_but_redirect') {
          setState((s) => s.kind === 'awaiting_scan' ? { ...s, sub: 'redirect' } : s);
        } else {
          setState((s) => s.kind === 'awaiting_scan' ? { ...s, sub: r.status } : s);
        }
      } catch (e) {
        console.error('[wechat-bind] poll failed', e);
      }
    };

    const interval = setInterval(tick, POLL_INTERVAL_MS);
    void tick();      // 立刻先拉一次,不等首个间隔
    return () => { cancelled = true; clearInterval(interval); };
  }, [pollKey]);

  const handleStart = async () => {
    setState({ kind: 'starting' });
    try {
      const { qrcode, qr_content } = await startWechatBind();
      setState({ kind: 'awaiting_scan', qrcode, qr_content, sub: 'wait' });
    } catch (e) {
      console.error('[wechat-bind] qr-start failed', e);
      setState({ kind: 'unbound' });
      alert('启动绑定失败,请稍后再试');
    }
  };

  const handleUnbind = async () => {
    if (!confirm('确定解绑微信吗?解绑后助理收不到新消息。')) return;
    try {
      await unbindWechat();
      setState({ kind: 'unbound' });
    } catch (e) {
      console.error('[wechat-bind] unbind failed', e);
      alert('解绑失败');
    }
  };

  return (
    <div style={{ flex: 1, padding: 22, overflow: 'auto' }}>
      {state.kind === 'loading' && <div className="dim">加载中…</div>}
      {state.kind === 'unbound' && <UnboundView onStart={handleStart} />}
      {state.kind === 'starting' && <div className="dim">正在请求二维码…</div>}
      {state.kind === 'awaiting_scan' && (
        <ScanView qrContent={state.qr_content} sub={state.sub} onRefresh={handleStart} />
      )}
      {state.kind === 'bound' && (
        <BoundView ilinkBotId={state.ilink_bot_id} boundAt={state.bound_at} onUnbind={handleUnbind} />
      )}
    </div>
  );
};

const UnboundView = ({ onStart }: { onStart: () => void }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-start' }}>
    <div style={{ fontWeight: 600, fontSize: 15 }}>用你自己的微信扫码,助理就能替你收发微信消息</div>
    <div className="muted" style={{ fontSize: 13, lineHeight: 1.9 }}>
      <div>1 · 点击「扫码绑定」获取二维码</div>
      <div>2 · 用微信扫描二维码并确认</div>
      <div>3 · 之后联系人发来的消息会被助理代收,Agent 回复也用你的微信号发出</div>
    </div>
    <button className="btn btn-primary" style={{ background: '#16a34a' }} onClick={onStart}>
      <IconMessage size={15} />扫码绑定
    </button>
    <div className="dim" style={{ fontSize: 11.5 }}>
      仅 text 消息,图片/语音/文件 MVP 暂不支持
    </div>
  </div>
);

const ScanView = ({ qrContent, sub, onRefresh }: { qrContent: string; sub: SubStatus; onRefresh: () => void }) => (
  <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'center' }}>
    <div style={{ width: 220, height: 220, background: '#fff', border: '1px solid var(--border)', borderRadius: 14, padding: 10, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {qrContent ? (
        <QRCodeSVG value={qrContent} size={200} level="M" />
      ) : (
        <div className="dim">无 QR</div>
      )}
      {(sub === 'expired' || sub === 'redirect') && (
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, color: 'var(--bad)', fontWeight: 600, borderRadius: 14,
        }}>
          {sub === 'expired' ? '二维码已过期' : '需重试'}
        </div>
      )}
    </div>
    <div style={{ flex: 1, minWidth: 210 }}>
      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>用微信扫一扫</div>
      <div className="muted" style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 14 }}>
        {SUB_HINT[sub]}
      </div>
      <button className="btn btn-ghost" onClick={onRefresh}>
        <IconRefresh size={15} />刷新二维码
      </button>
    </div>
  </div>
);

const BoundView = ({ ilinkBotId, boundAt, onUnbind }: {
  ilinkBotId: string;
  boundAt: string;
  onUnbind: () => void;
}) => {
  const shortId = ilinkBotId.length > 4 ? `…${ilinkBotId.slice(-4)}` : ilinkBotId;
  const boundDate = new Date(boundAt).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{
          width: 44, height: 44, borderRadius: 12,
          background: 'rgba(22,163,74,0.12)', color: '#16a34a',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <IconMessage size={22} />
        </span>
        <div>
          <div style={{ fontWeight: 650, fontSize: 16 }}>✓ 已绑定微信 · bot {shortId}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>绑定于 {boundDate}</div>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 13, lineHeight: 1.8 }}>
        助理正在替你监听微信。给你发消息的联系人不会知道是 AI 回复,所有消息看起来都来自你的微信号。
      </div>
      <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', color: 'var(--bad)' }} onClick={onUnbind}>
        解绑微信
      </button>
    </div>
  );
};
