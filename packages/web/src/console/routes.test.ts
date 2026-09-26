import { describe, expect, it } from 'vitest';
import { canonicalPath, consolePath, routeFromPath, ROUTES } from './routes.js';

describe('console routes', () => {
  it('leaves canonical addresses alone', () => {
    for (const route of ROUTES) expect(canonicalPath(consolePath(route.slug))).toBeNull();
  });

  it.each([
    ['/', '/admin'],
    ['/moments', '/admin'],
    ['/gallery', '/admin/media'],
    ['/gallery/', '/admin/media'],
    ['/console', '/admin'],
    ['/console/life', '/admin/life'],
    ['/admin/', '/admin'],
    ['/admin/overview', '/admin'],
    ['/admin/avatar', '/admin/look'],
    ['/admin/voice', '/admin/persona'],
    ['/admin/features', '/admin/persona'],
    ['/admin/content', '/admin/media'],
    ['/admin/content/stickers', '/admin/media'],
    ['/admin/mcp', '/admin/tools'],
    ['/admin/operations', '/admin/ops'],
    ['/admin/life/console', '/admin/life'],
    ['/admin/no-such-page', '/admin']
  ])('moves %s to %s', (from, to) => {
    expect(canonicalPath(from)).toBe(to);
  });

  it('resolves the page for old and new addresses alike', () => {
    expect(routeFromPath('/admin/memory').slug).toBe('memory');
    expect(routeFromPath('/admin/avatar').slug).toBe('look');
    expect(routeFromPath('/gallery').slug).toBe('media');
    expect(routeFromPath('/').slug).toBe('');
  });

  it('gives every page a distinct slug and a hue', () => {
    expect(new Set(ROUTES.map((r) => r.slug)).size).toBe(ROUTES.length);
    for (const route of ROUTES) expect(route.hue).toBeGreaterThanOrEqual(0);
  });
});
