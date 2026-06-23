import { useEffect, useState } from 'react';
import { startWechatBind, pollWechatBind, getMyWechatBind, unbindWechat } from '../../lib/api.js';

export type WechatSub = 'wait' | 'scaned' | 'expired' | 'redirect';
export type WechatBindState =
  | { kind: 'loading' }
  | { kind: 'unbound' }
  | { kind: 'starting' }
  | { kind: 'awaiting_scan'; qrcode: string; qr_content: string; sub: WechatSub }
  | { kind: 'bound'; ilink_bot_id: string; bound_at: string };

export const WECHAT_SUB_HINT: Record<WechatSub, string> = {
  wait: '等待扫码…',
  scaned: '已扫码,请在微信里确认',
  expired: '二维码已过期,请点击刷新',
  redirect: 'iLink 返回 redirect,本地暂不支持,请重试',
};

const POLL_INTERVAL_MS = 3000;

interface Opts { onBound?: () => void; onError?: (msg: string) => void; }

export const useWechatBind = (opts: Opts = {}) => {
  const [state, setState] = useState<WechatBindState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const timeoutId = window.setTimeout(() => { if (!cancelled) setState({ kind: 'unbound' }); }, 5000);
    void (async () => {
      try {
        const info = await getMyWechatBind();
        if (cancelled) return;
        window.clearTimeout(timeoutId);
        setState(info.bound
          ? { kind: 'bound', ilink_bot_id: info.ilink_bot_id, bound_at: info.bound_at }
          : { kind: 'unbound' });
      } catch {
        if (cancelled) return;
        window.clearTimeout(timeoutId);
        setState({ kind: 'unbound' });
      }
    })();
    return () => { cancelled = true; window.clearTimeout(timeoutId); };
  }, []);

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
          opts.onBound?.();
        } else if (r.status === 'expired') {
          setState((s) => s.kind === 'awaiting_scan' ? { ...s, sub: 'expired' } : s);
        } else if (r.status === 'scaned_but_redirect') {
          setState((s) => s.kind === 'awaiting_scan' ? { ...s, sub: 'redirect' } : s);
        } else {
          setState((s) => s.kind === 'awaiting_scan' ? { ...s, sub: r.status } : s);
        }
      } catch { /* 下一拍重试 */ }
    };
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollKey]);

  const start = async () => {
    setState({ kind: 'starting' });
    try {
      const { qrcode, qr_content } = await startWechatBind();
      setState({ kind: 'awaiting_scan', qrcode, qr_content, sub: 'wait' });
    } catch {
      setState({ kind: 'unbound' });
      opts.onError?.('启动绑定失败，请稍后再试');
    }
  };

  const unbind = async () => {
    try { await unbindWechat(); setState({ kind: 'unbound' }); }
    catch { opts.onError?.('解绑失败'); }
  };

  return { state, start, unbind };
};
