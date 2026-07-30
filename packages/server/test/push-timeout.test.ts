import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PushService } from '../src/core/push.js';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function base64url(value: Buffer): string {
  return value.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function subscribe(service: PushService, host: string): string {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const endpoint = `https://${host}.push.example/subscription`;
  service.subscribe({
    endpoint,
    keys: { p256dh: base64url(ecdh.getPublicKey()), auth: base64url(randomBytes(16)) }
  });
  return endpoint;
}

/**
 * A blackholed endpoint accepts the connection and never answers. Real fetch only escapes that
 * through its abort signal, so the fake must reject on abort exactly like fetch does -- a fake
 * that ignores the signal would hang forever even against correct code, and one that resolves
 * immediately would pass against a missing signal.
 */
function blackhole(seen?: { signals: (AbortSignal | null | undefined)[] }): typeof fetch {
  return ((_input: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    seen?.signals.push(signal);
    return new Promise((_resolve, reject) => {
      if (!signal) return; // no signal wired: hang, and let the assertion on `seen` report why
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  }) as typeof fetch;
}

const TIMEOUT_MS = 30;

/**
 * Without the fix `send()` never returns at all. Racing it keeps that regression a fast, named
 * failure instead of a mute wait for the runner's default timeout.
 */
async function sendOrHang(service: PushService) {
  return await Promise.race([
    service.send({ title: 'test', body: 'test' }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('send() never returned: a stalled endpoint hung the delivery loop')), 1_000)
    )
  ]);
}

describe('push delivery timeout', () => {
  it('passes an abort signal to the push endpoint', async () => {
    harness = await createHarness();
    const seen = { signals: [] as (AbortSignal | null | undefined)[] };
    const service = new PushService(
      harness.app.repos.pushSubscriptions,
      harness.app.repos.settings,
      harness.app.repos.errors,
      blackhole(seen),
      undefined,
      TIMEOUT_MS
    );
    subscribe(service, 'blackhole');

    await sendOrHang(service);

    expect(seen.signals).toHaveLength(1);
    expect(seen.signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('fails a blackholed endpoint with a named timeout instead of hanging', async () => {
    harness = await createHarness();
    const service = new PushService(
      harness.app.repos.pushSubscriptions,
      harness.app.repos.settings,
      harness.app.repos.errors,
      blackhole(),
      undefined,
      TIMEOUT_MS
    );
    const endpoint = subscribe(service, 'blackhole');

    const summary = await sendOrHang(service);

    expect(summary).toMatchObject({ attempted: 1, delivered: 0, removed: 0, failed: 1 });
    // A stall is temporary, so the subscription must survive it.
    expect(harness.app.repos.pushSubscriptions.get(endpoint)).toBeTruthy();
    const logged = harness.app.repos.errors.list(10).filter((row) => row.scope === 'push.deliver');
    expect(logged).toHaveLength(1);
    expect(logged[0]!.message).toContain('timed out');
    expect(logged[0]!.message).toContain(String(TIMEOUT_MS));
  });

  it('does not let one stalled endpoint starve the subscriptions behind it', async () => {
    harness = await createHarness();
    const stalled = blackhole();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (new URL(url).hostname.startsWith('blackhole')) return stalled(input, init);
      return new Response('', { status: 201 });
    };
    const service = new PushService(
      harness.app.repos.pushSubscriptions,
      harness.app.repos.settings,
      harness.app.repos.errors,
      fetchImpl,
      undefined,
      TIMEOUT_MS
    );
    // Subscribed first, so it is delivered to first and blocks the loop if it can.
    subscribe(service, 'blackhole');
    const reachable = subscribe(service, 'reachable');

    const summary = await sendOrHang(service);

    expect(summary).toMatchObject({ attempted: 2, delivered: 1, failed: 1 });
    expect(harness.app.repos.pushSubscriptions.get(reachable)?.fail_count).toBe(0);
  });

  it('does not abort an endpoint that answers within the timeout', async () => {
    harness = await createHarness();
    const service = new PushService(
      harness.app.repos.pushSubscriptions,
      harness.app.repos.settings,
      harness.app.repos.errors,
      async () => new Response('', { status: 201 }),
      undefined,
      TIMEOUT_MS
    );
    subscribe(service, 'fast');

    const summary = await sendOrHang(service);

    expect(summary).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });
    expect(harness.app.repos.errors.list(10).filter((row) => row.scope === 'push.deliver')).toHaveLength(0);
  });
});
