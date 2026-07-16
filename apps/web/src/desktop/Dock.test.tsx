import { render, screen, fireEvent } from '@testing-library/react';
import { WithStore } from '@lingxi/atom';
import { describe, expect, it, vi } from 'vitest';
import { Dock } from './Dock.js';

function renderDock(onShowSettings?: () => void): void {
  render(
    <WithStore>
      <Dock
        onOpen={vi.fn()}
        onShowSettings={onShowSettings}
        openApps={new Set(['chat'])}
        entitlements={[]}
      />
    </WithStore>,
  );
}

describe('Dock native settings action', () => {
  it('is absent without a native settings handler', () => {
    renderDock();

    expect(screen.queryByTitle('设置')).not.toBeInTheDocument();
  });

  it('opens settings without opening a virtual app', () => {
    const showSettings = vi.fn();
    const openApp = vi.fn();
    render(
      <WithStore>
        <Dock
          onOpen={openApp}
          onShowSettings={showSettings}
          openApps={new Set<string>()}
          entitlements={[]}
        />
      </WithStore>,
    );

    fireEvent.click(screen.getByTitle('设置'));

    expect(showSettings).toHaveBeenCalledOnce();
    expect(openApp).not.toHaveBeenCalled();
  });
});
