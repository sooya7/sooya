// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationBridge } from './NotificationBridge.js';

/**
 * This toggle was "fixed" three times (PR #7, #8, #10) because nothing ever mounted
 * it: the unit tests covered `disablePushSubscription` in isolation, so a component
 * that showed the wrong label, occupied the chat forever, or hid itself with no way
 * back all passed cleanly. These tests drive the real component against a fake
 * browser push stack and assert what the user actually sees.
 */

const HIDDEN_KEY = 'sooya.push.optin.hidden';

interface FakeSub {
  endpoint: string;
  toJSON(): unknown;
  unsubscribe: () => Promise<boolean>;
}

interface SetupOptions {
  subscribed?: boolean;
  permission?: string;
  /** Simulates a browser that refuses to drop the subscription. */
  keepSubscription?: boolean;
}

let browser: { current: FakeSub | null };
let requested: string[];

function setup(options: SetupOptions = {}): void {
  const sub: FakeSub = {
    endpoint: 'https://push.example.com/endpoint-1',
    toJSON: () => ({ endpoint: 'https://push.example.com/endpoint-1', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } }),
    unsubscribe: vi.fn(async () => {
      if (!options.keepSubscription) browser.current = null;
      return true;
    })
  };
  browser = { current: options.subscribed ? sub : null };
  requested = [];

  const registration = {
    pushManager: {
      getSubscription: async () => browser.current,
      subscribe: async () => { browser.current = sub; return sub; }
    }
  };
  Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve(registration) }, configurable: true });

  let permission = options.permission ?? 'default';
  class FakeNotification {
    static get permission(): string { return permission; }
    static requestPermission = async (): Promise<string> => {
      permission = options.permission === 'denied' ? 'denied' : 'granted';
      return permission;
    };
  }
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const body = url.includes('public-key') ? { publicKey: 'AQID' } : { unsubscribed: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

let root: Root | null = null;
let container: HTMLElement;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => { created.render(<NotificationBridge />); });
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error('expected the element to be on screen');
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const bar = () => container.querySelector('[data-testid="push-controls"]');
const bell = () => container.querySelector('[data-testid="push-reopen"]');
const toggle = () => container.querySelector<HTMLButtonElement>('[data-testid="push-controls"] button:not(.notification-dismiss)');
const dismiss = () => container.querySelector('[data-testid="push-controls"] .notification-dismiss');
const note = () => container.querySelector('[data-testid="push-controls"] small')?.textContent ?? '';

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
});

afterEach(async () => {
  if (root) { const current = root; await act(async () => { current.unmount(); }); root = null; }
  container?.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NotificationBridge', () => {
  it('开启后按钮改成「关闭通知」，并把订阅登记到服务端', async () => {
    setup();
    await mount();
    expect(toggle()?.textContent).toBe('开启通知');

    await click(toggle());

    expect(toggle()?.textContent).toBe('关闭通知');
    expect(note()).toBe('后台通知已开启');
    expect(requested.some((url) => url.includes('/api/push/subscribe'))).toBe(true);
  });

  it('关闭后按钮回到「开启通知」——这是修了三次的那个 bug', async () => {
    setup({ subscribed: true, permission: 'granted' });
    await mount();
    expect(toggle()?.textContent).toBe('关闭通知');

    await click(toggle());

    expect(toggle()?.textContent).toBe('开启通知');
    expect(browser.current).toBeNull();
    expect(requested.some((url) => url.includes('/api/push/unsubscribe'))).toBe(true);
  });

  it('浏览器没真的取消时不许谎报已关闭', async () => {
    setup({ subscribed: true, permission: 'granted', keepSubscription: true });
    await mount();

    await click(toggle());

    // The browser still reports a subscription, so the label must stay honest.
    expect(toggle()?.textContent).toBe('关闭通知');
    expect(note()).toBe('订阅仍然存在，请再试一次');
  });

  it('收起后留下铃铛，点铃铛能把开关拿回来', async () => {
    setup();
    await mount();

    await click(dismiss());

    expect(bar()).toBeNull();
    expect(window.localStorage.getItem(HIDDEN_KEY)).toBe('1');
    const reopen = bell();
    expect(reopen).not.toBeNull();
    expect(reopen?.getAttribute('aria-label')).toContain('已关闭');

    await click(reopen);

    // Hiding used to be a one-way door: the flag persisted and no UI path came back.
    expect(bar()).not.toBeNull();
    expect(window.localStorage.getItem(HIDDEN_KEY)).toBeNull();
  });

  it('铃铛反映当前是开着的', async () => {
    setup({ subscribed: true, permission: 'granted' });
    await mount();

    await click(dismiss());

    const reopen = bell();
    expect(reopen?.className).toContain('is-on');
    expect(reopen?.getAttribute('aria-label')).toContain('已开启');
    expect(reopen?.querySelector('.notification-reopen-slash')).toBeNull();
  });

  it('已收起时仍然会因为待处理状态重新出现', async () => {
    setup({ subscribed: true, permission: 'granted' });
    window.localStorage.setItem(HIDDEN_KEY, '1');
    await mount();

    // Hidden, so only the bell is on screen …
    expect(bar()).toBeNull();
    await click(bell());
    // … and reopening keeps the real state instead of resetting to "off".
    expect(toggle()?.textContent).toBe('关闭通知');
  });

  it('权限被浏览器拒绝时改成提示去站点设置', async () => {
    setup({ permission: 'denied' });
    await mount();

    expect(container.textContent).toContain('通知权限已被浏览器禁用');
    expect(bar()).toBeNull();
  });
});
