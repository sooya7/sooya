import { createECDH, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PushService } from './push.js';
import type { PushSubscriptionRow } from '../db/repos/feature.repo.js';
import type { SettingsRepo, ErrorLogRepo } from '../db/repos/misc.repo.js';

/**
 * A push service only answers 404/410 for endpoints it still knows about, so an
 * endpoint that keeps timing out was never cleaned up: `fail_count` was written on
 * every failure and read by nobody. These tests pin the retirement rule.
 */

/**
 * Real client keys. A malformed p256dh makes payload encryption throw *before* the
 * fetch, which silently turns every case into the generic failure path — the first
 * version of this file passed for that reason and never reached the 410 branch.
 */
const client = (() => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
})();

function row(endpoint: string, overrides: Partial<PushSubscriptionRow> = {}): PushSubscriptionRow {
  return {
    endpoint,
    p256dh: client.p256dh,
    auth: client.auth,
    expiration_time: null,
    visible: 0,
    last_seen_at: null,
    fail_count: 0,
    created_at: '2026-07-30T00:00:00.000Z',
    updated_at: '2026-07-30T00:00:00.000Z',
    ...overrides
  } as PushSubscriptionRow;
}

function harness(rows: PushSubscriptionRow[], failuresReturned: number) {
  const removed: string[] = [];
  const failures: string[] = [];
  const subscriptions = {
    list: () => rows,
    count: () => rows.length,
    upsert: vi.fn(),
    get: (endpoint: string) => rows.find((item) => item.endpoint === endpoint),
    remove: (endpoint: string) => { removed.push(endpoint); return true; },
    markVisibility: vi.fn(),
    markSuccess: vi.fn(),
    markFailure: (endpoint: string) => { failures.push(endpoint); return failuresReturned; }
  };
  const store = new Map<string, unknown>();
  const settings = {
    get: <T>(key: string, fallback: T): T => (store.has(key) ? store.get(key) as T : fallback),
    set: (key: string, value: unknown) => { store.set(key, value); }
  } as unknown as SettingsRepo;
  const logged: Array<{ scope: string; message: string }> = [];
  const errors = { add: (scope: string, message: string) => { logged.push({ scope, message }); } } as unknown as ErrorLogRepo;
  return { subscriptions, settings, errors, removed, failures, logged };
}

const failingFetch = async () => new Response('nope', { status: 500 });

describe('PushService 失败端点回收', () => {
  it('偶发失败只记一次，不删订阅', async () => {
    const h = harness([row('https://push.example.com/a')], 2);
    const service = new PushService(h.subscriptions as never, h.settings, h.errors, failingFetch as never);

    const summary = await service.send({ title: 'hi' });

    expect(summary.failed).toBe(1);
    expect(summary.removed).toBe(0);
    expect(h.failures).toEqual(['https://push.example.com/a']);
    expect(h.removed).toEqual([]);
  });

  it('连续失败达到阈值就删掉端点，并记一条可查的日志', async () => {
    const h = harness([row('https://push.example.com/dead')], 6);
    const service = new PushService(h.subscriptions as never, h.settings, h.errors, failingFetch as never);

    const summary = await service.send({ title: 'hi' });

    expect(summary.failed).toBe(1);
    expect(summary.removed).toBe(1);
    expect(h.removed).toEqual(['https://push.example.com/dead']);
    expect(h.logged.some((entry) => entry.scope === 'push.retire')).toBe(true);
  });

  it('网络直接抛错也走同一条回收路径', async () => {
    const h = harness([row('https://push.example.com/timeout')], 6);
    const thrower = async () => { throw new Error('connect ETIMEDOUT'); };
    const service = new PushService(h.subscriptions as never, h.settings, h.errors, thrower as never);

    const summary = await service.send({ title: 'hi' });

    expect(summary.removed).toBe(1);
    expect(h.removed).toEqual(['https://push.example.com/timeout']);
  });

  it('410 仍然立刻删除，不必等阈值', async () => {
    const h = harness([row('https://push.example.com/gone')], 1);
    const gone = async () => new Response('', { status: 410 });
    const service = new PushService(h.subscriptions as never, h.settings, h.errors, gone as never);

    const summary = await service.send({ title: 'hi' });

    expect(summary.removed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(h.failures).toEqual([]);
  });

  it('前台刚活跃过的订阅直接跳过，不计失败', async () => {
    const h = harness([row('https://push.example.com/foreground', { visible: 1, last_seen_at: new Date().toISOString() })], 6);
    const service = new PushService(h.subscriptions as never, h.settings, h.errors, failingFetch as never);

    const summary = await service.send({ title: 'hi' });

    expect(summary.attempted).toBe(0);
    expect(h.failures).toEqual([]);
    expect(h.removed).toEqual([]);
  });
});
