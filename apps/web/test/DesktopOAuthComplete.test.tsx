import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DesktopOAuthComplete } from '../src/auth/DesktopOAuthComplete.js';

function renderBridge(channel: string): void {
  render(
    <MemoryRouter initialEntries={[`/desktop-oauth-complete?code=one-time-code&channel=${channel}`]}>
      <DesktopOAuthComplete />
    </MemoryRouter>,
  );
}

describe('DesktopOAuthComplete', () => {
  it.each([
    ['dev', 'laifu-dev'],
    ['canary', 'laifu-canary'],
    ['stable', 'laifu'],
    ['unknown', 'laifu'],
  ])('maps %s to %s callback scheme', (channel, scheme) => {
    renderBridge(channel);

    expect(screen.getByRole('link', { name: '返回来福' })).toHaveAttribute(
      'href',
      `${scheme}://auth-callback?code=one-time-code`,
    );
  });
});
