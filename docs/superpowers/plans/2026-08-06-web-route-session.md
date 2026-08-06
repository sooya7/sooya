# Web Route and Chat Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用不新增运行时依赖的轻量 SPA 壳层替代完整文档导航，使聊天、图库、后台可用浏览器前进/后退切换，并在首次进入聊天后保持同一个聊天会话、SSE 与滚动语义。

**Architecture:** `navigation.ts` 统一 route kind、History API 与导航通知，`AppLink` 只接管安全的同源普通点击；`AppShell` 只挂载当前页面 DOM，但在聊天首次访问后保留 `ChatSessionHost`。`ChatSessionHost` 常驻 `useChat`，`ChatView` 卸载时把滚动状态写回 ref，重挂载时按“贴底/读历史”两种语义恢复。

**Tech Stack:** React 19、TypeScript 5.7、History API、`@tanstack/react-virtual`、Vitest 4 + jsdom、Playwright 1.62

---

## 实施顺序与边界

本计划是三片交付中的第 1 片。完成并提交本计划后，再执行：

1. `2026-08-06-web-stream-media-stability.md`
2. `2026-08-06-web-warm-theme.md`

本片不修改 SSE 协议、流式草稿数据结构、媒体缓存策略或颜色主题。

## 文件职责映射

- 新增 `packages/web/src/lib/navigation.ts`：route kind、History 写入、自定义导航事件、`popstate` 订阅。
- 新增 `packages/web/src/lib/navigation.test.tsx`：路由分类、链接接管边界、push/replace/popstate。
- 新增 `packages/web/src/components/AppLink.tsx`：显式内部链接组件。
- 新增 `packages/web/src/lib/chatViewState.ts`：滚动状态捕获与有界恢复的纯函数。
- 新增 `packages/web/src/lib/chatViewState.test.ts`：贴底、历史位置、上下界。
- 新增 `packages/web/src/AppShell.tsx`：三类顶层视图与惰性聊天宿主。
- 新增 `packages/web/src/AppShell.test.tsx`：聊天宿主常驻、后台/图库离开卸载、前进/后退。
- 修改 `packages/web/src/App.tsx`：拆分 `ChatSessionHost` 与 `ChatView`，保存/恢复滚动。
- 修改 `packages/web/src/main.tsx`：只挂载一次 `AppShell`。
- 修改 `packages/web/src/components/AdminPanel.tsx`：统一 History 写入并保留未保存确认。
- 修改 `packages/web/src/components/GalleryPage.tsx`：顶层内部链接改用 `AppLink`。
- 修改 `packages/web/src/components/adminConsole.test.ts`：静态路由契约指向新壳层。
- 新增 `e2e/navigation.e2e.ts`：真实 bootstrap/SSE 计数与滚动恢复。

## Task 0: 固定基线

- [ ] 在仓库根目录确认分支和工作区：

```powershell
git status --short --branch
```

预期：位于 `codex/web-performance-ui-refactor`，除计划文档外没有未解释的改动。

- [ ] 运行当前前端基线：

```powershell
npm.cmd test -w @sooya/web
npm.cmd run typecheck -w @sooya/web
```

预期：现有 30 个测试文件、401 个测试通过，类型检查退出码为 0。若基线失败，先停止并记录失败，不把既有失败混入本片。

## Task 1: 先测试轻量导航原语

**Files:**

- Create: `packages/web/src/lib/navigation.test.tsx`
- Create: `packages/web/src/lib/navigation.ts`
- Create: `packages/web/src/components/AppLink.tsx`

- [ ] 写失败测试 `packages/web/src/lib/navigation.test.tsx`：

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLink } from '../components/AppLink.js';
import { classifyRoute, navigate, useAppRoute } from './navigation.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(node); });
  return container;
}

