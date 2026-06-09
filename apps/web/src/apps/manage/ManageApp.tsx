import { useEffect, useState } from 'react';
import type { Capability } from '../../lib/capabilities.js';
import { authAtom } from '../../states/auth.atom.js';
import { IconSpark, IconMessage, IconPlus } from '../../lib/icons.js';
import { entitlementsAtom } from '../../states/entitlements.atom.js';
import { getMyWechatBind } from '../../lib/api.js';
import { CAPABILITIES, MARKET_CAPABILITIES, isEquipped } from '../../lib/capabilities.js';
import { CapabilityEquip, CapabilityRemove } from './CapabilityAction.js';

type Tab = 'equip' | 'market';

const EquipTab = ({ equipped, onAdd }: { equipped: Capability[]; onAdd: () => void }) => (
  <>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>已装备能力 · {equipped.length}</div>
      <button className="btn btn-soft" onClick={onAdd} style={{ padding: '6px 12px', fontSize: 13 }}>
        <IconPlus size={14} /> 添加能力
      </button>
    </div>
    <div style={{ display: 'grid', gap: 13, gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
      {equipped.map((c) => (
        <div key={c.id} style={{ position: 'relative', padding: 14, border: '1px solid var(--accent)', background: 'var(--accent-weak2)', borderRadius: 12 }}>
          {c.removable && (
            <CapabilityRemove cap={c} trigger={(open) => (
              <button
                onClick={open}
                title={`退订${c.name}`}
                style={{ position: 'absolute', top: 6, right: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--muted)', fontSize: 14 }}
              >
                ✕
              </button>
            )} />
          )}
          {c.icon}
          <div style={{ fontWeight: 600, marginTop: 10 }}>{c.name}</div>
          <div style={{ fontSize: 12, marginTop: 2, color: 'var(--accent-d)' }}>已装备</div>
        </div>
      ))}
    </div>
  </>
);

const MarketTab = ({ observed }: { observed: string[] }) => (
  <div style={{ display: 'grid', gap: 13, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
    {MARKET_CAPABILITIES.map((c) => {
      const owned = observed.includes(c.id);
      return (
        <div key={c.id} className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {c.icon}
            <div style={{ fontWeight: 600 }}>{c.name}</div>
          </div>
          <div className="muted" style={{ fontSize: 12, flex: 1 }}>{c.blurb}</div>
          <div style={{ fontSize: 12, color: 'var(--accent-d)' }}>价格: {c.price === 0 ? '免费' : `¥${c.price}`}</div>
          <div>
            {owned
              ? <button className="btn" disabled style={{ background: '#16a34a', color: 'white' }}>✓ 已装备</button>
              : <CapabilityEquip cap={c} />}
          </div>
        </div>
      );
    })}
  </div>
);

export const ManageApp = ({ onOpenWechat }: { onOpenWechat: () => void }) => {
  const [authState] = authAtom.use();
  const nick = authState.status === 'authenticated' ? authState.user.nickname ?? '未命名' : '';
  const [ent] = entitlementsAtom.use();
  const [tab, setTab] = useState<Tab>('equip');

  // 拉微信绑定状态决定按钮文案 (绑定 / 解绑)。null = 还没拿到 → 不显示文案避免闪烁。
  const [wechatBound, setWechatBound] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timeoutId = window.setTimeout(() => { if (!cancelled) setWechatBound(false); }, 5000);
    void getMyWechatBind()
      .then((info) => { if (!cancelled) { window.clearTimeout(timeoutId); setWechatBound(info.bound); } })
      .catch(() => { if (!cancelled) { window.clearTimeout(timeoutId); setWechatBound(false); } });
    return () => { cancelled = true; window.clearTimeout(timeoutId); };
  }, []);

  const equipped = CAPABILITIES.filter((c) => isEquipped(c, ent.observed));

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 22 }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <div className="card" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
          <span style={{ display: 'inline-flex', width: 52, height: 52, borderRadius: 14, background: '#7c3aed1f', color: '#7c3aed', alignItems: 'center', justifyContent: 'center' }}>
            <IconSpark size={26} strokeWidth={1.9} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 650, fontSize: 16 }}>灵犀助理</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
              <span className="pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', display: 'inline-block', marginRight: 6 }} />
              在线 · {nick} 的助理
            </div>
          </div>
          <button
            className="btn btn-primary"
            style={{ background: wechatBound ? '#6b7280' : '#16a34a' }}
            onClick={onOpenWechat}
            title={wechatBound ? '查看绑定 / 解绑' : '通过扫码绑定微信'}
          >
            <IconMessage size={15} />
            {wechatBound === null ? '微信…' : wechatBound ? '解绑微信' : '绑定微信'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          <button
            className="btn"
            onClick={() => setTab('equip')}
            style={{ fontWeight: tab === 'equip' ? 700 : 500, background: tab === 'equip' ? 'var(--accent-weak2)' : undefined }}
          >
            装备
          </button>
          <button
            className="btn"
            onClick={() => setTab('market')}
            style={{ fontWeight: tab === 'market' ? 700 : 500, background: tab === 'market' ? 'var(--accent-weak2)' : undefined }}
          >
            市场
          </button>
        </div>

        {tab === 'equip'
          ? <EquipTab equipped={equipped} onAdd={() => setTab('market')} />
          : <MarketTab observed={ent.observed} />}
      </div>
    </div>
  );
};
