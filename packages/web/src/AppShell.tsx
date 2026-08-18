import AdminPanel from './components/AdminPanel.js';
import GalleryPage from './components/GalleryPage.js';
import { useAppRoute } from './lib/navigation.js';

/**
 * QQ 单通道（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §13/§14）：Web 只保留
 * 管理能力。/admin/* 是唯一入口；/gallery 是内容管理的一部分（Admin Token 保护）。
 * QQ 是唯一聊天通道；Web 只保留管理与图库。
 */
export default function AppShell() {
  const route = useAppRoute();
  return route === 'gallery' ? <GalleryPage /> : <AdminPanel />;
}
