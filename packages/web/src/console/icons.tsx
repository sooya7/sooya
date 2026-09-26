import type { SVGProps } from 'react';

/** Line icons drawn for the console: 24px grid, 1.6 stroke, round caps. */
const PATHS: Record<string, string> = {
  // her
  now: 'M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z',
  persona: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5M16.8 3.8c1 .7 1.7 1.8 1.9 3.1',
  look: 'M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-9ZM4.5 16l4.2-4.2a1.5 1.5 0 0 1 2.1 0L15 16M13.5 14.5l1.7-1.7a1.5 1.5 0 0 1 2.1 0l2.2 2.2M15.5 9.2a.3.3 0 1 0 0-.1',
  life: 'M3.5 19.5h17M6 19.5V11l6-5 6 5v8.5M10 19.5v-4.5h4v4.5',
  memory: 'M7 4.5h8.5L19 8v10.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1ZM15 4.5V8.5h4M9 12h6M9 15.5h4',
  media: 'M3.5 8.5a2 2 0 0 1 2-2h2l1.5-2h6l1.5 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9ZM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  chats: 'M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H11l-4.5 3.5V16h0a2 2 0 0 1-2-2V6.5ZM8.5 9.5h7M8.5 12.5h4.5',
  // system
  models: 'M8 4.5h8A3.5 3.5 0 0 1 19.5 8v8a3.5 3.5 0 0 1-3.5 3.5H8A3.5 3.5 0 0 1 4.5 16V8A3.5 3.5 0 0 1 8 4.5ZM9.5 9.5h5v5h-5v-5ZM9.5 2.5v2M14.5 2.5v2M9.5 19.5v2M14.5 19.5v2M2.5 9.5h2M2.5 14.5h2M19.5 9.5h2M19.5 14.5h2',
  qq: 'M4 12a8 8 0 1 1 3.3 6.5L4 19.5l1-3.2A7.9 7.9 0 0 1 4 12ZM9 11h.01M12 11h.01M15 11h.01',
  tools: 'M14.5 5.5a4 4 0 0 0-5.3 5L4.5 15.2a1.8 1.8 0 0 0 2.6 2.6l4.7-4.7a4 4 0 0 0 5-5.3l-2.4 2.4-2.3-.4-.4-2.3 2.4-2.4Z',
  video: 'M4.5 7.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-9ZM16.5 10.5l3.5-2.2v7.4l-3.5-2.2',
  storage: 'M5 6.5c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5-3.1 2.5-7 2.5-7-1.1-7-2.5ZM5 6.5v5.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6.5M5 12v5.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V12',
  ops: 'M3.5 12h3.5l2.2-5.5 4.3 11 2.3-5.5h4.7',
  // section glyphs
  mic: 'M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3ZM6 11a6 6 0 0 0 12 0M12 17v3.5M9 20.5h6',
  smile: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM8.5 14c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2M9 9.5h.01M15 9.5h.01',
  bookmark: 'M7 4.5h10a1 1 0 0 1 1 1v14.5l-6-4-6 4V5.5a1 1 0 0 1 1-1Z',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.3 15.3l4.7 4.7',
  pin: 'M12 20.5s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.4 6.5 11 6.5 11ZM12 11.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  calendar: 'M5.5 6.5h13a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM4.5 10.5h15M8.5 4v4M15.5 4v4M8 14h2M12 14h2M8 17h2',
  heart: 'M12 19.5s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.5c0 5.6-7.5 10-7.5 10Z',
  pulse: 'M3.5 12.5h3l2-4 3 8 2.5-6 1.5 2h5',
  bell: 'M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14l1.5-2ZM10 20.5h4',
  list: 'M9 7h10.5M9 12h10.5M9 17h10.5M4.5 7h.01M4.5 12h.01M4.5 17h.01',
  chart: 'M4.5 19.5h15M7 16.5v-5M11 16.5V7.5M15 16.5v-7M19 16.5V10',
  alert: 'M12 4 3.5 19h17L12 4ZM12 10v4.5M12 17h.01',
  check: 'M5 7h9M5 12h6M5 17h6M14.5 15l2 2 3.5-4',
  sliders: 'M4.5 7h9M17.5 7h2M4.5 12h3M11.5 12h8M4.5 17h11M19.5 17h0M15.5 5v4M9.5 10v4M17.5 15v4',
  archive: 'M4 5.5h16v4H4v-4ZM5.5 9.5v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9M10 13h4',
  download: 'M12 4.5v10M7.5 10.5l4.5 4.5 4.5-4.5M5 19.5h14',
  upload: 'M12 15.5v-10M7.5 9.5 12 5l4.5 4.5M5 19.5h14',
  link: 'M10 14a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1-1',
  send: 'M4.5 11.5 19.5 4.5l-5 15-3-6.5-7-1.5ZM11.5 13l8-8.5',
  shield: 'M12 3.5 5 6.5v5c0 4.3 3 7.6 7 9 4-1.4 7-4.7 7-9v-5l-7-3ZM9.5 12l2 2 3.5-3.5',
  trash: 'M5 7h14M10 4.5h4M7 7l.8 12a1 1 0 0 0 1 1h6.4a1 1 0 0 0 1-1L17 7M10.5 11v5M13.5 11v5',
  key: 'M14.5 13.5a5 5 0 1 0-4.8-3.5L4.5 15.2V19.5h4v-2h2v-2h2l1.2-1.2c.3 0 .5-.1.8-.3ZM16 8h.01',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5',
  sparkle: 'M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8L12 3.5ZM18.5 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z',
  // chrome
  chevron: 'M9 5.5 15.5 12 9 18.5',
  info: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.6-2.4 2-2.4 3.4M12 16.6h.01',
  menu: 'M4.5 7h15M4.5 12h15M4.5 17h15',
  exit: 'M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14M10 16l4-4-4-4M14 12H4.5',
  back: 'M10 6.5 4.5 12l5.5 5.5M5 12h14.5',
  // weather
  clear: 'M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9ZM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  cloudy: 'M7 18.5a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 10.6 1.4A3.3 3.3 0 0 1 17 18.5H7Z',
  rain: 'M7 15a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 10.6 1.4A3.3 3.3 0 0 1 17 15H7ZM8.5 18l-1 2.5M12.5 18l-1 2.5M16.5 18l-1 2.5',
  snow: 'M7 14.5a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 10.6 1.4A3.3 3.3 0 0 1 17 14.5H7ZM8.5 18.5h.01M12 20h.01M15.5 18.5h.01',
  storm: 'M7 14.5a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 10.6 1.4A3.3 3.3 0 0 1 17 14.5H7ZM12.5 14.5l-2 3.5h3l-2 3.5',
  fog: 'M4.5 9h15M3.5 12.5h13M6.5 16h14M8 19.5h8',
  wind: 'M3.5 9.5h11a2.5 2.5 0 1 0-2.5-2.5M3.5 13.5h15a2.5 2.5 0 1 1-2.5 2.5M3.5 17h7'
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, ...props }: { name: string; size?: number } & SVGProps<SVGSVGElement>) {
  const d = PATHS[name] ?? PATHS.now!;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      <path d={d} />
    </svg>
  );
}

