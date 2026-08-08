import { useEffect, useState } from 'react';
import ChatSessionHost from './App.js';
import AdminPanel from './components/AdminPanel.js';
import GalleryPage from './components/GalleryPage.js';
import LifeAdminPage from './components/LifeAdminPage.js';
import { ImageViewerHost } from './components/ImageViewerHost.js';
import { APP_NAVIGATION_EVENT, useAppRoute } from './lib/navigation.js';

export default function AppShell() {
  const route = useAppRoute();
  const [chatStarted, setChatStarted] = useState(route === 'chat');
  const shouldMountChat = chatStarted || route === 'chat';
  // The full Life console is addressed by exact path so the admin panel keeps
  // its own tab structure at /admin — including /admin/life, which is the
  // 「她的生活」tab, not the console. The path must react to SPA navigation
  // (pushState / popstate), otherwise the console never renders when reached
  // by an in-app link click.
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    window.addEventListener(APP_NAVIGATION_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(APP_NAVIGATION_EVENT, update);
    };
  }, []);
  const isLifeConsole = path === '/admin/life/console';

  useEffect(() => {
    if (route === 'chat') setChatStarted(true);
  }, [route]);

  return <>
    {shouldMountChat && <ChatSessionHost active={route === 'chat'} />}
    {route === 'chat' && <ImageViewerHost />}
    {route === 'gallery' && <GalleryPage />}
    {route === 'admin' && !isLifeConsole && <AdminPanel />}
    {route === 'admin' && isLifeConsole && <LifeAdminPage />}
  </>;
}
