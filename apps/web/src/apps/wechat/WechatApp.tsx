import { IconMessage, IconRefresh } from '../../lib/icons.js';

const qrDataUri = (seed: string) => {
  const cells = 21;
  const size = 168;
  const cell = size / cells;
  const rand = (i: number, j: number) => {
    let x = seed.charCodeAt((i * cells + j) % seed.length) || 7;
    x = (x * 9301 + 49297) % 233280;
    return x / 233280;
  };
  const rects: string[] = [];
  for (let i = 0; i < cells; i++) for (let j = 0; j < cells; j++) {
    if (rand(i, j) < 0.5) rects.push(`<rect x="${j * cell}" y="${i * cell}" width="${cell}" height="${cell}" fill="#1b1c20"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${rects.join('')}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

export const WechatApp = () => {
  return (
    <div style={{ flex: 1, padding: 22, overflow: 'auto' }}>
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ width: 168, height: 168, background: '#fff', border: '1px solid var(--border)', borderRadius: 14, padding: 4, position: 'relative', flexShrink: 0 }}>
          <img src={qrDataUri('lingxi-mvp-placeholder')} alt="qr" style={{ width: '100%', height: '100%' }} />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ width: 36, height: 36, borderRadius: 9, background: '#7c3aed', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <IconMessage size={18} />
            </span>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 210 }}>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>微信扫码后，直接在微信里指挥灵犀助理</div>
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.9 }}>
            <div>1 · 打开微信 →「+」→ 扫一扫</div>
            <div>2 · 扫描左侧二维码并确认</div>
            <div>3 · 在微信对话框即可派活</div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => alert('真实绑定将在 Phase 1.4 接入')}>
              <IconRefresh size={15} />刷新
            </button>
            <button className="btn btn-primary" style={{ background: '#16a34a' }} onClick={() => alert('真实绑定将在 Phase 1.4 接入 iLink')}>
              <IconMessage size={15} />模拟绑定
            </button>
          </div>
          <div className="dim" style={{ fontSize: 11.5, marginTop: 14 }}>
            Phase 1.3 占位 — 真实微信 OAuth + iLink 长轮询将在 Phase 1.4 实施。
          </div>
        </div>
      </div>
    </div>
  );
};
