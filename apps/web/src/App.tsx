import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.js';
import { LoginPage } from './auth/LoginPage.js';
import { ProtectedRoute } from './auth/ProtectedRoute.js';
import { Desktop } from './desktop/Desktop.js';
import { EntitlementsProvider } from './lib/entitlements-context.js';

const App = () => (
  <BrowserRouter>
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/desktop" element={<ProtectedRoute><EntitlementsProvider><Desktop /></EntitlementsProvider></ProtectedRoute>} />
        <Route path="/" element={<Navigate to="/desktop" replace />} />
      </Routes>
    </AuthProvider>
  </BrowserRouter>
);

export default App;
