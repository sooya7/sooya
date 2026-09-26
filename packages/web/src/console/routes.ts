export type Register = 'her' | 'system';

export interface ConsoleRoute {
  /** Path segment after /admin; '' is the landing page. */
  slug: string;
  label: string;
  register: Register;
  /** Hue (degrees) of the page's accent: a soft wash for its emblem and section marks. */
  hue: number;
}

/** Order here is the order in the navigation. */
export const ROUTES: ConsoleRoute[] = [
  { slug: '', label: '此刻', register: 'her', hue: 168 },
  { slug: 'persona', label: '人设与声音', register: 'her', hue: 350 },
  { slug: 'look', label: '形象', register: 'her', hue: 18 },
  { slug: 'life', label: '生活', register: 'her', hue: 38 },
  { slug: 'memory', label: '记忆', register: 'her', hue: 205 },
  { slug: 'media', label: '相册与表情', register: 'her', hue: 265 },
  { slug: 'chats', label: '聊天记录', register: 'her', hue: 185 },
  { slug: 'models', label: '模型', register: 'system', hue: 225 },
  { slug: 'qq', label: 'QQ 通道', register: 'system', hue: 200 },
  { slug: 'tools', label: '工具', register: 'system', hue: 140 },
  { slug: 'video', label: '视频生成', register: 'system', hue: 10 },
  { slug: 'storage', label: '存储与备份', register: 'system', hue: 45 },
  { slug: 'ops', label: '运行状况', register: 'system', hue: 160 }
];

export const CONSOLE_BASE = '/admin';

export function consolePath(slug: string): string {
  return slug ? `${CONSOLE_BASE}/${slug}` : CONSOLE_BASE;
}

/** Sub-pages of the retired admin panel, so bookmarks and old links land on the right new page. */
const LEGACY_SLUGS: Record<string, string> = {
  overview: '',
  avatar: 'look',
  voice: 'persona',
  features: 'persona',
  content: 'media',
  mcp: 'tools',
  operations: 'ops'
};

/**
 * Where a path should really live. Returns null when it already is canonical.
 * Covers /console (the preview address), /gallery (the old standalone gallery)
 * the old /admin sub-pages, including deeper paths such as /admin/life/console, and any other path.
 */
export function canonicalPath(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/gallery') return consolePath('media');
  const match = /^\/(admin|console)(?:\/([^/]+))?(\/.*)?$/.exec(path);
  // The web app is only the console now: the root and any retired page (/moments, chat) open it.
  if (!match) return CONSOLE_BASE;
  const [, base, segment = '', rest] = match;
  const slug = segment in LEGACY_SLUGS ? LEGACY_SLUGS[segment]! : ROUTES.some((r) => r.slug === segment) ? segment : '';
  const target = consolePath(slug);
  return base !== 'admin' || rest || slug !== segment || pathname !== target ? target : null;
}

export function routeFromPath(pathname: string): ConsoleRoute {
  const target = canonicalPath(pathname) ?? pathname.replace(/\/+$/, '');
  const slug = target.slice(CONSOLE_BASE.length).replace(/^\//, '').split('/')[0] ?? '';
  return ROUTES.find((route) => route.slug === slug) ?? ROUTES[0]!;
}
