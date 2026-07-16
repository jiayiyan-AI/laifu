import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { showSettingsWindowFromHome, showSyncFlyoutFromHome } from './desktop-bridge.js';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
}));

const isTauriMock = vi.mocked(isTauri);
const invokeMock = vi.mocked(invoke);


describe('home native bridge', () => {
  beforeEach(() => {
    isTauriMock.mockReset();
    invokeMock.mockReset();
  });

  it('invokes the tray-anchored flyout command without a page rect', async () => {
    isTauriMock.mockReturnValue(true);

    await showSyncFlyoutFromHome();

    expect(invokeMock).toHaveBeenCalledWith('show_sync_flyout_from_home');
  });

  it('opens settings through its dedicated command', async () => {
    isTauriMock.mockReturnValue(true);

    await showSettingsWindowFromHome();

    expect(invokeMock).toHaveBeenCalledWith('show_settings_window_from_home');
  });

  it('does not invoke native code in a browser', async () => {
    isTauriMock.mockReturnValue(false);

    await showSyncFlyoutFromHome();

    expect(invokeMock).not.toHaveBeenCalled();
  });
});
