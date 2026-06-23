import { useEffect, useRef, useState } from 'react';
import * as api from '../lib/api.js';
import { IconSpark, IconRefresh } from '../lib/icons.js';
import { assistantAtom } from '../states/assistant.atom.js';
import { authAtom } from '../states/auth.atom.js';
import {
  isValidAssistantName,
  isValidEmailLocalpart,
  MAX_ASSISTANT_NAME_LEN,
  EMAIL_LOCALPART_MAX,
} from '@lingxi/shared';

/** 购买失败错误码 → 中文文案。未知错误透出真实信息。 */
const purchaseErrorMessage = (e: unknown): string => {
  if (e instanceof api.ApiError) {
    switch (e.code) {
      case 'email_taken': return '该邮箱前缀已被占用，换一个';
      case 'invalid_localpart': return '邮箱前缀格式不对（小写字母/数字开头结尾，可含 . _ -，3–32 位）';
      case 'invalid_assistant_name': return '请填写助理名字';
      default: return `激活失败：${e.message}`;
    }
  }
  return e instanceof Error ? e.message : '激活失败';
};

type View =
  | { mode: 'loading' }
  | { mode: 'not-purchased' }
  | { mode: 'provisioning'; step: string; pct: number }
  | { mode: 'failed'; err: string }
  | { mode: 'ready' };

interface OnboardingProps {
  onReady: () => void;
}

