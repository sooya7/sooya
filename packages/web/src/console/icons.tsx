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
  // chrome
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

/** Route slug → icon; the landing page uses the sun. */
export function routeIcon(slug: string): string {
  return slug === '' ? 'now' : slug;
}
