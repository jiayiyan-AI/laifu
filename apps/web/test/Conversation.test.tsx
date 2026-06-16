import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Conversation } from '../src/apps/chat/Conversation.js';

// 默认 mock: history 和 loop 查询都返回空/null。
const setupEmptyMock = (fetchSpy: ReturnType<typeof vi.spyOn>) =>
  fetchSpy.mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/messages')) {
      return new Response(JSON.stringify({ messages: [] }));
    }
    if (typeof url === 'string' && url.includes('/loop')) {
      return new Response(JSON.stringify({ loop: null }));
    }
    // POST /api/chat → async response
    return new Response(JSON.stringify({ kind: 'dispatched', user_msg_id: 'msg_1', loop_id: 'loop_1' }));
  });

describe('Conversation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sending a message: posts /api/chat, shows pending bubble', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(global, 'fetch') as ReturnType<typeof vi.spyOn>;
    setupEmptyMock(fetchSpy);

    render(<Conversation threadId="thr_1" />);

    await waitFor(() =>
      expect(screen.getByPlaceholderText(/继续和灵犀对话/)).not.toBeDisabled(),
    );

    await user.type(screen.getByPlaceholderText(/继续和灵犀对话/), 'hello');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    // user message rendered
    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument());

    // POST hit /api/chat with thread_id + message
    const call = fetchSpy.mock.calls.find((c: any[]) => String(c[0]).includes('/api/chat'));
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as any).body);
    expect(body.thread_id).toBe('thr_1');
    expect(body.message).toBe('hello');

    // pending assistant bubble
    await waitFor(() => expect(screen.getByText('灵犀正在思考…')).toBeInTheDocument());
  });

  it('on mount, fetches /api/threads/:id/messages and renders past turns', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch') as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/messages')) {
        return new Response(JSON.stringify({
          messages: [
            { id: 'msg_1', thread_id: 'thr_A', role: 'user', content_type: 'text', content: '我叫小明', source: 'web', created_at: '2025-01-01T00:00:00Z' },
            { id: 'msg_2', thread_id: 'thr_A', role: 'assistant', content_type: 'text', content: '你好,小明', source: 'web', created_at: '2025-01-01T00:00:01Z' },
          ],
        }));
      }
      if (typeof url === 'string' && url.includes('/loop')) {
        return new Response(JSON.stringify({ loop: null }));
      }
      return new Response(JSON.stringify({}));
    });

    render(<Conversation threadId="thr_A" />);

    await waitFor(() => expect(screen.getByText('我叫小明')).toBeInTheDocument());
    expect(screen.getByText('你好,小明')).toBeInTheDocument();

    const call = fetchSpy.mock.calls.find((c: any[]) =>
      String(c[0]).includes('/api/threads/thr_A/messages'),
    );
    expect(call).toBeDefined();
  });

  it('shows error message when sendChat fails', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(global, 'fetch') as ReturnType<typeof vi.spyOn>;
    let callCount = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/messages')) {
        return new Response(JSON.stringify({ messages: [] }));
      }
      if (typeof url === 'string' && url.includes('/loop')) {
        return new Response(JSON.stringify({ loop: null }));
      }
      // POST /api/chat fails
      throw new Error('network down');
    });

    render(<Conversation threadId="thr_1" />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/继续和灵犀对话/)).not.toBeDisabled(),
    );
    await user.type(screen.getByPlaceholderText(/继续和灵犀对话/), 'hi');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => expect(screen.getByText(/network down/)).toBeInTheDocument());
  });
});
