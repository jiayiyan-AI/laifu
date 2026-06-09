import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LoginPage } from '../src/auth/LoginPage.js';
import { WithStore } from '../src/atom/index.js';

const wrap = (ui: ReactNode) => (
  <MemoryRouter><WithStore>{ui}</WithStore></MemoryRouter>
);

describe('LoginPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows Google login CTA pointing to /api/auth/google/start', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    render(wrap(<LoginPage />));
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /Google/ });
      expect(link).toBeInTheDocument();
      expect(link.getAttribute('href')).toBe('/api/auth/google/start');
    });
  });
});
