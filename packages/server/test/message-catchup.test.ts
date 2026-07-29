import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';

let h: Harness;

afterEach(async () => {
  if (h) await h.cleanup();
});

/** Drive `count` user turns so the conversation has 2*count messages. */
async function seedTurns(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await sendText(h.app, `第${i + 1}条`);
  }
}

describe('reconnect catch-up paging', () => {
  it('caps a catch-up page at the requested limit and reports hasMore', async () => {
    h = await createHarness({ chat: { script: Array.from({ length: 6 }, () => ['好']) } });
    await seedTurns(6); // 12 messages, seq 1..12

    const res = await h.app.server.inject({ method: 'GET', url: '/api/messages?since=0&limit=5' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.messages).toHaveLength(5);
    expect(body.hasMore).toBe(true);
    // oldest-first, starting strictly after seq 0
    expect(body.messages[0].seq).toBe(1);
    expect(body.messages[4].seq).toBe(5);
    expect(body.nextSince).toBe(5);
  });

  it('walking nextSince yields every message exactly once', async () => {
    h = await createHarness({ chat: { script: Array.from({ length: 6 }, () => ['好']) } });
    await seedTurns(6); // 12 messages

    const seen: number[] = [];
    let since = 0;
    let guard = 0;
    for (;;) {
      guard += 1;
      expect(guard).toBeLessThan(20);
      const body = (await h.app.server.inject({ method: 'GET', url: `/api/messages?since=${since}&limit=5` })).json();
      for (const m of body.messages) seen.push(m.seq);
      if (!body.hasMore) break;
      expect(body.nextSince).toBeGreaterThan(since);
      since = body.nextSince;
    }

    expect(seen).toEqual([...Array(12)].map((_, i) => i + 1));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('returns an empty final page without advancing the cursor', async () => {
    h = await createHarness({ chat: { script: [['好']] } });
    await seedTurns(1); // 2 messages

    const res = await h.app.server.inject({ method: 'GET', url: '/api/messages?since=2&limit=5' });
    const body = res.json();

    expect(body.messages).toHaveLength(0);
    expect(body.hasMore).toBe(false);
    expect(body.nextSince).toBe(2);
    expect(body.lastMessageSeq).toBe(2);
  });
});
