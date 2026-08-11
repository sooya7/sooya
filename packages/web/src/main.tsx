import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AppShell from './AppShell.js';
import './styles.css';
import './components/AdminPanel.css';
import './components/life/LifeObservationPanel.css';
import './components/overlays.css';
import './components/FeatureEnhancements.css';

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');

createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void import('./lib/serviceWorkerUpdate.js')
      .then(({ registerServiceWorkerUpdate }) =>
        registerServiceWorkerUpdate((controller) => {
          // App.tsx renders the prompt; the worker keeps waiting until the user answers.
          window.dispatchEvent(new CustomEvent('sooya:sw-update-ready', { detail: controller }));
        })
      )
      .catch(() => { /* PWA is optional */ });
  });
}
