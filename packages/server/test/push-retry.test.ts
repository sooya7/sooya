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

describe('push subscription expiry handling', () => {
  it('removes only permanent 404/410 endpoints and preserves subscriptions across temporary failures', async () => {
    harness = await createHarness();
    const states = new Map<string, '404' | '410' | '500' | '503' | 'network' | 'dns' | 'tls' | 'ok'>([
      ['gone-404', '404'],
      ['gone-410', '410'],
      ['server-500', '500'],
      ['server-503', '503'],
      ['network', 'network'],
      ['dns', 'dns'],
      ['tls', 'tls']
    ]);
    const fetchImpl: typeof fetch = async (input) => {
      const endpoint = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const name = new URL(endpoint).hostname.split('.')[0]!;
      const state = states.get(name);
      if (state === '404' || state === '410' || state === '500' || state === '503') {
        return new Response(state, { status: Number(state) });
      }
      if (state === 'network') throw new TypeError('temporary network failure');
      if (state === 'dns') throw Object.assign(new Error('temporary DNS lookup failure'), { code: 'EAI_AGAIN' });
      if (state === 'tls') throw Object.assign(new Error('temporary TLS handshake failure'), { code: 'ECONNRESET' });
      return new Response('', { status: 201 });
    };
    const service = new PushService(
      harness.app.repos.pushSubscriptions,
      harness.app.repos.settings,
      harness.app.repos.errors,
      fetchImpl
    );
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    for (const name of states.keys()) {
      service.subscribe({
        endpoint: `https://${name}.push.example/subscription`,
        keys: { p256dh: base64url(ecdh.getPublicKey()), auth: base64url(randomBytes(16)) }
      });
    }

    const first = await service.send({ title: 'test', body: 'test' });
    expect(first).toMatchObject({ attempted: 7, removed: 2, failed: 5 });
    expect(harness.app.repos.pushSubscriptions.get('https://gone-404.push.example/subscription')).toBeUndefined();
    expect(harness.app.repos.pushSubscriptions.get('https://gone-410.push.example/subscription')).toBeUndefined();

    for (let attempt = 2; attempt <= 7; attempt++) {
      const summary = await service.send({ title: 'test', body: `attempt-${attempt}` });
      expect(summary.removed).toBe(0);
      expect(summary.failed).toBe(5);
    }
    for (const name of ['server-500', 'server-503', 'network', 'dns', 'tls']) {
      const row = harness.app.repos.pushSubscriptions.get(`https://${name}.push.example/subscription`);
      expect(row, name).toBeTruthy();
      expect(row!.fail_count, name).toBe(7);
    }

    states.set('server-500', 'ok');
    const recovered = await service.send({ title: 'test', body: 'recovered' });
    expect(recovered.delivered).toBe(1);
    expect(recovered.removed).toBe(0);
    expect(harness.app.repos.pushSubscriptions.get('https://server-500.push.example/subscription')?.fail_count).toBe(0);
  });
});