function RouteProbe() {
  const route = useAppRoute();
  return <output data-testid="route">{route}</output>;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('classifyRoute', () => {
  it.each([
    ['/', 'chat'],
    ['/unknown', 'chat'],
    ['/gallery', 'gallery'],
    ['/gallery/', 'gallery'],
    ['/admin', 'admin'],
    ['/admin/features', 'admin']
  ] as const)('%s -> %s', (pathname, expected) => {
    expect(classifyRoute(pathname)).toBe(expected);
  });
});

describe('AppLink', () => {
  it('普通同源点击使用 pushState 并通知路由订阅者', async () => {
    const host = await render(<><AppLink href="/admin/features">管理</AppLink><RouteProbe /></>);
    const push = vi.spyOn(window.history, 'pushState');

    await act(async () => {
      host.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });

    expect(push).toHaveBeenCalledWith(null, '', '/admin/features');
    expect(window.location.pathname).toBe('/admin/features');
    expect(host.querySelector('[data-testid="route"]')?.textContent).toBe('admin');
  });

  it.each([
    [{ href: 'https://example.com/x' }, { button: 0 }],
    [{ href: '/gallery', target: '_blank' }, { button: 0 }],
    [{ href: '/gallery', download: true }, { button: 0 }],
    [{ href: '/gallery' }, { button: 0, ctrlKey: true }],
    [{ href: '/gallery' }, { button: 1 }]
  ] as const)('不接管浏览器原生点击 %#', async (props, init) => {
    const host = await render(<AppLink {...props}>目标</AppLink>);
    const push = vi.spyOn(window.history, 'pushState');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
    host.querySelector('a')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('navigate 与浏览器历史', () => {
  it('支持 replaceState 和 popstate', async () => {
    const host = await render(<RouteProbe />);
    await act(async () => { navigate('/gallery', { replace: true }); });
    expect(host.textContent).toBe('gallery');

    window.history.pushState(null, '', '/admin/models');
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(host.textContent).toBe('admin');
  });
});
```

- [ ] 运行测试，确认先红：

```powershell
npm.cmd test -w @sooya/web -- src/lib/navigation.test.tsx
```

预期：测试因 `navigation.js` 或 `AppLink.js` 无法解析而失败；不能在没有看到该失败的情况下直接写实现。

- [ ] 新增 `packages/web/src/lib/navigation.ts`：

```ts
import { useEffect, useState } from 'react';

export type AppRouteKind = 'chat' | 'gallery' | 'admin';
export const APP_NAVIGATION_EVENT = 'sooya:navigation';

export interface NavigateOptions {
  replace?: boolean;
  state?: unknown;
}

export function classifyRoute(pathname: string): AppRouteKind {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (normalized === '/gallery') return 'gallery';
  if (normalized === '/admin' || normalized.startsWith('/admin/')) return 'admin';
  return 'chat';
}

export function notifyNavigation(): void {
  window.dispatchEvent(new Event(APP_NAVIGATION_EVENT));
}

export function navigate(href: string, options: NavigateOptions = {}): void {
  const target = new URL(href, window.location.href);
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
```

- [ ] 新增 `packages/web/src/components/AppLink.tsx`：

```tsx
import type { ComponentPropsWithoutRef, MouseEvent } from 'react';
import { navigate } from '../lib/navigation.js';

export type AppLinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'href'> & {
  href: string;
  replace?: boolean;
};

export function AppLink({ href, replace = false, onClick, target, download, ...rest }: AppLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (download !== undefined && download !== false) return;
    if (target && target !== '_self') return;

    const destination = new URL(href, window.location.href);
    if (destination.origin !== window.location.origin) return;

    event.preventDefault();
    navigate(destination.href, { replace });
  };

  return <a {...rest} href={href} target={target} download={download} onClick={handleClick} />;
}
```

- [ ] 再运行定向测试：

```powershell
npm.cmd test -w @sooya/web -- src/lib/navigation.test.tsx
```

预期：该测试文件全部通过；React 不报告未包裹 `act()` 的更新。

- [ ] 提交导航原语：

```powershell
git add packages/web/src/lib/navigation.ts packages/web/src/lib/navigation.test.tsx packages/web/src/components/AppLink.tsx
git commit -m "feat(web): add lightweight navigation primitives"
```

## Task 2: 先定义可测试的聊天滚动语义，再拆会话宿主

**Files:**

- Create: `packages/web/src/lib/chatViewState.test.ts`
- Create: `packages/web/src/lib/chatViewState.ts`
- Modify: `packages/web/src/App.tsx`

- [ ] 写失败测试 `packages/web/src/lib/chatViewState.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { captureChatViewState, restoredScrollTop } from './chatViewState.js';

function viewport(scrollTop: number, scrollHeight: number, clientHeight: number): HTMLElement {
  return { scrollTop, scrollHeight, clientHeight } as HTMLElement;
}

describe('聊天视图滚动状态', () => {
  it('卸载时保存 scrollTop 与贴底语义', () => {
    expect(captureChatViewState(viewport(420, 1600, 600), false)).toEqual({ scrollTop: 420, stickToBottom: false });
    expect(captureChatViewState(null, true)).toEqual({ scrollTop: 0, stickToBottom: true });
  });

  it('贴底状态恢复到当前最大 scrollTop', () => {
    expect(restoredScrollTop(viewport(0, 1800, 600), { scrollTop: 120, stickToBottom: true })).toBe(1200);
  });

  it('读历史状态恢复原位置，并限制在当前有效范围', () => {
    const el = viewport(0, 1000, 600);
    expect(restoredScrollTop(el, { scrollTop: 240, stickToBottom: false })).toBe(240);
    expect(restoredScrollTop(el, { scrollTop: 900, stickToBottom: false })).toBe(400);
    expect(restoredScrollTop(el, { scrollTop: -20, stickToBottom: false })).toBe(0);
  });
});
```

- [ ] 运行测试，确认因模块不存在而失败：

```powershell
npm.cmd test -w @sooya/web -- src/lib/chatViewState.test.ts
```

预期：`Cannot find module './chatViewState.js'`。

- [ ] 新增 `packages/web/src/lib/chatViewState.ts`：

```ts
export interface ChatViewState {
  scrollTop: number;
  stickToBottom: boolean;
}

export const INITIAL_CHAT_VIEW_STATE: ChatViewState = Object.freeze({
  scrollTop: 0,
  stickToBottom: true
});

export function captureChatViewState(element: HTMLElement | null, stickToBottom: boolean): ChatViewState {
  return {
    scrollTop: Math.max(0, element?.scrollTop ?? 0),
    stickToBottom
  };
}

export function restoredScrollTop(element: HTMLElement, state: ChatViewState): number {
  const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
  if (state.stickToBottom) return maximum;
  return Math.min(maximum, Math.max(0, state.scrollTop));
}
```

- [ ] 运行测试，确认纯函数通过：

```powershell
npm.cmd test -w @sooya/web -- src/lib/chatViewState.test.ts
```

预期：3 个测试通过。

- [ ] 在 `packages/web/src/App.tsx` 的 import 区加入：

```ts
import {
  captureChatViewState,
  INITIAL_CHAT_VIEW_STATE,
  restoredScrollTop,
  type ChatViewState
} from './lib/chatViewState.js';
```

- [ ] 删除 `AdminPanel` import 与 pathname 分支，把原 `App`/`ChatApp` 入口替换为下列宿主和视图签名：

```tsx
export type ChatController = ReturnType<typeof useChat>;
export type ChatViewStateRef = { current: ChatViewState };

export default function ChatSessionHost({ active = true }: { active?: boolean }) {
  const chat = useChat();
  const viewStateRef = useRef<ChatViewState>({ ...INITIAL_CHAT_VIEW_STATE });
  return active ? <ChatView chat={chat} viewStateRef={viewStateRef} /> : null;
}

export function ChatView({ chat, viewStateRef }: { chat: ChatController; viewStateRef: ChatViewStateRef }) {
```

`ChatView` 函数体从原 `ChatApp` 的第一条头像 hook 开始；不得在 `ChatView` 内再次调用 `useChat()`。

- [ ] 在 scroller refs 后，用宿主状态初始化贴底状态：

```ts
  const initialViewState = useRef(viewStateRef.current).current;
  const [stickToBottom, setStickToBottom] = useState(initialViewState.stickToBottom);
```

同时把原来的 `const stickToBottomRef = useRef(true)` 改为：

```ts
  const stickToBottomRef = useRef(initialViewState.stickToBottom);
```

- [ ] 在现有滚动副作用附近新增卸载捕获：

```ts
  useEffect(() => () => {
    viewStateRef.current = captureChatViewState(scrollerRef.current, stickToBottomRef.current);
  }, [viewStateRef]);
```

- [ ] 把现有 `useLayoutEffect` 的首屏分支替换为两种恢复路径：

```ts
    if (!didInitialScrollRef.current && count > 0) {
      didInitialScrollRef.current = true;
      prevLastIdRef.current = lastId;
      if (initialViewState.stickToBottom) {
        virtualizer.scrollToIndex(count - 1, { align: 'end' });
        window.requestAnimationFrame(() => {
          if (scrollerRef.current) virtualizer.scrollToIndex(count - 1, { align: 'end' });
        });
      } else {
        const restore = () => {
          const current = scrollerRef.current;
          if (current) current.scrollTop = restoredScrollTop(current, initialViewState);
        };
        restore();
        window.requestAnimationFrame(restore);
      }
      return;
    }
```

- [ ] 运行滚动单测、完整 useChat 测试与类型检查：

```powershell
npm.cmd test -w @sooya/web -- src/lib/chatViewState.test.ts src/lib/useChat.test.tsx
npm.cmd run typecheck -w @sooya/web
```

预期：定向测试全部通过，类型检查退出码为 0；`App.tsx` 中只剩宿主调用一次 `useChat()`。

- [ ] 提交会话/视图拆分：

```powershell
git add packages/web/src/App.tsx packages/web/src/lib/chatViewState.ts packages/web/src/lib/chatViewState.test.ts
git commit -m "refactor(web): split chat session from view state"
```

## Task 3: 用 AppShell 保持聊天宿主并按路由卸载页面

**Files:**

- Create: `packages/web/src/AppShell.test.tsx`
- Create: `packages/web/src/AppShell.tsx`
- Modify: `packages/web/src/main.tsx`
- Modify: `packages/web/src/components/adminConsole.test.ts`

- [ ] 写失败测试 `packages/web/src/AppShell.test.tsx`：

```tsx
// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppShell from './AppShell.js';
import { navigate } from './lib/navigation.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const life = vi.hoisted(() => ({
  chatMounts: 0,
  chatUnmounts: 0,
  galleryMounts: 0,
  galleryUnmounts: 0,
  adminMounts: 0,
  adminUnmounts: 0
}));

vi.mock('./App.js', () => ({
  default: function ChatHost({ active }: { active?: boolean }) {
    useEffect(() => { life.chatMounts += 1; return () => { life.chatUnmounts += 1; }; }, []);
    return active ? <main data-testid="chat-view">chat</main> : null;
  }
}));

vi.mock('./components/GalleryPage.js', () => ({
  default: function Gallery() {
    useEffect(() => { life.galleryMounts += 1; return () => { life.galleryUnmounts += 1; }; }, []);
    return <main data-testid="gallery-view">gallery</main>;
  }
}));

vi.mock('./components/AdminPanel.js', () => ({
  default: function Admin() {
    useEffect(() => { life.adminMounts += 1; return () => { life.adminUnmounts += 1; }; }, []);
    return <main data-testid="admin-view">admin</main>;
  }
}));

vi.mock('./components/ImageViewerHost.js', () => ({ ImageViewerHost: () => <aside data-testid="viewer-host" /> }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(pathname: string): Promise<HTMLDivElement> {
  window.history.replaceState(null, '', pathname);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<AppShell />); });
  return container;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  container?.remove();
  root = null;
  container = null;
  for (const key of Object.keys(life) as Array<keyof typeof life>) life[key] = 0;
  window.history.replaceState(null, '', '/');
});

describe('AppShell', () => {
  it('初始后台不建聊天；首次聊天后宿主跨页面保持挂载', async () => {
    const host = await mount('/admin/features');
    expect(host.querySelector('[data-testid="admin-view"]')).not.toBeNull();
    expect(life.chatMounts).toBe(0);

    await act(async () => { navigate('/'); });
    expect(life.chatMounts).toBe(1);
    expect(host.querySelector('[data-testid="chat-view"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="viewer-host"]')).not.toBeNull();
    expect(life.adminUnmounts).toBe(1);

    await act(async () => { navigate('/gallery'); });
    expect(life.chatMounts).toBe(1);
    expect(life.chatUnmounts).toBe(0);
    expect(host.querySelector('[data-testid="chat-view"]')).toBeNull();
    expect(host.querySelector('[data-testid="gallery-view"]')).not.toBeNull();

    await act(async () => { navigate('/'); });
    expect(life.chatMounts).toBe(1);
    expect(life.galleryUnmounts).toBe(1);
    expect(host.querySelector('[data-testid="chat-view"]')).not.toBeNull();
  });

  it('popstate 重新分类当前地址', async () => {
    const host = await mount('/');
    window.history.pushState(null, '', '/admin/models');
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(host.querySelector('[data-testid="admin-view"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="chat-view"]')).toBeNull();
  });
});
```

- [ ] 运行测试，确认因 `AppShell.js` 不存在而失败：

```powershell
npm.cmd test -w @sooya/web -- src/AppShell.test.tsx
```

- [ ] 新增 `packages/web/src/AppShell.tsx`：

```tsx
import { useEffect, useState } from 'react';
import ChatSessionHost from './App.js';
import AdminPanel from './components/AdminPanel.js';
import GalleryPage from './components/GalleryPage.js';
import { ImageViewerHost } from './components/ImageViewerHost.js';
import { useAppRoute } from './lib/navigation.js';

export default function AppShell() {
  const route = useAppRoute();
  const [chatStarted, setChatStarted] = useState(route === 'chat');
  const shouldMountChat = chatStarted || route === 'chat';

  useEffect(() => {
    if (route === 'chat') setChatStarted(true);
  }, [route]);

  return (
    <>
      {shouldMountChat && <ChatSessionHost active={route === 'chat'} />}
      {route === 'chat' && <ImageViewerHost />}
      {route === 'gallery' && <GalleryPage />}
      {route === 'admin' && <AdminPanel />}
    </>
  );
}
```

- [ ] 把 `packages/web/src/main.tsx` 的页面级 imports 改为：

```ts
import AppShell from './AppShell.js';
```

删除 `App`、`GalleryPage`、`AdminPanel`、`ImageViewerHost` imports、`galleryRoute` 与 `adminRoute` 常量，并把 React 树替换为：

```tsx
createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>
);
```

- [ ] 更新 `packages/web/src/components/adminConsole.test.ts` 的路由静态契约：

```ts
const SHELL = read('../AppShell.tsx');
const NAVIGATION = read('../lib/navigation.ts');
```

将旧的 `MAIN` 两条断言替换为：

```ts
    expect(NAVIGATION).toContain("normalized === '/admin'");
    expect(NAVIGATION).toContain("normalized.startsWith('/admin/')");
    expect(SHELL).toContain("route === 'admin'");
    expect(SHELL).not.toContain('FeatureAdminPage');
