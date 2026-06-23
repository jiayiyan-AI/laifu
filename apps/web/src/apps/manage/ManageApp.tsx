import { useState } from 'react';
import type { Capability } from '../../lib/capabilities.js';
import { IconSpark, IconMessage, IconPlus } from '../../lib/icons.js';
import { entitlementsAtom } from '../../states/entitlements.atom.js';
import { CAPABILITIES, MARKET_CAPABILITIES, isEquipped } from '../../lib/capabilities.js';
import { CapabilityEquip, CapabilityRemove } from './CapabilityAction.js';
import { useAssistantName, assistantAtom } from '../../states/assistant.atom.js';
import { useIMCount } from '../../states/imBindings.atom.js';

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

export const ManageApp = ({ onOpenIM }: { onOpenIM: () => void }) => {
  const [ent] = entitlementsAtom.use();
  const [tab, setTab] = useState<Tab>('equip');
  const assistantName = useAssistantName();
  const [assistant] = assistantAtom.use();
  const email = assistant.email ?? '未分配';
  const imCount = useIMCount();

  const equipped = CAPABILITIES.filter((c) => isEquipped(c, ent.observed));

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 22 }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <div className="card" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
          <span style={{ display: 'inline-flex', width: 52, height: 52, borderRadius: 14, background: '#7c3aed1f', color: '#7c3aed', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <IconSpark size={26} strokeWidth={1.9} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 650, fontSize: 16 }}>{assistantName}</div>
            <div className="dim" style={{ fontSize: 12, fontFamily: 'monospace', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
              <span className="pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', display: 'inline-block', marginRight: 6 }} />
              在线 · 专业版 · {imCount > 0 ? `已接入 ${imCount} 个 IM` : '未接入 IM'}
            </div>
          </div>
          <button className="btn btn-primary" onClick={onOpenIM} title="管理 IM 接入">
            <IconMessage size={15} />
            IM 绑定{imCount > 0 ? ` · ${imCount}` : ''}
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
