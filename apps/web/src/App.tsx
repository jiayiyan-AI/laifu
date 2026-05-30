import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.js';
import { LoginPage } from './auth/LoginPage.js';
import { ProtectedRoute } from './auth/ProtectedRoute.js';

const DesktopPlaceholder = () => (
  <div style={{ padding: 24 }}>桌面（下个 task 实现）</div>
);

const App = () => (
  <BrowserRouter>
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/desktop" element={<ProtectedRoute><DesktopPlaceholder /></ProtectedRoute>} />
        <Route path="/" element={<Navigate to="/desktop" replace />} />
      </Routes>
    </AuthProvider>
  </BrowserRouter>
);

export default App;
