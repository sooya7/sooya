import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;

afterEach(async () => {
  if (h) await h.cleanup();
});

interface SseEvent {
  id?: string;
  event: string;
  data: Record<string, any>;
}

/** Minimal SSE client over a real TCP connection. */
async function openStream(baseUrl: string, lastEventId?: string) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/stream`, {
    headers: lastEventId ? { 'last-event-id': lastEventId } : {},
    signal: controller.signal
  });
  if (!res.body) throw new Error('no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const evt: SseEvent = { event: 'message', data: {} };
          for (const line of raw.split('\n')) {
            if (line.startsWith('id:')) evt.id = line.slice(3).trim();
            else if (line.startsWith('event:')) evt.event = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              try {
                evt.data = JSON.parse(line.slice(5).trim());
              } catch {
                /* comment/keepalive */
              }
            }
          }
          if (evt.event !== 'message' || Object.keys(evt.data).length > 0) events.push(evt);
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    events,
    close: () => {
      controller.abort();
      return pump.catch(() => undefined);
    },
    waitFor: async (type: string, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = events.find((e) => e.event === type);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`timed out waiting for ${type}; got: ${events.map((e) => e.event).join(',')}`);
    }
  };
}

async function listen(h: Harness): Promise<string> {
  await h.app.server.listen({ host: '127.0.0.1', port: 0 });
  const addr = h.app.server.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return `http://127.0.0.1:${addr.port}`;
}

