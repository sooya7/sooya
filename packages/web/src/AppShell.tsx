import { useEffect, useState } from 'react';
import ChatSessionHost from './App.js';
import AdminPanel from './components/AdminPanel.js';
import GalleryPage from './components/GalleryPage.js';
import { ImageViewerHost } from './components/ImageViewerHost.js';
import { useAppRoute } from './lib/navigation.js';

export default function AppShell() {
  const route = useAppRoute();
  const [chatStarted, setChatStarted] = useState(route === 'chat');
  const shouldMountChat = chatStarted || route === 'chat';

  useEffect(() => {
    if (route === 'chat') setChatStarted(true);
  }, [route]);

  return <>
    {shouldMountChat && <ChatSessionHost active={route === 'chat'} />}
    {route === 'chat' && <ImageViewerHost />}
    {route === 'gallery' && <GalleryPage />}
    {route === 'admin' && <AdminPanel />}
  </>;
}
