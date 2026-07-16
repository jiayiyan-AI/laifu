import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThreadList } from '../src/apps/chat/ThreadList.js';

describe('ThreadList', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('renders fetched threads, marks selected', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      threads: [
        { id: 'thr_1', title: 'A', updated_at: '2026-05-30T10:00:00Z', archived: false },
        { id: 'thr_2', title: 'B', updated_at: '2026-05-30T09:00:00Z', archived: false },
      ],
    })));
    render(<ThreadList selected="thr_1" onSelect={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText('A')).toBeInTheDocument();
      expect(screen.getByText('B')).toBeInTheDocument();
    });
  });

  it('new conversation creates a thread and selects it', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ threads: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'thr_new', user_id: 'u1', source: 'web', title: null, created_at: 'x', updated_at: 'x', archived: false,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ threads: [] })));

    render(<ThreadList selected={null} onSelect={onSelect} />);
    await user.click(await screen.findByRole('button', { name: /新对话/ }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('thr_new'));
  });
  it('delete button opens a confirmation dialog, then deletes and clears selection', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const fetchSpy = vi.spyOn(global, 'fetch')
      // initial list
      .mockResolvedValueOnce(new Response(JSON.stringify({
        threads: [
          { id: 'thr_1', title: 'A', updated_at: '2026-05-30T10:00:00Z', archived: false },
          { id: 'thr_2', title: 'B', updated_at: '2026-05-30T09:00:00Z', archived: false },
        ],
      })))
      // DELETE response
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      // reload list — thr_1 gone
      .mockResolvedValueOnce(new Response(JSON.stringify({
        threads: [{ id: 'thr_2', title: 'B', updated_at: '2026-05-30T09:00:00Z', archived: false }],
      })));
    render(<ThreadList selected="thr_1" onSelect={onSelect} />);

    const btn = await screen.findByRole('button', { name: /删除对话 A/ });
    await user.click(btn);

    expect(screen.getByRole('dialog', { name: '删除「A」？' })).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      // DELETE call shape
      const deleteCall = fetchSpy.mock.calls.find(
        ([url, init]) => typeof url === 'string' && url === '/api/threads/thr_1' && (init as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deleteCall).toBeDefined();
      // selected thr_1 was deleted → onSelect called with the new first remaining
      expect(onSelect).toHaveBeenCalledWith('thr_2');
    });
  });

  it('canceling the confirmation does not delete the thread', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      threads: [{ id: 'thr_1', title: 'A', updated_at: '2026-05-30T10:00:00Z', archived: false }],
    })));
    render(<ThreadList selected="thr_1" onSelect={onSelect} />);

    const btn = await screen.findByRole('button', { name: /删除对话 A/ });
    await user.click(btn);
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
