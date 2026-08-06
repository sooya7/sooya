// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLink } from '../components/AppLink.js';
import { classifyRoute, navigate, useAppRoute } from './navigation.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(node); });
  return container;
}

function RouteProbe() {
  const route = useAppRoute();
  return <output data-testid="route">{route}</output>;
}

function dispatchNativeClick(link: HTMLAnchorElement, init: MouseEventInit): boolean {
  let defaultPreventedByApp = true;
  document.addEventListener('click', (event) => {
    defaultPreventedByApp = event.defaultPrevented;
    event.preventDefault();
  }, { once: true });
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  return defaultPreventedByApp;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('classifyRoute', () => {
  it.each([
    ['/', 'chat'],
    ['/unknown', 'chat'],
    ['/gallery', 'gallery'],
    ['/gallery/', 'gallery'],
    ['/admin', 'admin'],
    ['/admin/features', 'admin']
  ] as const)('%s -> %s', (pathname, expected) => {
    expect(classifyRoute(pathname)).toBe(expected);
  });
});

describe('AppLink', () => {
  it('普通同源点击使用 pushState 并通知路由订阅者', async () => {
    const host = await render(<><AppLink href="/admin/features">管理</AppLink><RouteProbe /></>);
    const push = vi.spyOn(window.history, 'pushState');
    await act(async () => {
      host.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(push).toHaveBeenCalledWith(null, '', '/admin/features');
    expect(window.location.pathname).toBe('/admin/features');
    expect(host.querySelector('[data-testid="route"]')?.textContent).toBe('admin');
  });

  it.each([
    [{ href: 'https://example.com/x' }, { button: 0 }],
    [{ href: `blob:${window.location.origin}/app-link-test` }, { button: 0 }],
    [{ href: '/gallery', target: '_blank' }, { button: 0 }],
    [{ href: '/gallery', download: true }, { button: 0 }],
    [{ href: '/gallery' }, { button: 0, ctrlKey: true }],
    [{ href: '/gallery' }, { button: 0, metaKey: true }],
    [{ href: '/gallery' }, { button: 0, shiftKey: true }],
    [{ href: '/gallery' }, { button: 0, altKey: true }],
    [{ href: '/gallery' }, { button: 1 }]
  ] as const)('不接管浏览器原生点击 %#', async (props, init) => {
    const host = await render(<AppLink {...props}>目标</AppLink>);
    const push = vi.spyOn(window.history, 'pushState');
    const defaultPreventedByApp = dispatchNativeClick(host.querySelector('a')!, init);
    expect(defaultPreventedByApp).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('navigate 与浏览器历史', () => {
  it.each([
    'https://example.com/x',
    `blob:${window.location.origin}/navigation-test`
  ])('拒绝跨域或非 HTTP(S) 目标 %s', (href) => {
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    expect(() => navigate(href)).toThrow(TypeError);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('支持 replaceState、history state 和 popstate', async () => {
    const host = await render(<RouteProbe />);
    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');
    const state = { source: 'navigation-test' };
    await act(async () => { navigate('/gallery', { replace: true, state }); });
    expect(replace).toHaveBeenCalledWith(state, '', '/gallery');
    expect(push).not.toHaveBeenCalled();
    expect(host.textContent).toBe('gallery');
    window.history.pushState(null, '', '/admin/models');
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(host.textContent).toBe('admin');
  });
});