export const Onboarding = ({ onReady }: OnboardingProps) => {
  const [view, setView] = useState<View>({ mode: 'loading' });
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<number | null>(null);
  const [name, setName] = useState('');
  const [localpart, setLocalpart] = useState('');   // 用户自填邮箱前缀，可空（空→后端默认）
  const [formError, setFormError] = useState('');
  const [, assistantActions] = assistantAtom.use();
  const [auth] = authAtom.use();
  const domain = auth.status === 'authenticated' ? auth.user.email_domain : 'mail.localhost';
  const nameValid = isValidAssistantName(name);
  const localpartTrimmed = localpart.trim().toLowerCase();
  const localpartValid = localpartTrimmed === '' || isValidEmailLocalpart(localpartTrimmed);
  const canSubmit = nameValid && localpartValid;

  useEffect(() => {
    void (async () => {
      try {
        const s = await api.status();
        if (!s) { setView({ mode: 'not-purchased' }); return; }
        if (s.status === 'ready') { setView({ mode: 'ready' }); void assistantActions.refresh(); onReady(); return; }
        if (s.status === 'failed') { setView({ mode: 'failed', err: s.error_message ?? '未知错误' }); return; }
        setView({ mode: 'provisioning', step: s.provisioning_step ?? '准备中…', pct: s.progress_pct });
      } catch (e) {
        setView({ mode: 'failed', err: e instanceof Error ? e.message : '查询失败' });
      }
    })();
  }, [onReady]);

  useEffect(() => {
    if (view.mode !== 'provisioning') return;
    const tick = async () => {
      try {
        const s = await api.status();
        if (!s) return;
        if (s.status === 'ready') { void assistantActions.refresh(); onReady(); setView({ mode: 'ready' }); return; }
        if (s.status === 'failed') { setView({ mode: 'failed', err: s.error_message ?? '失败' }); return; }
        setView({ mode: 'provisioning', step: s.provisioning_step ?? '准备中…', pct: s.progress_pct });
      } catch { /* ignore tick errors */ }
    };
    pollRef.current = window.setInterval(tick, 1000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [view.mode, onReady]);

  const onPurchase = async () => {
    if (!canSubmit) return;
    setFormError('');
    setSubmitting(true);
    try {
      await api.purchase({
        assistant_name: name.trim(),
        email_localpart: localpartTrimmed || undefined,   // 空→后端走 u-<hash> 默认
      });
      assistantActions.setName(name.trim());
      setView({ mode: 'provisioning', step: '正在创建账户与订单', pct: 5 });
    } catch (e) {
      // 邮箱占用 / 格式错 → 停在表单内联提示让用户改；其它错 → 失败页
      if (e instanceof api.ApiError && (e.code === 'email_taken' || e.code === 'invalid_localpart')) {
        setFormError(purchaseErrorMessage(e));
      } else {
        setView({ mode: 'failed', err: purchaseErrorMessage(e) });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (view.mode === 'loading') return <div className="dim" style={{ padding: 24 }}>加载中…</div>;
  if (view.mode === 'ready') return null;

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, background: 'linear-gradient(180deg,#fff,#f7f5fd)' }}>
      <div style={{ width: 480, textAlign: 'center' }}>
        <span style={{ display: 'inline-flex', width: 76, height: 76, borderRadius: 22, background: '#7c3aed1f', color: '#7c3aed', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
          <IconSpark size={38} strokeWidth={1.9} />
        </span>
        <div style={{ fontSize: 22, fontWeight: 700 }}>欢迎使用灵犀</div>
        <p className="muted" style={{ fontSize: 13.5, margin: '10px 0 22px', lineHeight: 1.7 }}>
          激活你的数字助理「灵犀」——统一对话入口，按需装备能力。
        </p>

        {view.mode === 'not-purchased' && (
          <div style={{ textAlign: 'left' }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>
              给你的助理起个名字 <span style={{ color: 'var(--bad)' }}>*</span>
              <span className="dim" style={{ fontWeight: 400, marginLeft: 6 }}>必填</span>
            </label>
            <input className="input" autoFocus maxLength={MAX_ASSISTANT_NAME_LEN} value={name}
              onChange={(e) => { setName(e.target.value); setFormError(''); }} placeholder="如：灵犀 / Aria / 小助"
              style={{ width: '100%', marginTop: 8 }} />

            <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginTop: 16 }}>
              专属邮箱
              <span className="dim" style={{ fontWeight: 400, marginLeft: 6 }}>选填，留空自动分配</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginTop: 8 }}>
              <input className="input" maxLength={EMAIL_LOCALPART_MAX} value={localpart}
                onChange={(e) => { setLocalpart(e.target.value); setFormError(''); }}
                placeholder="自己起一个，如 aria"
                style={{ flex: 1, textAlign: 'right', borderTopRightRadius: 0, borderBottomRightRadius: 0 }} />
              <span className="dim" style={{
                fontFamily: 'monospace', fontSize: 13, padding: '0 10px', height: 38,
                display: 'inline-flex', alignItems: 'center',
                border: '1px solid var(--border)', borderLeft: 'none',
                borderTopRightRadius: 10, borderBottomRightRadius: 10, background: 'var(--bg-soft, #f4f4f6)',
              }}>@{domain}</span>
            </div>
            {!localpartValid && (
              <div style={{ color: 'var(--bad)', fontSize: 11.5, marginTop: 6 }}>
                小写字母/数字开头结尾，可含 . _ -，3–32 位
              </div>
            )}

            {formError && (
              <div style={{ color: 'var(--bad)', fontSize: 12.5, marginTop: 12 }}>{formError}</div>
            )}

            <div className="muted" style={{ fontSize: 12, margin: '16px 0 6px' }}>套餐 · MVP 阶段免费</div>
            <button className="btn btn-primary"
              style={{ width: '100%', padding: '12px 28px', fontSize: 14, marginTop: 10, opacity: canSubmit ? 1 : 0.5 }}
              disabled={submitting || !canSubmit} onClick={onPurchase}>
              {submitting ? '激活中…' : '确认支付并激活'}
            </button>
          </div>
        )}

        {view.mode === 'provisioning' && (
          <div className="fade">
            {name.trim() && (
              <div style={{ margin: '4px 0 14px' }}>
                <div style={{ fontSize: 15, fontWeight: 650 }}>{name.trim()}</div>
                {localpartTrimmed && (
                  <div className="dim" style={{ fontSize: 11.5, fontFamily: 'monospace' }}>{localpartTrimmed}@{domain}</div>
                )}
              </div>
            )}
            <div className="muted" style={{ height: 20, margin: '12px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 13 }}>
              <span className="spin"><IconRefresh size={13} /></span>{view.step}
            </div>
            <div className="progress"><div style={{ width: `${view.pct}%` }} /></div>
            <div className="dim" style={{ fontSize: 11.5, marginTop: 10 }}>
              ✉️ 正在为助理分配专属邮箱…
            </div>
          </div>
        )}

        {view.mode === 'failed' && (
          <div>
            <div style={{ color: 'var(--bad)', fontSize: 13, marginBottom: 12 }}>{view.err}</div>
            <button className="btn btn-ghost" onClick={() => setView({ mode: 'not-purchased' })}>重试</button>
          </div>
        )}
      </div>
    </div>
  );
};
