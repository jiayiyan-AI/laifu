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
});
