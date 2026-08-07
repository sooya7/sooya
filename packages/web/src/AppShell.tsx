import { useEffect, useState } from 'react';
import ChatSessionHost from './App.js';
import AdminPanel from './components/AdminPanel.js';
import GalleryPage from './components/GalleryPage.js';
import LifeAdminPage from './components/LifeAdminPage.js';
import MetricsDashboardPage from './components/MetricsDashboardPage.js';
import ShadowRunsPage from './components/ShadowRunsPage.js';
import VoicePreferencesPage from './components/VoicePreferencesPage.js';
import { ImageViewerHost } from './components/ImageViewerHost.js';
import { useAppRoute } from './lib/navigation.js';

export default function AppShell() {
  const route = useAppRoute();
  const [chatStarted, setChatStarted] = useState(route === 'chat');
  const shouldMountChat = chatStarted || route === 'chat';
  // Next phase pages are addressed by exact path so the admin panel keeps its
  // own tab structure at /admin.
  const path = typeof window !== 'undefined' ? window.location.pathname : '';
  const isLifeAdmin = path === '/admin/life';
  const isVoicePrefs = path === '/settings/voice';
  const isMetrics = path === '/admin/metrics';
  const isShadow = path === '/admin/shadow';

  useEffect(() => {
    if (route === 'chat') setChatStarted(true);
  }, [route]);

  return <>
    {shouldMountChat && <ChatSessionHost active={route === 'chat'} />}
    {route === 'chat' && <ImageViewerHost />}
    {route === 'gallery' && <GalleryPage />}
    {route === 'admin' && !isLifeAdmin && !isMetrics && !isShadow && <AdminPanel />}
    {route === 'admin' && isLifeAdmin && <LifeAdminPage />}
    {isVoicePrefs && <VoicePreferencesPage />}
    {route === 'admin' && isMetrics && <MetricsDashboardPage />}
    {route === 'admin' && isShadow && <ShadowRunsPage />}
  </>;
}
