import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DirectorClient } from '../src/core/director/client.js';
import type { ChatProvider, ChatRequest } from '../src/providers/types.js';

function fakeProvider(reply: string, seen: ChatRequest[], delayMs = 0): ChatProvider {
  return {
    name: 'fake-director',
    configured: true,
    async complete(request) {
      seen.push(request);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { text: reply, model: 'fake-director' };
    },
    async stream() { return { text: reply, model: 'fake-director' }; },
    async inspectHealth() { return { capability: 'director', configured: true, ok: true, provider: 'fake-director', checkedAt: new Date().toISOString() }; }
  };
}

describe('DirectorClient', () => {
  it('uses JSON mode, extracts wrapped JSON, validates it, and emits privacy-safe metadata', async () => {
    const requests: ChatRequest[] = [];
    const events: Array<Record<string, unknown>> = [];
    const client = new DirectorClient(() => fakeProvider('前缀 {"ok":true} 后缀', requests), {
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>)
    });
    const result = await client.run({
      task: 'sticker',
      system: 'fixed prompt',
      input: '用户私人内容，不应进入事件',
      schema: z.object({ ok: z.literal(true) }),
      maxTokens: 150,
      temperature: 0.1,
      timeoutMs: 5000
    });

    expect(result?.data).toEqual({ ok: true });
    expect(requests[0]?.jsonMode).toBe(true);
    expect(events.some((event) => event.event === 'started' && !('input' in event))).toBe(true);
    expect(events.at(-1)?.event).toBe('completed');
  });

  it('returns null on the task timeout and records a bounded failure reason', async () => {
    const events: Array<Record<string, unknown>> = [];
    const client = new DirectorClient(() => fakeProvider('{"ok":true}', [], 30), {
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>)
    });
    const result = await client.run({
      task: 'image',
      system: 'fixed prompt',
      input: 'data',
      schema: z.object({ ok: z.literal(true) }),
      maxTokens: 900,
      temperature: 0.45,
      timeoutMs: 5
    });

    expect(result).toBeNull();
    expect(events.at(-1)).toMatchObject({ event: 'failed', task: 'image', reason: 'timeout' });
  });
});
