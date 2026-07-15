import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { WithStore } from '@lingxi/atom';
import { router } from './router';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WithStore>
      <RouterProvider router={router} />
    </WithStore>
  </React.StrictMode>,
);
