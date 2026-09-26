export type Register = 'her' | 'system';

export interface ConsoleRoute {
  /** Path segment after /console; '' is the landing page. */
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

export const CONSOLE_BASE = '/console';

export function consolePath(slug: string): string {
  return slug ? `${CONSOLE_BASE}/${slug}` : CONSOLE_BASE;
}

export function routeFromPath(pathname: string): ConsoleRoute {
  const rest = pathname.replace(/\/+$/, '').slice(CONSOLE_BASE.length).replace(/^\//, '');
  const slug = rest.split('/')[0] ?? '';
  return ROUTES.find((route) => route.slug === slug) ?? ROUTES[0]!;
}
