// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QqAdminPage } from './QqAdminPage.js';

const adminMocks = vi.hoisted(() => ({
  qqStatus: vi.fn(async () => ({
    enabled: true,
    env: 'production',
    appIdSummary: '1020…0000',
    credentialConfigured: true,
    allowedUserCount: 1,
    proactiveEnabled: true,
    owner: { externalUserId: 'owner-uuid', boundAt: '2026-08-18T00:00:00.000Z', lastSeenAt: null },
    counts: { pending: 2, retry: 1, sending: 0, failed: 1, sent: 5 },
    metrics: []
  })),
  qqEvents: vi.fn(async () => ({
    events: [{ eventId: 'evt-1', eventType: 'C2C_MESSAGE_CREATE', status: 'processed', errorCode: null, messageId: 'm-1', receivedAt: '2026-08-18T00:00:00.000Z', processedAt: null }]
  })),
  qqDeliveries: vi.fn(async () => ({
    deliveries: [
      { id: 'del-1', messageId: 'm-1', externalConversationId: 'owner-uuid', status: 'retry', attempts: 2, nextRetryAt: null, remoteMessageId: null, lastErrorCode: 'http_429', lastErrorSummary: 'rate limited', createdAt: '2026-08-18T00:00:00.000Z', deliveredAt: null }
    ]
  })),
  qqErrors: vi.fn(async () => ({ errors: [{ scope: 'qq.send', message: 'rate limited', createdAt: '2026-08-18T00:00:00.000Z' }] })),
  qqTestSend: vi.fn(async () => ({ ok: true, messageId: 'ROBOT1.0_ok' })),
  qqRetryDelivery: vi.fn(async () => ({ deliveryId: 'del-1', status: 'pending' }))
}));

vi.mock('../../lib/admin.js', () => ({ adminApi: adminMocks }));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('QqAdminPage', () => {
  it('renders channel status, delivery queue, event list and error digest (no secrets)', async () => {
    await act(async () => {
      root!.render(<QqAdminPage onNotice={vi.fn()} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(adminMocks.qqStatus).toHaveBeenCalledTimes(1));
    expect(container!.textContent).toContain('QQ 通道');
    expect(container!.textContent).toContain('已启用');
    expect(container!.textContent).toContain('已配置');
    expect(container!.textContent).toContain('owner-uuid');
    expect(container!.textContent).toContain('退避 1');
    expect(container!.textContent).not.toContain('app-secret');
    expect(container!.textContent).not.toContain('call-secret');

    // 投递队列行带重试按钮
    const retryButtons = Array.from(container!.querySelectorAll('button')).filter((b) => b.textContent?.includes('重试'));
    expect(retryButtons.length).toBeGreaterThan(0);

    // 事件与错误摘要
    expect(container!.textContent).toContain('C2C_MESSAGE_CREATE');
    expect(container!.textContent).toContain('qq.send');
  });

  it('sends a test message and shows the resulting remote message id', async () => {
    await act(async () => {
      root!.render(<QqAdminPage onNotice={vi.fn()} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(adminMocks.qqStatus).toHaveBeenCalledTimes(1));

    const input = container!.querySelector('#admin-qq-test-text') as HTMLInputElement;
    const sendButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '发送')!;
    await act(async () => {
      // React 受控输入需要用原生 setter 触发 onChange。
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '你好');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      sendButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adminMocks.qqTestSend).toHaveBeenCalledWith('你好');
    await vi.waitFor(() => expect(container!.textContent).toContain('已发送'));
  });
});