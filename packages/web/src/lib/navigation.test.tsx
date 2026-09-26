// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigate, usePathname } from './navigation.js';

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

function PathProbe() {
  return <output>{usePathname()}</output>;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
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

  it('pushState 并通知订阅者', async () => {
    const host = await render(<PathProbe />);
    const push = vi.spyOn(window.history, 'pushState');
    await act(async () => { navigate('/admin/memory'); });
    expect(push).toHaveBeenCalledWith(null, '', '/admin/memory');
    expect(host.textContent).toBe('/admin/memory');
  });

  it('支持 replaceState、history state 和 popstate', async () => {
    const host = await render(<PathProbe />);
    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');
    const state = { source: 'navigation-test' };
    await act(async () => { navigate('/admin/media', { replace: true, state }); });
    expect(replace).toHaveBeenCalledWith(state, '', '/admin/media');
    expect(push).not.toHaveBeenCalled();
    expect(host.textContent).toBe('/admin/media');
    window.history.pushState(null, '', '/admin/models');
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(host.textContent).toBe('/admin/models');
  });
});