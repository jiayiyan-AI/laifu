import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent } from 'react';
import { IconSend } from '../../lib/icons.js';
import { useAssistantName } from '../../states/assistant.atom.js';

interface Props {
  disabled?: boolean;
  onSend: (text: string) => void;
}

const MAX_H = 120;

export const Composer = ({ disabled, onSend }: Props) => {
  const n = useAssistantName();
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 内容变化时自适应高度(≤MAX_H)并把视图滚到底, 保证最新一行始终可见。
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(MAX_H, el.scrollHeight)}px`;
    el.scrollTop = el.scrollHeight;
  }, [value]);

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
        ref={taRef}
        placeholder={`继续和${n}对话…`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) submit(e); }}
        rows={1}
        style={{ flex: 1, resize: 'none', border: '1px solid var(--border)', borderRadius: 12, padding: '10px 12px', maxHeight: MAX_H, overflowY: 'auto', outline: 'none', background: '#fff' }}
        disabled={disabled}
      />
      <button type="submit" className="btn btn-primary" style={{ padding: '10px 14px' }} disabled={disabled} aria-label="发送">
        <IconSend size={16} />
      </button>
    </form>
  );
};