/**
 * A glyph for a section, read off its title. Specific words come first so 「清空全部记忆」 gets
 * the bin rather than the bookmark; anything unmatched falls back to the page's own icon.
 */
const SECTION_RULES: Array<[RegExp, string]> = [
  [/清空|删除|回收站|移除/, 'trash'],
  [/错误|出错|失败/, 'alert'],
  [/备份|恢复|导出/, 'archive'],
  [/上传|添加|加一个/, 'upload'],
  [/下载/, 'download'],
  [/测试|试一句|试听|发送/, 'send'],
  [/声音|语音|念|心情怎么说/, 'mic'],
  [/表情/, 'smile'],
  [/视频/, 'video'],
  [/头像|长相|参考图/, 'user'],
  [/相册|照片|图片|媒体|生图/, 'look'],
  [/召回|想起|搜索|找一|检索/, 'search'],
  [/记忆|记得|记住/, 'bookmark'],
  [/聊天|对话|消息/, 'chats'],
  [/天气|预报/, 'cloudy'],
  [/城市|地点|地方|在哪|出行|位置/, 'pin'],
  [/计划|时间线|今天/, 'calendar'],
  [/惦记|关系/, 'heart'],
  [/身体|情绪|数值/, 'pulse'],
  [/主动/, 'bell'],
  [/统计|指标|分布/, 'chart'],
  [/任务/, 'check'],
  [/记录|日志|事件|活动/, 'list'],
  [/权限|安全|来源/, 'shield'],
  [/密钥|令牌|凭据/, 'key'],
  [/连接|通道|状态|推送/, 'link'],
  [/服务|工具|MCP/i, 'tools'],
  [/模型|能力|决策|搜索/, 'models'],
  [/占用|存储|数据/, 'storage'],
  [/规则|策略|设置|参数|系统/, 'sliders'],
  [/她是谁|设定|说话|人设/, 'persona'],
  [/她现在|此刻/, 'now']
];

export function sectionIcon(title: string, fallback: string): string {
  return SECTION_RULES.find(([pattern]) => pattern.test(title))?.[1] ?? fallback;
}

/** Route slug → icon; the landing page uses the sun. */
export function routeIcon(slug: string): string {
  return slug === '' ? 'now' : slug;
}
