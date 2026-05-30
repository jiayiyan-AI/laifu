import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { IconSend } from '../../lib/icons.js';

interface Props {
  disabled?: boolean;
  onSend: (text: string) => void;
}

export const Composer = ({ disabled, onSend }: Props) => {
  const [value, setValue] = useState('');

  const submit = (e: FormEvent | KeyboardEvent) => {
    e.preventDefault();
    const t = value.trim();
    if (!t || disabled) return;
    onSend(t);
    setValue('');
  };

  return (
    <form onSubmit={submit} style={{ flexShrink: 0, borderTop: '1px solid var(--border)', background: 'rgba(255,255,255,0.8)', padding: '13px 18px', display: 'flex', gap: 10, alignItems: 'flex-end' }}>
      <textarea
        placeholder="继续和灵犀对话…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) submit(e); }}
        rows={1}
        style={{ flex: 1, resize: 'none', border: '1px solid var(--border)', borderRadius: 12, padding: '10px 12px', maxHeight: 120, outline: 'none', background: '#fff' }}
        disabled={disabled}
      />
      <button type="submit" className="btn btn-primary" style={{ padding: '10px 14px' }} disabled={disabled} aria-label="发送">
        <IconSend size={16} />
      </button>
    </form>
  );
};
