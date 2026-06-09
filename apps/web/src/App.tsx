import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { WithStore } from './atom/index.js';
import { LoginPage } from './auth/LoginPage.js';
import { ProtectedRoute } from './auth/ProtectedRoute.js';
import { Desktop } from './desktop/Desktop.js';

const App = () => (
  <BrowserRouter>
    <WithStore>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/desktop" element={<ProtectedRoute><Desktop /></ProtectedRoute>} />
        <Route path="/" element={<Navigate to="/desktop" replace />} />
      </Routes>
    </WithStore>
  </BrowserRouter>
);

export default App;
