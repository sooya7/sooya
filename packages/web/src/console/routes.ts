export type Register = 'her' | 'system';

export interface ConsoleRoute {
  /** Path segment after /console; '' is the landing page. */
  slug: string;
  label: string;
  register: Register;
}

/** Order here is the order in the navigation. */
export const ROUTES: ConsoleRoute[] = [
  { slug: '', label: '此刻', register: 'her' },
  { slug: 'persona', label: '人设与声音', register: 'her' },
  { slug: 'look', label: '形象', register: 'her' },
  { slug: 'life', label: '生活', register: 'her' },
  { slug: 'memory', label: '记忆', register: 'her' },
  { slug: 'media', label: '相册与表情', register: 'her' },
  { slug: 'chats', label: '聊天记录', register: 'her' },
  { slug: 'models', label: '模型', register: 'system' },
  { slug: 'qq', label: 'QQ 通道', register: 'system' },
  { slug: 'tools', label: '工具', register: 'system' },
  { slug: 'video', label: '视频生成', register: 'system' },
  { slug: 'storage', label: '存储与备份', register: 'system' },
  { slug: 'ops', label: '运行状况', register: 'system' }
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
