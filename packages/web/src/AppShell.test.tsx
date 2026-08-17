// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppShell from './AppShell.js';
import { navigate } from './lib/navigation.js';

const lifecycle = vi.hoisted(() => ({
  galleryMounts: 0,
  galleryUnmounts: 0,
  adminMounts: 0,
  adminUnmounts: 0
}));

vi.mock('./components/GalleryPage.js', () => ({
  default: () => {
    useEffect(() => {
      lifecycle.galleryMounts += 1;
      return () => { lifecycle.galleryUnmounts += 1; };
    }, []);
    return <div data-testid="gallery">gallery</div>;
  }
}));

vi.mock('./components/AdminPanel.js', () => ({
  default: () => {
    useEffect(() => {
      lifecycle.adminMounts += 1;
      return () => { lifecycle.adminUnmounts += 1; };
    }, []);
    return <div data-testid="admin">admin</div>;
  }
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(pathname: string): Promise<HTMLDivElement> {
  window.history.replaceState(null, '', pathname);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<AppShell />); });
  return container;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  container?.remove();
  root = null;
  container = null;
  Object.assign(lifecycle, { galleryMounts: 0, galleryUnmounts: 0, adminMounts: 0, adminUnmounts: 0 });
  window.history.replaceState(null, '', '/admin');
});

/**
 * QQ 单通道后（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §13/§14）：Web 只剩 Admin 与
 * 受 Admin Token 保护的 /gallery；普通聊天 / Moments / PWA 路由不再渲染任何页面。
 */
describe('AppShell route lifecycle (admin only)', () => {
  it('renders admin for every non-gallery route, including legacy chat/moments paths', async () => {
    const host = await mount('/admin/models');
    expect(host.querySelector('[data-testid="admin"]')).not.toBeNull();
    expect(lifecycle.adminMounts).toBe(1);

    await act(async () => { navigate('/'); });
    expect(host.querySelector('[data-testid="admin"]')).not.toBeNull();
    expect(lifecycle.adminUnmounts).toBe(0); // 单 shell 不重挂

    await act(async () => { navigate('/moments'); });
    expect(host.querySelector('[data-testid="admin"]')).not.toBeNull();

    await act(async () => { navigate('/admin/qq'); });
    expect(host.querySelector('[data-testid="admin"]')).not.toBeNull();
  });

  it('renders the admin-token-protected gallery only at /gallery', async () => {
    const host = await mount('/gallery');
    expect(host.querySelector('[data-testid="gallery"]')).not.toBeNull();
    expect(lifecycle.galleryMounts).toBe(1);

    await act(async () => { navigate('/admin/life/console'); });
    expect(host.querySelector('[data-testid="gallery"]')).toBeNull();
    expect(host.querySelector('[data-testid="admin"]')).not.toBeNull();
    expect(lifecycle.galleryUnmounts).toBe(1);
  });

  it('keeps a single admin shell across deep admin tabs', async () => {
    const host = await mount('/admin/life/console');
    expect(host.querySelector('[data-testid="admin"]')).not.toBeNull();
    expect(lifecycle.adminMounts).toBe(1);

    await act(async () => { navigate('/admin/models'); });
    expect(lifecycle.adminMounts).toBe(1);
    expect(host.querySelector('[data-testid="admin"]')).not.toBeNull();
  });
});