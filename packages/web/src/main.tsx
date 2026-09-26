import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AppShell from './AppShell.js';

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');

createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>
);