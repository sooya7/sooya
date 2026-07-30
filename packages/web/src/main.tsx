import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import GalleryPage from './components/GalleryPage.js';
import AdminPanel from './components/AdminPanel.js';
import { ImageViewerHost } from './components/ImageViewerHost.js';
import './styles.css';
import './components/AdminPanel.css';
import './components/overlays.css';
import './components/FeatureEnhancements.css';

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');
const galleryRoute = window.location.pathname === '/gallery' || window.location.pathname === '/gallery/';
const featureAdminRoute = window.location.pathname === '/admin/features' || window.location.pathname === '/admin/features/';

createRoot(container).render(
  <StrictMode>
    {galleryRoute ? <GalleryPage /> : featureAdminRoute ? <AdminPanel initialTab="avatar" /> : <App />}
    {!galleryRoute && !featureAdminRoute && <ImageViewerHost />}
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
