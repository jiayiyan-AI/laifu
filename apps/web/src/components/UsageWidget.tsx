/**
 * UsageWidget — 显示在 Menubar 中的用量/余额指示器。
 * Hover 时弹出 popover 展示详细用量信息。
 * 所有额度/用量以 ¥ 计。
 */
import { useState, useRef, useEffect } from 'react';
import { usageAtom } from '../states/usage.atom.js';

const fmtCny = (n: number): string => {
  if (n <= 0) return '¥0';
  if (n < 0.01) return '< ¥0.01';
  return `¥${n.toFixed(2)}`;
};

export const UsageWidget = () => {
  const [{ data }, { refresh }] = usageAtom.use();
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const scheduleClose = () => {
    timerRef.current = setTimeout(() => setOpen(false), 160);
  };
  const cancelClose = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  };
  const handleEnter = () => { cancelClose(); setOpen(true); };
  const handleLeave = () => { scheduleClose(); };

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  if (!data) return null;

  const { used_cny_month, free_quota_cny_month, balance_cny } = data;
  const hasQuota = free_quota_cny_month > 0;
  const pct = hasQuota ? Math.min(used_cny_month / free_quota_cny_month, 1) : 0;
  const overQuota = hasQuota && used_cny_month >= free_quota_cny_month;

  // 剩余可用 = 免费剩余 + 余额
  const freeRemaining = Math.max(0, free_quota_cny_month - used_cny_month);
  const totalRemaining = freeRemaining + Math.max(0, balance_cny);

  const periodLabel = (() => {
    const d = new Date(data.period_start + 'T00:00:00');
    return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  })();

  return (
    <div
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text2)', cursor: 'default' }}
    >
      {/* Menubar 简要：直接显示"剩余可用" */}
      <span style={{
        whiteSpace: 'nowrap',
        color: totalRemaining <= 0 ? 'var(--bad)' : undefined,
        fontWeight: totalRemaining <= 0 ? 500 : undefined,
      }}>
        剩余 {fmtCny(totalRemaining)}
      </span>

      {/* Popover */}
      {open && (
        <div
          onMouseEnter={cancelClose}
          onMouseLeave={handleLeave}
          style={{
            position: 'absolute',
            top: 28,
            right: 0,
            width: 250,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: 'var(--shadow-l)',
            padding: '14px 16px',
            zIndex: 2000,
            fontSize: 12.5,
            color: 'var(--text)',
          }}
        >
          {/* 标题 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>用量统计</span>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{periodLabel}</span>
          </div>

          {/* 本月消费总额 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <span style={{ color: 'var(--text2)' }}>本月消费</span>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{fmtCny(used_cny_month)}</span>
          </div>

          {/* 免费额度区块 */}
          {hasQuota && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 11 }}>
                <span style={{ color: 'var(--text2)' }}>免费额度</span>
                <span style={{ color: overQuota ? 'var(--bad)' : 'var(--text)' }}>
                  {fmtCny(used_cny_month)} / {fmtCny(free_quota_cny_month)}
                </span>
              </div>
              <div style={{ width: '100%', height: 6, borderRadius: 3, background: 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                <div style={{
                  width: `${pct * 100}%`,
                  height: '100%',
                  borderRadius: 3,
                  background: overQuota ? 'var(--bad)' : 'var(--accent)',
                  transition: 'width 0.3s',
                }} />
              </div>
              <div style={{ marginTop: 5, fontSize: 11, color: overQuota ? 'var(--bad)' : 'var(--ok)' }}>
                {overQuota
                  ? `已超出 ${fmtCny(used_cny_month - free_quota_cny_month)}，从余额扣除`
                  : `剩余免费额度 ${fmtCny(freeRemaining)}`}
              </div>
            </div>
          )}

          {/* 余额 */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 0', borderTop: '1px solid var(--border)',
          }}>
            <span style={{ color: 'var(--text2)' }}>账户余额</span>
            <span style={{ fontWeight: 600, fontSize: 14, color: balance_cny <= 0 ? 'var(--bad)' : 'var(--text)' }}>
              {fmtCny(balance_cny)}
            </span>
          </div>

          {/* 提示 */}
          {totalRemaining <= 0 && (
            <div style={{
              marginTop: 8, padding: '8px 10px', fontSize: 11,
              background: 'var(--bad-w)', borderRadius: 6, color: 'var(--bad)', lineHeight: 1.5,
            }}>
              额度已用完，请联系管理员充值后继续使用。
            </div>
          )}

          {/* 刷新 */}
          <button
            onClick={(e) => { e.stopPropagation(); refresh(); }}
            style={{ marginTop: 10, width: '100%', padding: '6px 0', fontSize: 11, color: 'var(--accent)', background: 'var(--accent-weak)', border: 'none', borderRadius: 6, cursor: 'pointer' }}
          >
            刷新
          </button>
        </div>
      )}
    </div>
  );
};
