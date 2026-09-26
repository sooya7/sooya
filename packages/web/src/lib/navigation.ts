import { useEffect, useState } from 'react';

export const APP_NAVIGATION_EVENT = 'sooya:navigation';
export interface NavigateOptions { replace?: boolean; state?: unknown; }

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

/** The current pathname, following in-app navigation and the browser's back/forward. */
export function usePathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', update);
    window.addEventListener(APP_NAVIGATION_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(APP_NAVIGATION_EVENT, update);
    };
  }, []);
  return pathname;
}