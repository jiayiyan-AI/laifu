import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Conversation } from '../src/apps/chat/Conversation.js';

describe('Conversation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sending a message: posts /api/chat, shows pending, renders reply', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ reply: '你好,我是灵犀' })),
    );

    render(<Conversation threadId="thr_1" />);

    await user.type(screen.getByPlaceholderText(/继续和灵犀对话/), 'hello');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    // user message rendered
    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument());

    // POST hit /api/chat with thread_id + message
    const call = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/api/chat'));
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as any).body);
    expect(body.thread_id).toBe('thr_1');
    expect(body.message).toBe('hello');

    // assistant reply appears
    await waitFor(() => expect(screen.getByText('你好,我是灵犀')).toBeInTheDocument());
  });

  it('shows error message when fetch fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

    render(<Conversation threadId="thr_1" />);
    await user.type(screen.getByPlaceholderText(/继续和灵犀对话/), 'hi');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => expect(screen.getByText(/\[错误\] network down/)).toBeInTheDocument());
  });
});
