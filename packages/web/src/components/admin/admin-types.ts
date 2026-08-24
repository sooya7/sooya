export type Tab =
  | 'overview'
  | 'persona'
  | 'avatar'
  | 'life'
  | 'models'
  | 'mcp'
  | 'content'
  | 'storage'
  | 'operations'
  | 'qq';

export type IconName = 'overview' | 'persona' | 'models' | 'mcp' | 'content' | 'operations' | 'message' | 'cpu' | 'storage' | 'backup' | 'lock';
export const NAV_GROUPS = ['运行状态', '助手与表达', '内容与系统'] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export const TABS: ReadonlyArray<{ id: Tab; label: string; description: string; icon: IconName; group: NavGroup }> = [
  { group: '运行状态', id: 'overview', label: '概览', description: '运行状态与资源', icon: 'overview' },
  { group: '助手与表达', id: 'persona', label: '助手配置', description: '人设与表达方式', icon: 'persona' },
  { group: '内容与系统', id: 'models', label: '模型配置', description: '接口与能力模型', icon: 'models' },
  { group: '助手与表达', id: 'avatar', label: '双方头像', description: '助手与用户头像', icon: 'persona' },
  { group: '助手与表达', id: 'life', label: '她的生活', description: '此刻在做什么与主动开口', icon: 'message' },
  { group: '内容与系统', id: 'content', label: '内容管理', description: '记忆、媒体和表情', icon: 'content' },
  { group: '内容与系统', id: 'mcp', label: 'MCP 服务', description: '连接、工具与策略观测', icon: 'mcp' },
  { group: '内容与系统', id: 'storage', label: '存储治理', description: '清理与空间回收', icon: 'storage' },
  { group: '内容与系统', id: 'operations', label: '运维与备份', description: '任务、错误和备份', icon: 'operations' },
  { group: '运行状态', id: 'qq', label: 'QQ 通道', description: '官方 Bot 通道与投递状态', icon: 'message' }
];

export const PAGE_COPY: Record<Tab, { title: string; description: string }> = {
  mcp: { title: 'MCP 服务', description: '观察外部 MCP 连接和安全工具元数据。' },
  overview: { title: '系统概览', description: '查看 SOOYA 当前运行状态和资源使用情况。' },
  persona: { title: '助手配置', description: '调整助手身份、语气和说话方式。' },
  models: { title: '模型配置', description: '管理每项能力对应的接口与模型。' },
  avatar: { title: '双方头像', description: '上传助手与用户头像，聊天页面即时生效。' },
  life: { title: '她的生活', description: '她此刻在做什么、今天做过什么，以及她为什么还没主动开口。' },
  content: { title: '内容管理', description: '管理长期记忆、表情包、媒体和聊天记录。' },
  storage: { title: '存储治理', description: '预览并执行媒体清理，回收磁盘空间。' },
  operations: { title: '运维与备份', description: '检查错误与后台任务，并管理数据备份。' },
  qq: { title: 'QQ 通道', description: 'QQ 官方 Bot 是唯一消息通道与出口；只显示状态摘要，Secret 永不显示。' }
};

export function adminPathForTab(tab: Tab): string {
  return tab === 'content' ? '/admin/content/memory' : `/admin/${tab}`;
}

export function tabFromAdminPath(pathname: string, fallback: Tab = 'overview'): Tab {
  const normalized = pathname.replace(/\/+$/u, '') || '/admin';
  if (normalized === '/admin/features') return 'avatar';
  const segment = normalized.split('/')[2] as Tab | undefined;
  return segment && TABS.some((item) => item.id === segment) ? segment : fallback;
}

export function isContentSubroute(pathname: string): boolean {
  return /^\/admin\/content\/(memory|stickers|media|chat)\/?$/u.test(pathname.replace(/\/+$/u, ''));
}
