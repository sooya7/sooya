// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppShell from './AppShell.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(path: string, token: string | null): Promise<HTMLDivElement> {
  window.history.replaceState(null, '', path);
  if (token) localStorage.setItem('sooya.admin-token', token);
  else localStorage.removeItem('sooya.admin-token');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<AppShell />); });
  await act(async () => { await Promise.resolve(); });
  return host;
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn()
  })) as unknown as typeof window.matchMedia;
  // No backend in unit tests: every request fails, pages show their error states.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('AppShell', () => {
  it('asks for the admin token first', async () => {
    const el = await mount('/admin', null);
    expect(el.querySelector('input[type="password"]')).not.toBeNull();
    expect(el.textContent).toContain('进入');
  });

  it('opens the console with every page in the navigation', async () => {
    const el = await mount('/admin/memory', 'token');
    const nav = el.querySelector('nav[aria-label="管理栏目"]')!;
    expect(nav.querySelectorAll('a.cs-nav-link').length).toBe(13);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toContain('记忆');
  });

  it.each([
    ['/gallery', '/admin/media'],
    ['/admin/avatar', '/admin/look'],
    ['/console/life', '/admin/life'],
    ['/', '/admin']
  ])('moves the old address %s to %s', async (from, to) => {
    await mount(from, 'token');
    expect(window.location.pathname).toBe(to);
  });
});
