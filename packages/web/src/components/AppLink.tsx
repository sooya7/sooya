import type { ComponentPropsWithoutRef, MouseEvent } from 'react';
import { isAppNavigationUrl, navigate } from '../lib/navigation.js';
export type AppLinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'href'> & { href: string; replace?: boolean };
export function AppLink({ href, replace = false, onClick, target, download, ...rest }: AppLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (download !== undefined && download !== false) return;
    if (target && target !== '_self') return;
    const destination = new URL(href, window.location.href);
    if (!isAppNavigationUrl(destination)) return;
    event.preventDefault();
    navigate(destination.href, { replace });
  };
  return <a {...rest} href={href} target={target} download={download} onClick={handleClick} />;
}
