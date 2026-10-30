import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AuthProvider } from './auth';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('앱 루트를 찾지 못했습니다.');

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
