import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Conversation } from '../src/apps/chat/Conversation.js';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatch(type: string, data: object) {
    const evt = new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners[type]?.forEach((fn) => fn(evt));
  }
  close() { this.closed = true; }
}

describe('Conversation', () => {
  let OrigES: any;
  beforeEach(() => {
    OrigES = (global as any).EventSource;
    (global as any).EventSource = MockEventSource;
    MockEventSource.instances = [];
    vi.restoreAllMocks();
  });
  afterEach(() => {
    (global as any).EventSource = OrigES;
  });

  it('sending a message: posts /chat/start, opens EventSource, renders tokens, then done', async () => {
    const user = userEvent.setup();
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ stream_id: 'stm_outer' })),
    );

    render(<Conversation threadId="thr_1" />);

    await user.type(screen.getByPlaceholderText(/继续和灵犀对话/), 'hello');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument());

    const es = await waitFor(() => MockEventSource.instances[0]!);
    expect(es.url).toContain('/api/chat/stream');
    expect(es.url).toContain('stm_outer');

    es.dispatch('token', { text: '你' });
    es.dispatch('token', { text: '好' });
    es.dispatch('done', { full_reply: '你好', session_id: 'web:thr_1' });

    await waitFor(() => expect(screen.getByText('你好')).toBeInTheDocument());
    expect(es.closed).toBe(true);
  });
});
