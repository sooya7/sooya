// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppShell from './AppShell.js';
import { navigate } from './lib/navigation.js';

const lifecycle = vi.hoisted(() => ({
  chatMounts: 0,
  chatUnmounts: 0,
  momentsMounts: 0,
  momentsUnmounts: 0,
  galleryMounts: 0,
  galleryUnmounts: 0,
  adminMounts: 0,
  adminUnmounts: 0
}));

vi.mock('./App.js', () => ({
  default: ({ active }: { active?: boolean }) => {
    useEffect(() => {
      lifecycle.chatMounts += 1;
      return () => { lifecycle.chatUnmounts += 1; };
    }, []);
    return active ? <div data-testid="chat">chat</div> : null;
  }
}));

vi.mock('./components/MomentsPage.js', () => ({
  default: () => {
    useEffect(() => {
      lifecycle.momentsMounts += 1;
      return () => { lifecycle.momentsUnmounts += 1; };
    }, []);
    return <div data-testid="moments">moments</div>;
  }
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

vi.mock('./components/ImageViewerHost.js', () => ({
  ImageViewerHost: () => <div data-testid="viewer">viewer</div>
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
  Object.assign(lifecycle, {
    chatMounts: 0,
    chatUnmounts: 0,
    momentsMounts: 0,
    momentsUnmounts: 0,
    galleryMounts: 0,
    galleryUnmounts: 0,
    adminMounts: 0,
    adminUnmounts: 0
  });
  window.history.replaceState(null, '', '/');
});

describe('AppShell route lifecycle', () => {
  it('starts chat lazily and preserves its host across internal routes', async () => {
    const host = await mount('/admin/features');

    expect(host.querySelector('[data-testid="admin"]')).not.toBeNull();
    expect(lifecycle.chatMounts).toBe(0);

    await act(async () => { navigate('/'); });

    expect(lifecycle.chatMounts).toBe(1);
    expect(host.querySelector('[data-testid="chat"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="viewer"]')).not.toBeNull();
    expect(lifecycle.adminUnmounts).toBe(1);

    await act(async () => { navigate('/moments'); });

    expect(lifecycle.chatMounts).toBe(1);
    expect(lifecycle.chatUnmounts).toBe(0);
    expect(host.querySelector('[data-testid="chat"]')).toBeNull();
    expect(host.querySelector('[data-testid="moments"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="viewer"]')).not.toBeNull();

    await act(async () => { navigate('/gallery'); });

    expect(lifecycle.momentsUnmounts).toBe(1);
    expect(lifecycle.chatMounts).toBe(1);
    expect(lifecycle.chatUnmounts).toBe(0);
    expect(host.querySelector('[data-testid="chat"]')).toBeNull();
    expect(host.querySelector('[data-testid="gallery"]')).not.toBeNull();

    await act(async () => { navigate('/'); });

    expect(lifecycle.chatMounts).toBe(1);
    expect(lifecycle.galleryUnmounts).toBe(1);
    expect(host.querySelector('[data-testid="chat"]')).not.toBeNull();

    window.history.pushState(null, '', '/admin/models');
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });

    expect(host.querySelector('[data-testid="admin"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="chat"]')).toBeNull();
  });

  it('serves the old /admin/life/console address through the single admin shell', async () => {
    const host = await mount('/admin/life/console');

    expect(host.querySelector('[data-testid="admin"]')).not.toBeNull();
    expect(lifecycle.adminMounts).toBe(1);
    expect(lifecycle.chatMounts).toBe(0);
  });
});
