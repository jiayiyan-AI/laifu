import { createHashRouter, Navigate } from 'react-router';
import { Flyout } from '@/routes/Flyout';
import { Login } from '@/routes/Login';
import { SettingsWindow } from '@/routes/SettingsWindow';

// Tauri 生产协议为 tauri://localhost；每个 native surface 都有明确 hash route。
export const router = createHashRouter([
  { path: '/flyout', element: <Flyout /> },
  { path: '/settings-window', element: <SettingsWindow /> },
  { path: '/login', element: <Login /> },
  { path: '*', element: <Navigate to="/flyout" replace /> },
]);
