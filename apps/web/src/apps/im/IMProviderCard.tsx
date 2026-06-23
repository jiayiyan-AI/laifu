import type { IMProvider } from './providers.js';

interface Props {
  provider: IMProvider;
  bound: boolean;
  boundAt?: string;
  boundNick?: string;
  onBind: () => void;
  onUnbind: () => void;
}

export const IMProviderCard = ({ provider, bound, boundAt, boundNick, onBind, onUnbind }: Props) => {
  const comingSoon = provider.status === 'coming_soon';
  const boundDate = boundAt ? new Date(boundAt).toLocaleDateString('zh-CN') : '';
  const desc = bound ? `绑定于 ${boundDate}${boundNick ? ` · ${boundNick}` : ''}` : provider.unboundDesc;
  return (
    <div className="card" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 14, opacity: comingSoon ? 0.6 : 1 }}>
      <span style={{ width: 44, height: 44, borderRadius: 12, background: provider.brandWeak, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {provider.icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 650, fontSize: 15 }}>{provider.name}</span>
          {bound && <span style={{ fontSize: 11, color: 'var(--ok)', background: 'rgba(22,163,74,0.12)', padding: '1px 8px', borderRadius: 999 }}>已生效</span>}
          {comingSoon && <span style={{ fontSize: 11, color: 'var(--muted)', background: 'rgba(0,0,0,0.06)', padding: '1px 8px', borderRadius: 999 }}>即将上线</span>}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{desc}</div>
      </div>
      {!comingSoon && (bound
        ? <button className="btn btn-ghost" style={{ color: 'var(--bad)' }} onClick={onUnbind}>解绑</button>
        : <button className="btn btn-primary" style={{ background: provider.brand }} onClick={onBind}>绑定</button>
      )}
    </div>
  );
};