```

- [ ] 运行壳层、后台静态契约和类型检查：

```powershell
npm.cmd test -w @sooya/web -- src/AppShell.test.tsx src/components/adminConsole.test.ts
npm.cmd run typecheck -w @sooya/web
```

预期：测试全部通过；初始 `/admin/*` 与 `/gallery` 不挂载聊天宿主；类型检查退出码为 0。

- [ ] 提交共享壳层：

```powershell
git add packages/web/src/AppShell.tsx packages/web/src/AppShell.test.tsx packages/web/src/main.tsx packages/web/src/components/adminConsole.test.ts
git commit -m "feat(web): keep chat session across internal routes"
```

## Task 4: 迁移显式内部链接并保护后台未保存状态

**Files:**

- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/components/AdminPanel.tsx`
- Modify: `packages/web/src/components/GalleryPage.tsx`
- Modify: `packages/web/src/components/adminConsole.test.ts`
- Test: `packages/web/src/lib/navigation.test.tsx`

- [ ] 先在 `packages/web/src/components/adminConsole.test.ts` 增加失败契约：

```ts
  it('routes top-level links without losing the unsaved-change guard', () => {
    expect(PANEL).toContain("import { AppLink } from './AppLink.js'");
    expect(PANEL).toContain('confirmRouteLeave');
    expect(PANEL).toContain("navigate(adminPathForTab(tab))");
    expect(PANEL).not.toContain("<a className=\"admin-side-action\" href=\"/\"");
  });
```

- [ ] 运行定向测试并确认失败：

```powershell
npm.cmd test -w @sooya/web -- src/components/adminConsole.test.ts
```

预期：缺少 `AppLink`/`confirmRouteLeave` 契约而失败。

- [ ] `packages/web/src/App.tsx` 导入 `AppLink`，并把顶栏管理入口从 `<a>` 改为：

```tsx
<AppLink className="topbar-admin-entry" href="/admin/features" aria-label="进入功能管理中心" data-testid="admin-entry">
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-testid="admin-entry-icon" data-icon-style="six-tooth">
    <circle cx="12" cy="12" r="3.35" />
    <path d="M12 2.8v2.1" />
    <path d="m19.97 7.4-1.82 1.05" />
    <path d="m19.97 16.6-1.82-1.05" />
    <path d="M12 21.2v-2.1" />
    <path d="m4.03 16.6 1.82 1.05" />
    <path d="m19.97 7.4 1.82 1.05" />
  </svg>
</AppLink>
```

- [ ] `packages/web/src/components/GalleryPage.tsx` 导入 `AppLink`，替换两处顶层链接：

```tsx
<AppLink href="/">返回聊天</AppLink>
```

```tsx
<AppLink href="/admin/features" className="gallery-back">‹ 返回功能中心</AppLink>
```

- [ ] `packages/web/src/components/AdminPanel.tsx` 增加 imports：

```ts
import { type FormEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { navigate } from '../lib/navigation.js';
import { AppLink } from './AppLink.js';
```

把三处 `window.history.replaceState/pushState` 写入分别改为：

```ts
navigate(canonicalPath, { replace: true });
```

```ts
navigate(adminPathForTab(tab));
```

```ts
navigate(adminPathForTab(next));
```

其中第二段必须位于 `popstate` 的“用户取消离开”分支，确保壳层收到回滚通知。

- [ ] 在 `logout` 后添加顶层离开保护：

```ts
  const confirmRouteLeave = useCallback((event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!dirtyRef.current) return;
    if (!window.confirm('当前修改尚未保存，确定离开吗？')) {
      event.preventDefault();
      return;
    }
    setDirtyState(false);
  }, [setDirtyState]);
```

把桌面和移动端两处返回聊天链接都改为：

```tsx
<AppLink className="admin-side-action" href="/" data-testid="admin-return-chat" onClick={confirmRouteLeave}>返回对话</AppLink>
```

```tsx
<AppLink className="admin-return" href="/" data-testid="admin-return-chat" onClick={confirmRouteLeave}>返回对话</AppLink>
```

- [ ] 运行链接、后台、图库测试和类型检查：

```powershell
npm.cmd test -w @sooya/web -- src/lib/navigation.test.tsx src/components/adminConsole.test.ts src/components/GalleryPage.test.tsx
npm.cmd run typecheck -w @sooya/web
```

预期：所有定向测试通过；普通同源链接由壳层处理，外链/修饰键/新标签/下载仍是原生行为；后台未保存确认仍存在。

- [ ] 提交链接迁移：

```powershell
git add packages/web/src/App.tsx packages/web/src/components/AdminPanel.tsx packages/web/src/components/GalleryPage.tsx packages/web/src/components/adminConsole.test.ts
git commit -m "refactor(web): route explicit internal links in app shell"
```

## Task 5: 真实浏览器验收 bootstrap、SSE、历史栈与滚动恢复

**Files:**

- Create: `e2e/navigation.e2e.ts`

- [ ] 新增 `e2e/navigation.e2e.ts`：

```ts
import { expect, test } from '@playwright/test';

const CHAT_TOKEN = 'e2e-chat-token';
const ADMIN_TOKEN = 'e2e-admin-token';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ chat, admin }) => {
    localStorage.setItem('sooya.token', chat);
    localStorage.setItem('sooya.admin-token', admin);
  }, { chat: CHAT_TOKEN, admin: ADMIN_TOKEN });
});

test('chat session survives admin navigation and browser history', async ({ page }) => {
  let bootstraps = 0;
  let streams = 0;
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/bootstrap') bootstraps += 1;
    if (pathname === '/api/stream') streams += 1;
  });

  await page.goto('/');
  await expect(page.getByTestId('connection-status')).toContainText('在线');
  await page.getByTestId('admin-entry').click();
  await expect(page.getByTestId('admin-dashboard')).toBeVisible();
  await page.getByTestId('admin-return-chat').first().click();
  await expect(page.getByTestId('scroller')).toBeVisible();
  expect(bootstraps).toBe(1);
  expect(streams).toBe(1);

  await page.goBack();
  await expect(page.getByTestId('admin-dashboard')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('scroller')).toBeVisible();
  expect(bootstraps).toBe(1);
  expect(streams).toBe(1);
});

test('returning to chat restores a history-reading scroll position', async ({ page, request }) => {
  for (let index = 0; index < 20; index += 1) {
    const response = await request.post('/api/messages/sync', {
      headers: { 'x-sooya-token': CHAT_TOKEN },
      data: { clientMsgId: `route-scroll-${index}-${Date.now()}`, content: [{ type: 'text', text: `路由滚动 ${index}` }] }
    });
    expect(response.ok()).toBeTruthy();
  }

  await page.goto('/');
  const scroller = page.getByTestId('scroller');
  await expect(page.locator('[data-testid="message"]').first()).toBeVisible();
  await scroller.evaluate((element) => { element.scrollTop = 40; });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const before = await scroller.evaluate((element) => element.scrollTop);

  await page.getByTestId('admin-entry').click();
  await expect(page.getByTestId('admin-dashboard')).toBeVisible();
  await page.getByTestId('admin-return-chat').first().click();
  await expect(scroller).toBeVisible();
  const after = await scroller.evaluate((element) => element.scrollTop);

  expect(Math.abs(after - before)).toBeLessThan(60);
});
```

- [ ] 先执行生产构建（Playwright 全局设置使用构建产物）：

```powershell
npm.cmd run build -w @sooya/server
npm.cmd run build -w @sooya/web
```

预期：两个 workspace 构建成功，前端 `dist` 生成且 Service Worker 资源注入成功。

- [ ] 运行桌面导航 E2E：

```powershell
npm.cmd run test:e2e -- --project=desktop navigation.e2e.ts
```

预期：2 个 E2E 测试通过；bootstrap 和 SSE 都保持 1 次，滚动差值小于 60px。

- [ ] 运行本片完整验证：

```powershell
npm.cmd test -w @sooya/web
npm.cmd run typecheck -w @sooya/web
npm.cmd run build -w @sooya/web
```

预期：所有旧测试与新增测试通过；类型检查和生产构建退出码均为 0。

- [ ] 提交浏览器回归测试：

```powershell
git add e2e/navigation.e2e.ts
git commit -m "test(web): cover persistent chat navigation"
```

## 本片完成检查

- [ ] `rg -n "window.location.pathname|window.history" packages/web/src/main.tsx packages/web/src/AppShell.tsx` 不再发现入口级 pathname 分支。
- [ ] 初始 `/admin/*` 与 `/gallery` 不请求 `/api/bootstrap` 或 `/api/stream`。
- [ ] 首次进入聊天后，chat → admin/gallery → chat 不重新 bootstrap，不重建 SSE。
- [ ] 后台内部 tab URL、浏览器前进/后退与未保存确认都可用。
- [ ] 聊天离开前贴底则返回最新消息；读历史则恢复有界 `scrollTop`。
- [ ] 工作区只包含本片解释过的改动和提交。
