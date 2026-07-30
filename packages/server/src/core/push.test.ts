import { createECDH, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PushService, normalizeVapidSubject } from './push.js';
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

/**
 * The VAPID `sub` claim. iOS notifications were being dropped for weeks with nothing
 * visible in the UI: `error_log` held four `push.deliver` 403s from
 * `web.push.apple.com` and nothing else, because the subject was hardcoded to
 * `mailto:admin@localhost` and Apple rejects it. Chrome accepts anything, so the bug
 * was invisible on every other device.
 */
describe('normalizeVapidSubject', () => {
  it('接受能真正联系到人的两种形式', () => {
    expect(normalizeVapidSubject('mailto:admin@sooya.icu')).toBe('mailto:admin@sooya.icu');
    expect(normalizeVapidSubject('  https://echo.sooya.icu  ')).toBe('https://echo.sooya.icu');
    expect(normalizeVapidSubject('https://echo.sooya.icu/contact')).toBe('https://echo.sooya.icu/contact');
  });

  it('拒绝苹果会回 403 的那些值 —— 包括曾经硬编码的默认值', () => {
    for (const bad of ['mailto:admin@localhost', 'https://localhost', 'mailto:admin', 'admin@sooya.icu', 'http://echo.sooya.icu', '', '   ', undefined, null]) {
      expect(normalizeVapidSubject(bad)).toBeNull();
    }
  });
});

describe('PushService VAPID subject', () => {
  const capture = async (configured?: string, stored?: string) => {
    const h = harness([row('https://web.push.apple.com/device')]);
    if (stored) {
      // Simulate an install whose keys were generated before this was configurable.
      const service = new PushService(h.subscriptions as never, h.settings, h.errors, (async () => new Response('', { status: 201 })) as never);
      const keys = (h.settings.get as (k: string, f: unknown) => Record<string, unknown>)('push.vapid', {});
      h.settings.set('push.vapid', { ...keys, subject: stored });
      void service;
    }
    let authorization = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      authorization = String((init.headers as Record<string, string>).Authorization ?? '');
      return new Response('', { status: 201 });
    }) as unknown as typeof fetch;
    const service = new PushService(h.subscriptions as never, h.settings, h.errors, fetchImpl, configured);
    await service.send({ id: 'm1', role: 'assistant', content: [{ id: 'p1', type: 'text', text: '在的' }] } as never);
    const token = /vapid t=([^,]+)/.exec(authorization)?.[1] ?? '';
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub: string; aud: string };
    return { claims, errors: h.errors.add as unknown as ReturnType<typeof vi.fn> };
  };

  it('用配置的 subject 签名，而不是库里存着的那个', async () => {
    const { claims } = await capture('mailto:admin@sooya.icu', 'mailto:admin@localhost');

    // The stored value is the broken legacy one; config has to win or existing
    // installs stay broken forever.
    expect(claims.sub).toBe('mailto:admin@sooya.icu');
    expect(claims.aud).toBe('https://web.push.apple.com');
  });

  it('配置值非法时不静默降级，写进 error_log 说明后果', async () => {
    const { claims, errors } = await capture('mailto:admin@localhost');

    expect(claims.sub).not.toBe('mailto:admin@localhost');
    const logged = errors.mock.calls.find((call) => call[0] === 'push.config');
    expect(logged).toBeDefined();
    expect(String(logged?.[1])).toContain('SOOYA_PUSH_SUBJECT');
  });
});