describe('SSE streaming', () => {
  it('emits the full event lifecycle for a reply', async () => {
    h = await createHarness({ tts: 'ok', image: 'ok', chat: { script: [['你好', '呀[[sticker:开心]][[image:星空]][[voice]]']] } });
    const base = await listen(h);
    const stream = await openStream(base);
    await stream.waitFor('stream.ready');

    await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientMsgId: 'sse-1', content: [{ type: 'text', text: '在吗' }] })
    });

    await stream.waitFor('reply.completed', 10000);
    const types = stream.events.map((e) => e.event);
    for (const expected of [
      'message.received',
      'reply.thinking',
      'reply.text.delta',
      'reply.text.done',
      'reply.sticker.selecting',
      'reply.image.generating',
      'reply.audio.generating',
      'reply.media.saved',
      'reply.content.done',
      'reply.completed'
    ]) {
      expect(types, `missing ${expected}`).toContain(expected);
    }
    await stream.close();
  });

  it('streams text incrementally', async () => {
    h = await createHarness({ chat: { script: [['一', '二', '三', '四']] } });
    const base = await listen(h);
    const stream = await openStream(base);
    await stream.waitFor('stream.ready');
    await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientMsgId: 'sse-2', content: [{ type: 'text', text: '数数' }] })
    });
    await stream.waitFor('reply.completed');
    const deltas = stream.events.filter((e) => e.event === 'reply.text.delta');
    expect(deltas.length).toBeGreaterThanOrEqual(4);
    expect(deltas.at(-1)!.data.text).toBe('一二三四');
    await stream.close();
  });

  it('never streams a long image directive as visible assistant text', async () => {
    const prompt = 'A young woman sleeping peacefully in bed, hugging a soft white blanket, dim warm nightlight on bedside table, a cute corgi plushie tucked beside her, realistic photography, soft warm tones';
    const marker = `[[image:${prompt}]]`;
    h = await createHarness({ image: 'ok', chat: { script: [[marker.slice(0, 49), marker.slice(49)]] } });
    const base = await listen(h);
    const stream = await openStream(base);
    await stream.waitFor('stream.ready');

    await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientMsgId: 'sse-directive-leak', content: [{ type: 'text', text: '画一张图' }] })
    });

    const completed = await stream.waitFor('reply.completed', 10000);
    const deltas = stream.events.filter((event) => event.event === 'reply.text.delta');
    expect(deltas.every((event) => !String(event.data.text ?? '').includes('[[image:'))).toBe(true);
    expect(JSON.stringify(completed.data)).not.toContain('[[image:');
    await stream.close();
  });

  it('replays missed events after a disconnect (no refresh needed)', async () => {
    h = await createHarness({ chat: { script: [['断线期间的回复']] } });
    const base = await listen(h);

    const first = await openStream(base);
    const ready = await first.waitFor('stream.ready');
    const lastSeq = String(ready.data.lastEventSeq ?? 0);
    await first.close();

    // Reply happens while nobody is listening.
    await fetch(`${base}/api/messages/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientMsgId: 'sse-3', content: [{ type: 'text', text: '你在吗' }] })
    });

    const second = await openStream(base, lastSeq);
    await second.waitFor('stream.ready');
    const completed = second.events.find((e) => e.event === 'reply.completed');
    expect(completed, 'reply.completed must be replayed').toBeTruthy();
    expect(JSON.stringify(completed!.data)).toContain('断线期间的回复');
    const readyEvt = second.events.find((e) => e.event === 'stream.ready')!;
    expect(readyEvt.data.replayed).toBeGreaterThan(0);
    expect(readyEvt.data.gapPossible).toBe(false);
    await second.close();
  });

  it('signals a possible gap when the event log was pruned past the client position', async () => {
    h = await createHarness();
    const base = await listen(h);
    const stream = await openStream(base, '999999');
    const ready = await stream.waitFor('stream.ready');
    expect(ready.data.gapPossible).toBe(false); // client ahead of server -> no gap claim
    await stream.close();

    // Now simulate a real gap: events exist beyond the client's position but were pruned.
    await fetch(`${base}/api/messages/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientMsgId: 'gap-1', content: [{ type: 'text', text: 'hi' }] })
    });
    h.app.repos.events.prune(0);
    const s2 = await openStream(base, '1');
    const ready2 = await s2.waitFor('stream.ready');
    expect(ready2.data.gapPossible).toBe(true);
    expect(ready2.data.lastMessageSeq).toBeGreaterThan(0);
    await s2.close();
  });

  it('serves the same events through the polling fallback', async () => {
    h = await createHarness({ chat: { script: [['轮询回复']] } });
    const base = await listen(h);
    await fetch(`${base}/api/messages/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientMsgId: 'poll-1', content: [{ type: 'text', text: '你好' }] })
    });
    const res = await fetch(`${base}/api/events?since=0`);
    const body = (await res.json()) as { events: SseEvent[]; lastEventSeq: number };
    const types = body.events.map((e: any) => e.type);
    expect(types).toContain('reply.completed');
    expect(body.lastEventSeq).toBeGreaterThan(0);
  });

  it('rejects an out-of-range limit on the polling fallback', async () => {
    h = await createHarness();
    for (const limit of ['-5', '0', 'abc', '999']) {
      const res = await h.app.server.inject({ method: 'GET', url: `/api/events?limit=${limit}` });
      expect(res.statusCode, `limit=${limit}`).toBe(400);
      expect(res.json().error).toBe('bad_request');
    }
    const ok = await h.app.server.inject({ method: 'GET', url: '/api/events?limit=200' });
    expect(ok.statusCode).toBe(200);
    const okSince = await h.app.server.inject({ method: 'GET', url: '/api/events?since=0' });
    expect(okSince.statusCode).toBe(200);
  });

  it('a reply written to the database is always reachable via REST even if no event arrives', async () => {
    h = await createHarness({ chat: { script: [['数据库里的回复']] } });
    const base = await listen(h);
    await fetch(`${base}/api/messages/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientMsgId: 'db-1', content: [{ type: 'text', text: '你好' }] })
    });
    h.app.repos.events.clear(); // worst case: all events lost
    const res = await fetch(`${base}/api/messages?limit=10`);
    const body = (await res.json()) as any;
    expect(JSON.stringify(body.messages)).toContain('数据库里的回复');
  });
});
