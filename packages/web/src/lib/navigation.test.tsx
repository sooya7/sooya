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
    [{ href: '/gallery', target: '_blank' }, { button: 0 }],
    [{ href: '/gallery', download: true }, { button: 0 }],
    [{ href: '/gallery' }, { button: 0, ctrlKey: true }],
    [{ href: '/gallery' }, { button: 1 }]
  ] as const)('不接管浏览器原生点击 %#', async (props, init) => {
    const host = await render(<AppLink {...props}>目标</AppLink>);
    const push = vi.spyOn(window.history, 'pushState');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
    host.querySelector('a')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('navigate 与浏览器历史', () => {
  it('支持 replaceState 和 popstate', async () => {
    const host = await render(<RouteProbe />);
    await act(async () => { navigate('/gallery', { replace: true }); });
    expect(host.textContent).toBe('gallery');
    window.history.pushState(null, '', '/admin/models');
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(host.textContent).toBe('admin');
  });
});
