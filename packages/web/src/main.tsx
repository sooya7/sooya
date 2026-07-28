import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Register the service worker for offline shell + installability.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* PWA is optional; the app works without it */
    });
  });
}
