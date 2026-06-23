import { useEffect, useRef, useState } from 'react';
import {
  feishuScanStart,
  feishuScanPoll,
  feishuActivate,
  getMyFeishuBind,
  unbindFeishu,
} from '../../lib/api.js';

export type FeishuBindState =
  | { kind: 'loading' }
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'scanning'; qrUrl: string; deviceCode: string; pollIntervalSec: number }
  | { kind: 'pending_approval'; adminConsoleUrl: string }
  | { kind: 'activating'; adminConsoleUrl: string }  // 点"我已审批"后等后端验活，保留 url 以便失败后回退
  | { kind: 'active'; appId: string }
  | { kind: 'error'; message: string };

interface Opts {
  onBound?: () => void;
  onError?: (msg: string) => void;
}

export const useFeishuBind = (opts: Opts = {}) => {
  const [state, setState] = useState<FeishuBindState>({ kind: 'loading' });
  // 用 ref 持有最新 opts，避免闭包过时
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // 初始化：还原已有绑定态
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await getMyFeishuBind();
        if (cancelled) return;
        if (!info.bound) {
          setState({ kind: 'idle' });
        } else if (info.status === 'active') {
          setState({ kind: 'active', appId: info.app_id });
        } else {
          // pending_approval — 已建 app 但未激活
          // 后台深链已丢失，置空让用户联系管理员或重新扫
          setState({ kind: 'pending_approval', adminConsoleUrl: '' });
        }
      } catch {
        if (cancelled) return;
        setState({ kind: 'idle' });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 轮询：仅在 scanning 阶段激活
  const pollDeviceCode = state.kind === 'scanning' ? state.deviceCode : null;
  const pollIntervalSec = state.kind === 'scanning' ? state.pollIntervalSec : 5;

  useEffect(() => {
    if (!pollDeviceCode) return;
    let cancelled = false;
    const deviceCode = pollDeviceCode;

    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await feishuScanPoll(deviceCode);
        if (cancelled) return;
        if (r.status === 'approved') {
          setState({ kind: 'pending_approval', adminConsoleUrl: r.adminConsoleUrl });
        } else if (r.status === 'denied') {
          setState({ kind: 'error', message: '用户拒绝了授权，请重新扫码' });
          optsRef.current.onError?.('用户拒绝了授权，请重新扫码');
        } else if (r.status === 'expired') {
          setState({ kind: 'error', message: '二维码已过期，请重新扫码' });
          optsRef.current.onError?.('二维码已过期，请重新扫码');
        }
        // status === 'pending'：继续轮询，什么都不做
      } catch {
        // 网络抖动，下一拍重试
      }
    };

    const id = setInterval(tick, pollIntervalSec * 1000);
    void tick();
    return () => { cancelled = true; clearInterval(id); };
  }, [pollDeviceCode, pollIntervalSec]);

  // 动作：开始扫码
  const start = async () => {
    setState({ kind: 'starting' });
    try {
      const { qrUrl, deviceCode, interval } = await feishuScanStart();
      setState({ kind: 'scanning', qrUrl, deviceCode, pollIntervalSec: interval });
    } catch {
      setState({ kind: 'idle' });
      optsRef.current.onError?.('启动飞书绑定失败，请稍后再试');
    }
  };

  // 动作：用户点"我已审批"
  const activate = async (adminConsoleUrl: string) => {
    setState({ kind: 'activating', adminConsoleUrl });
    try {
      const r = await feishuActivate();
      if (r.ok) {
        // 拉最新绑定信息确认
        const info = await getMyFeishuBind();
        if (info.bound && info.status === 'active') {
          setState({ kind: 'active', appId: info.app_id });
          optsRef.current.onBound?.();
        } else {
          // 后端说 ok 但查不到 active，回待审批
          setState({ kind: 'pending_approval', adminConsoleUrl });
          optsRef.current.onError?.('审批似乎还没完成，稍后再试');
        }
      } else {
        setState({ kind: 'pending_approval', adminConsoleUrl });
        optsRef.current.onError?.('审批似乎还没完成，稍后再试');
      }
    } catch {
      // 验活失败，说明管理员还没批，回待审批
      setState({ kind: 'pending_approval', adminConsoleUrl });
      optsRef.current.onError?.('审批似乎还没完成，稍后再试');
    }
  };

  // 动作：解绑
  const unbind = async () => {
    try {
      await unbindFeishu();
      setState({ kind: 'idle' });
    } catch {
      optsRef.current.onError?.('解绑失败，请稍后再试');
    }
  };

  return { state, start, activate, unbind };
};
