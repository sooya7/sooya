import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AppShell from './AppShell.js';
import './styles.css';
import './components/AdminPanel.css';
import './components/life/LifeObservationPanel.css';
import './components/ScrollableLists.css';
import './components/overlays.css';
import './components/FeatureEnhancements.css';

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');

createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>
);
