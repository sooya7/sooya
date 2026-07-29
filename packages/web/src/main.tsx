import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import GalleryPage from './components/GalleryPage.js';
import FeatureAdminPage from './components/FeatureAdminPage.js';
import { ImageViewerHost } from './components/ImageViewerHost.js';
import { NotificationBridge } from './components/NotificationBridge.js';
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
    {galleryRoute ? <GalleryPage /> : featureAdminRoute ? <FeatureAdminPage /> : <App />}
    {!galleryRoute && !featureAdminRoute && <ImageViewerHost />}
    {!galleryRoute && !featureAdminRoute && <NotificationBridge />}
  </StrictMode>
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* PWA is optional */ }); });
}
