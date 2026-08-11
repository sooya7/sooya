import { useEffect, useState } from 'react';

export type AppRouteKind = 'chat' | 'moments' | 'gallery' | 'admin';
export const APP_NAVIGATION_EVENT = 'sooya:navigation';
export interface NavigateOptions { replace?: boolean; state?: unknown; }

export function classifyRoute(pathname: string): AppRouteKind {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (normalized === '/moments') return 'moments';
  if (normalized === '/gallery') return 'gallery';
  if (normalized === '/admin' || normalized.startsWith('/admin/')) return 'admin';
  return 'chat';
}
export function isAppNavigationUrl(target: URL): boolean {
  return (target.protocol === 'http:' || target.protocol === 'https:')
    && target.origin === window.location.origin;
}
export function notifyNavigation(): void { window.dispatchEvent(new Event(APP_NAVIGATION_EVENT)); }
export function navigate(href: string, options: NavigateOptions = {}): void {
  const target = new URL(href, window.location.href);
  if (!isAppNavigationUrl(target)) {
    throw new TypeError('App navigation requires a same-origin HTTP(S) URL');
  }
  const next = `${target.pathname}${target.search}${target.hash}`;
  const state = options.state ?? null;
  if (options.replace) window.history.replaceState(state, '', next);
  else window.history.pushState(state, '', next);
  notifyNavigation();
}
export function useAppRoute(): AppRouteKind {
  const [route, setRoute] = useState(() => classifyRoute(window.location.pathname));
  useEffect(() => {
    const update = () => setRoute(classifyRoute(window.location.pathname));
    window.addEventListener('popstate', update);
    window.addEventListener(APP_NAVIGATION_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(APP_NAVIGATION_EVENT, update);
    };
  }, []);
  return route;
}
