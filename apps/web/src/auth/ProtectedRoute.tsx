import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { authAtom } from '../states/auth.atom.js';

export const ProtectedRoute = ({ children }: { children: ReactNode }) => {
  const [state] = authAtom.use();
  if (state.status === 'loading') {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="dim">
        加载中…
      </div>
    );
  }
  if (state.status === 'unauthenticated') {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
};
