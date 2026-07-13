// Tauri IPC 封装：调 Rust core 的 #[tauri::command]（见 src-tauri/src/app/ 各 commands 模块）。
//
//   open_login() -> Result<(), String>          // 建登录 webview；成功 emit "authed"，失败 emit "login-failed"，取消 emit "login-cancelled"
//   logout() -> Result<(), String>
//   is_authed() -> Result<bool, String>
//   open_sync_window() -> Result<(), String>     // 唤出（或聚焦）原生同步盘窗口，经系统菜单「同步盘 → 打开同步盘」触发
//   pick_sync_dir() -> Result<string | null, String>   // 原生目录选择对话框
//   set_sync_dir(dir: String) -> Result<(), String>     // 落盘 + 热重启同步会话
//   get_sync_dir() -> Result<string | null, String>     // 回读已配置目录
//   get_sync_status() -> Result<String, String>
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** 打开登录 webview：用户在同域内完成登录，Rust 拿 device-token 存 keychain 后 emit "authed"。 */
export function openLogin(): Promise<void> {
  return invoke<void>('open_login');
}

/** 登出：清 keychain，回 Unauthed。 */
export function logout(): Promise<void> {
  return invoke<void>('logout');
}

/** 查询当前是否已登录。 */
export function isAuthed(): Promise<boolean> {
  return invoke<boolean>('is_authed');
}

/** 唤出（或聚焦）原生同步盘窗口（系统菜单入口，见 src-tauri app/sync_commands.rs open_sync_window）。 */
export function openSyncWindow(): Promise<void> {
  return invoke<void>('open_sync_window');
}

/** 弹原生目录选择对话框，返回所选目录绝对路径；取消返回 null。 */
export function pickSyncDir(): Promise<string | null> {
  return invoke<string | null>('pick_sync_dir');
}

/** 设置本地同步目录（Rust 落盘持久化 + 热重启同步会话）。 */
export function setSyncDir(dir: string): Promise<void> {
  return invoke<void>('set_sync_dir', { dir });
}

/** 回读当前已配置的同步目录（启动回显；未配置返回 null）。 */
export function getSyncDir(): Promise<string | null> {
  return invoke<string | null>('get_sync_dir');
}

// --- 同步状态：Rust 返回 "idle" / "syncing" / "error: <msg>" / "attention: <msg>" ---

export type SyncPhase = 'idle' | 'syncing' | 'error' | 'attention';

export interface SyncStatus {
  phase: SyncPhase;
  message: string | null;
}

/** 解析 Rust 的状态字符串为结构化 SyncStatus。 */
export function parseSyncStatus(raw: string): SyncStatus {
  if (raw.startsWith('error:')) return { phase: 'error', message: raw.slice(6).trim() };
  if (raw.startsWith('attention:')) return { phase: 'attention', message: raw.slice(10).trim() };
  if (raw === 'syncing') return { phase: 'syncing', message: null };
  return { phase: 'idle', message: null };
}

/** 查询同步状态并解析。 */
export async function getSyncStatus(): Promise<SyncStatus> {
  return parseSyncStatus(await invoke<string>('get_sync_status'));
}

/** 订阅 Rust 登录成功事件（webview 换到 device-token 存 keychain 后触发）。 */
export function onAuthed(cb: () => void): Promise<UnlistenFn> {
  return listen('authed', () => cb());
}

/** 订阅登录窗被用户关闭但未完成换 token 的取消事件（复位 loggingIn）。 */
export function onLoginCancelled(cb: () => void): Promise<UnlistenFn> {
  return listen('login-cancelled', () => cb());
}

/** 订阅登录换 token 失败事件（payload 为错误信息，供前端显错并复位）。 */
export function onLoginFailed(cb: (message: string) => void): Promise<UnlistenFn> {
  return listen<string>('login-failed', (e) => cb(e.payload));
}
