import { isTauri, invoke } from '@tauri-apps/api/core';

/** 请求 native shell 在 tray 图标下方切换状态面板。 */
export async function showSyncFlyoutFromHome(): Promise<void> {
  if (!isTauri()) return;

  await invoke('show_sync_flyout_from_home');
}

/** 请求 native shell 显示或聚焦 settings 窗口。 */
export async function showSettingsWindowFromHome(): Promise<void> {
  if (!isTauri()) return;

  await invoke('show_settings_window_from_home');
}
