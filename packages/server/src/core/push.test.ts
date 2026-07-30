import { createECDH, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PushService } from './push.js';
import type { PushSubscriptionRow } from '../db/repos/feature.repo.js';
import type { SettingsRepo, ErrorLogRepo } from '../db/repos/misc.repo.js';

/**
 * `test/push-retry.test.ts` owns the end-to-end expiry contract against a real database.
 * These are the two unit-level rules that are cheap to get wrong when touching `send()`:
 * a transient failure must never cost a subscription, and a tab that is demonstrably in
 * the foreground must not be pushed to at all.
 *
 * Note for anyone tempted to prune on `fail_count`: that was tried and reverted. The
 * contract test deliberately drives seven consecutive failures and still requires the
 * row to survive, because a push service outage must not silently unsubscribe every
 * device — only the user reopening the app can ever re-subscribe.
 */

const client = (() => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // A malformed p256dh makes encryption throw before the fetch, which quietly turns
  // every case into the same generic failure path.
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

function harness(rows: PushSubscriptionRow[]) {
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
    markFailure: (endpoint: string) => { failures.push(endpoint); return failures.length; }
  };
  const store = new Map<string, unknown>();
  const settings = {
    get: <T>(key: string, fallback: T): T => (store.has(key) ? store.get(key) as T : fallback),
    set: (key: string, value: unknown) => { store.set(key, value); }
  } as unknown as SettingsRepo;
  const errors = { add: vi.fn() } as unknown as ErrorLogRepo;
  return { subscriptions, settings, errors, removed, failures };
}

describe('PushService.send', () => {
  it('临时故障只记失败，绝不删订阅', async () => {
    const h = harness([row('https://push.example.com/flaky')]);
    const service = new PushService(h.subscriptions as never, h.settings, h.errors, (async () => new Response('nope', { status: 503 })) as never);

    for (let attempt = 0; attempt < 8; attempt++) {
      const summary = await service.send({ title: 'hi' });
      expect(summary.failed).toBe(1);
      expect(summary.removed).toBe(0);
    }
    expect(h.removed).toEqual([]);
    expect(h.failures).toHaveLength(8);
  });

  it('网络层直接抛错也一样不删订阅', async () => {
    const h = harness([row('https://push.example.com/timeout')]);
    const thrower = async () => { throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }); };
    const service = new PushService(h.subscriptions as never, h.settings, h.errors, thrower as never);

    const summary = await service.send({ title: 'hi' });

    expect(summary.failed).toBe(1);
    expect(h.removed).toEqual([]);
  });

  it('410 是永久失效，立刻删除且不计入失败', async () => {
    const h = harness([row('https://push.example.com/gone')]);
    const service = new PushService(h.subscriptions as never, h.settings, h.errors, (async () => new Response('', { status: 410 })) as never);

    const summary = await service.send({ title: 'hi' });

    expect(summary.removed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(h.removed).toEqual(['https://push.example.com/gone']);
    expect(h.failures).toEqual([]);
  });

  it('前台刚活跃过的设备直接跳过，不占推送配额', async () => {
    const h = harness([row('https://push.example.com/foreground', { visible: 1, last_seen_at: new Date().toISOString() })]);
    const fetchImpl = vi.fn(async () => new Response('', { status: 201 }));
    const service = new PushService(h.subscriptions as never, h.settings, h.errors, fetchImpl as never);

    const summary = await service.send({ title: 'hi' });

    expect(summary.attempted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('前台记录过期后照常推送', async () => {
    const stale = new Date(Date.now() - 60_000).toISOString();
    const h = harness([row('https://push.example.com/stale', { visible: 1, last_seen_at: stale })]);
    const service = new PushService(h.subscriptions as never, h.settings, h.errors, (async () => new Response('', { status: 201 })) as never);

    const summary = await service.send({ title: 'hi' });

    expect(summary.attempted).toBe(1);
    expect(summary.delivered).toBe(1);
  });
});
