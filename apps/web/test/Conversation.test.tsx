import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Conversation } from '../src/apps/chat/Conversation.js';

// 挂载时会拉 /api/threads/:id/messages,默认返回空历史。
// 单独的 test case 可以覆盖这个默认行为来验拉历史。
const mockEmptyHistory = (fetchSpy: any) =>
  fetchSpy.mockImplementation(async (url: string) => {
    if (url.includes('/messages')) {
      return new Response(JSON.stringify({ messages: [] }));
    }
    return new Response(JSON.stringify({ reply: '你好,我是灵犀' }));
  });

describe('Conversation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sending a message: posts /api/chat, shows pending, renders reply', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(global, 'fetch');
    mockEmptyHistory(fetchSpy);

    render(<Conversation threadId="thr_1" />);

    // 等历史载入完
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/继续和灵犀对话/)).not.toBeDisabled(),
    );

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

  it('on mount, fetches /api/threads/:id/messages and renders past turns', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        messages: [
          { role: 'user', content: '我叫小明', ts: 1 },
          { role: 'assistant', content: '你好,小明', ts: 2 },
        ],
      })),
    );

    render(<Conversation threadId="thr_A" />);

    await waitFor(() => expect(screen.getByText('我叫小明')).toBeInTheDocument());
    expect(screen.getByText('你好,小明')).toBeInTheDocument();

    // 调的是历史接口,且 thread id 正确
    const call = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes('/api/threads/thr_A/messages'),
    );
    expect(call).toBeDefined();
  });

  it('shows error message when fetch fails', async () => {
    const user = userEvent.setup();
    // history 拉空 (mock 第一次,然后第二次 POST /api/chat 失败)
    const fetchSpy = vi.spyOn(global, 'fetch');
    fetchSpy.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ messages: [] })),
    );
    fetchSpy.mockRejectedValue(new Error('network down'));

    render(<Conversation threadId="thr_1" />);
    await user.type(screen.getByPlaceholderText(/继续和灵犀对话/), 'hi');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => expect(screen.getByText(/\[错误\] network down/)).toBeInTheDocument());
  });
});
