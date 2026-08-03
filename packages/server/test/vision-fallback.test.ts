import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TEST_PNG, sendText, type Harness } from './helpers/harness.js';
import type { FakeChatOptions } from './helpers/harness.js';

/**
 * Regression coverage for the "endpoint declares vision but rejects images"
 * fallback in `core/replier.ts`: a 4xx that names image input drops the
 * pictures and retries as plain text, while transient or unrelated failures
 * must keep their normal error handling.
 */

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const carriesImage = (body: unknown): boolean => JSON.stringify(body).includes('image_url');

async function harnessWithImage(chat: FakeChatOptions) {
  const h = await createHarness({ chat });
  const form = new FormData();
  form.set('image', new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' }), 'a.png');
  const upload = await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form });
  return { h, mediaId: upload.json().media[0].id as string };
}

async function sendImage(h: Harness, mediaId: string, text: string) {
  const res = await h.app.server.inject({
    method: 'POST',
    url: '/api/messages/sync',
    payload: {
      clientMsgId: `vf_${Math.random().toString(36).slice(2)}`,
      content: [{ type: 'text', text }, { type: 'image', mediaId }]
    }
  });
  return res.json() as Record<string, any>;
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

describe('vision input rejection fallback', () => {
  it('reports the degradation and logs it when the text-only retry succeeds', async () => {
    const made = await harnessWithImage({ script: [['看不了图，但我在'], ['看不了图，但我在']], rejectImages: true });
    h = made.h;

    const body = await sendImage(h, made.mediaId, '看这个');

    expect(body.outcome.ok).toBe(true);
    expect(body.outcome.degraded).toContain('chat:vision_unsupported');
    expect(body.outcome.degraded).not.toContain('chat:provider_unavailable');

    const logged = h.app.repos.errors.list(50).filter((e) => e.message === 'vision_input_rejected');
    expect(logged).toHaveLength(1);
    expect(logged[0]!.scope).toBe('reply.chat');
  });

  it('keeps the user text and replaces the picture with a marker on the retry', async () => {
    const made = await harnessWithImage({ script: [['收到']], rejectImages: true });
    h = made.h;

    await sendImage(h, made.mediaId, '看这个');

    const withImage = h.state.chatCalls.filter((c) => carriesImage(c.body));
    const textOnly = h.state.chatCalls.filter((c) => !carriesImage(c.body));
    expect(withImage).toHaveLength(1);
    expect(textOnly).toHaveLength(1);

    const retryUser = (textOnly[0]!.body as { messages: Array<{ role: string; content: unknown }> }).messages.at(-1)!;
    expect(retryUser.role).toBe('user');
    const content = JSON.stringify(retryUser.content);
    expect(content).toContain('看这个');
    expect(content).toContain('[图片]');
  });

  it('does not retry text-only when the image request fails with a transient 5xx', async () => {
    const made = await harnessWithImage({
      respond: ({ body }) => (carriesImage(body) ? errorResponse(503, 'image service temporarily unavailable') : null)
    });
    h = made.h;

    const body = await sendImage(h, made.mediaId, '看这个');

    expect(h.state.chatCalls.filter((c) => !carriesImage(c.body))).toHaveLength(0);
    expect(body.outcome.degraded).toContain('chat:provider_unavailable');
    expect(body.outcome.degraded).not.toContain('chat:vision_unsupported');
  });

  it('does not retry text-only when a 4xx is unrelated to image input', async () => {
    const made = await harnessWithImage({
      respond: ({ body }) => (carriesImage(body) ? errorResponse(401, 'Incorrect API key provided') : null)
    });
    h = made.h;

    const body = await sendImage(h, made.mediaId, '看这个');

    expect(h.state.chatCalls.filter((c) => !carriesImage(c.body))).toHaveLength(0);
    expect(body.outcome.degraded).toContain('chat:provider_unavailable');
    expect(body.outcome.degraded).not.toContain('chat:vision_unsupported');
  });

  it('falls back to the provider error note when the text-only retry also fails', async () => {
    const made = await harnessWithImage({
      respond: ({ body }) =>
        carriesImage(body)
          ? errorResponse(400, 'This model does not support image input')
          : errorResponse(503, 'upstream exploded')
    });
    h = made.h;

    const body = await sendImage(h, made.mediaId, '看这个');

    expect(h.state.chatCalls.filter((c) => carriesImage(c.body))).toHaveLength(1);
    expect(h.state.chatCalls.filter((c) => !carriesImage(c.body))).toHaveLength(1);
    expect(body.outcome.degraded).toContain('chat:provider_unavailable');
    expect(body.outcome.degraded).not.toContain('chat:vision_unsupported');
    expect(JSON.stringify(body.reply.content)).toContain('模型服务暂时不可用');
  });

  it('does not retry a text-only turn even if the error mentions images', async () => {
    h = await createHarness({
      chat: { respond: () => errorResponse(400, 'This model does not support image input') }
    });

    const { body } = await sendText(h.app, '在吗', 'vf-text-only');

    expect(h.state.chatCalls).toHaveLength(1);
    expect(body.outcome.degraded).toContain('chat:provider_unavailable');
    expect(body.outcome.degraded).not.toContain('chat:vision_unsupported');
  });

  it('labels history images as unsupported-vision, not as broken files, when the model cannot see', async () => {
    h = await createHarness({ vision: false, chat: { script: [['好。'], ['好的。']] } });
    const form = new FormData();
    form.set('image', new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' }), 'a.png');
    const upload = await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form });
    const mediaId = upload.json().media[0].id as string;
    await h.app.server.inject({
      method: 'POST', url: '/api/messages/sync',
      payload: { clientMsgId: 'vf-novision-1', content: [{ type: 'text', text: '看这个' }, { type: 'image', mediaId }] }
    });
    await sendText(h.app, '那再聊点别的', 'vf-novision-2');

    const lastCall = h.state.chatCalls.at(-1)!;
    const userText = JSON.stringify(lastCall.body);
    expect(userText).toContain('当前模型不支持看图');
    expect(userText).not.toContain('图片未能读取');
  });
});

