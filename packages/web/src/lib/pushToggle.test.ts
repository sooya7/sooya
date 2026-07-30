import { describe, expect, it, vi } from 'vitest';
import { disablePushSubscription } from './pushToggle.js';

function fakeSubscription(overrides: { unsubscribe?: () => Promise<boolean> } = {}) {
  const calls: string[] = [];
  return {
    calls,
    subscription: {
      endpoint: 'https://push.example.com/endpoint-1',
      unsubscribe: overrides.unsubscribe ?? (async () => { calls.push('browser'); return true; })
    }
  };
}

describe('disablePushSubscription', () => {
  it('取消浏览器订阅并删除服务端记录', async () => {
    const { subscription } = fakeSubscription();
    const request = vi.fn().mockResolvedValue({ unsubscribed: true });

    const result = await disablePushSubscription(subscription, request as never);

    expect(result).toEqual({ browserRemoved: true, serverRemoved: true });
    expect(request).toHaveBeenCalledWith('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: subscription.endpoint })
    });
  });

  it('服务端失败时仍然取消浏览器订阅，不抛错', async () => {
    const order: string[] = [];
    const subscription = {
      endpoint: 'https://push.example.com/endpoint-2',
      unsubscribe: async () => { order.push('browser'); return true; }
    };
    const request = vi.fn(async () => { order.push('server'); throw new Error('通知请求失败 (401)'); });

    const result = await disablePushSubscription(subscription, request as never);

    expect(order).toEqual(['browser', 'server']);
    expect(result.browserRemoved).toBe(true);
    expect(result.serverRemoved).toBe(false);
    expect(result.warning).toContain('已在本机关闭');
  });

  it('浏览器侧失败但服务端成功时视为已关闭并提示', async () => {
    const subscription = {
      endpoint: 'https://push.example.com/endpoint-3',
      unsubscribe: async () => { throw new Error('unsubscribe failed'); }
    };
    const request = vi.fn().mockResolvedValue({ unsubscribed: true });

    const result = await disablePushSubscription(subscription, request as never);

    expect(result.browserRemoved).toBe(false);
    expect(result.serverRemoved).toBe(true);
    expect(result.warning).toContain('浏览器订阅未能取消');
  });

  it('两侧都失败才抛错，便于用户重试', async () => {
    const subscription = {
      endpoint: 'https://push.example.com/endpoint-4',
      unsubscribe: async () => { throw new Error('unsubscribe failed'); }
    };
    const request = vi.fn(async () => { throw new Error('通知请求失败 (500)'); });

    await expect(disablePushSubscription(subscription, request as never)).rejects.toThrow(/unsubscribe failed.*500/);
  });

  it('服务端返回 unsubscribed=false 时不算删除成功，但也不阻塞关闭', async () => {
    const { subscription } = fakeSubscription();
    const request = vi.fn().mockResolvedValue({ unsubscribed: false });

    const result = await disablePushSubscription(subscription, request as never);

    expect(result).toEqual({ browserRemoved: true, serverRemoved: false });
  });
});
