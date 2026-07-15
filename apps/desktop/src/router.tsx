import { createHashRouter, Navigate } from 'react-router';
import { Login } from '@/routes/Login';
import { AppLayout } from '@/routes/AppLayout';
import { Sync } from '@/routes/Sync';
import { Settings } from '@/routes/Settings';

// Tauri 生产协议为 tauri://localhost，HashRouter 无需服务端 history 支持，最稳。
export const router = createHashRouter([
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/sync" replace /> },
      { path: 'sync', element: <Sync /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
