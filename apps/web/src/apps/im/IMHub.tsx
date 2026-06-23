import { useState } from 'react';
import { IM_PROVIDERS, type IMProvider } from './providers.js';
import { IMProviderCard } from './IMProviderCard.js';
import { IMBindDialog } from './IMBindDialog.js';
import { imBindingsAtom, useIMCount } from '../../states/imBindings.atom.js';
import { useAssistantName } from '../../states/assistant.atom.js';

export const IMHub = () => {
  const [bindings, actions] = imBindingsAtom.use();
  const n = useIMCount();
  const assistantName = useAssistantName();
  const [active, setActive] = useState<IMProvider | null>(null);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 22 }}>
      {n === 0 && (
        <div className="muted" style={{ fontSize: 13, marginBottom: 16, padding: 12, background: 'var(--accent-weak2)', borderRadius: 10 }}>
          绑定 IM 后，可在 IM 里直接给助理派活。先绑一个试试 👇
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {IM_PROVIDERS.map((p) => (
          <IMProviderCard key={p.id} provider={p} bound={!!bindings[p.id]}
            onBind={() => setActive(p)} onUnbind={() => setActive(p)} />
        ))}
      </div>
      {active && (
        <IMBindDialog provider={active} assistantName={assistantName}
          onClose={() => setActive(null)} onBound={() => { void actions.refresh(); }} />
      )}
    </div>
  );
};
