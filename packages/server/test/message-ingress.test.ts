import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, TEST_PNG, type Harness } from './helpers/harness.js';
import type { MessageIngressInput } from '../src/core/message-ingress.js';

let h: Harness;

afterEach(async () => {
  if (h) await h.cleanup();
});

function ingressInput(overrides: Partial<MessageIngressInput>): MessageIngressInput {
  return {
    clientMessageId: `c_${Math.random().toString(36).slice(2)}`,
    source: 'web',
    conversationId: 'main',
    senderId: 'web-user',
    content: [{ type: 'text', text: '你好' }],
    ...overrides
  };
}

describe('MessageIngressService.accept', () => {
  it('ingests a normal message and opens a reply batch', async () => {
    h = await createHarness();
    const result = await h.app.services.ingress.accept(ingressInput({ clientMessageId: 'normal-1', content: [{ type: 'text', text: '在吗' }] }));
    expect(result.duplicate).toBe(false);
    expect(result.replyPending).toBe(true);
    const message = h.app.repos.messages.get(result.messageId)!;
    expect(message.role).toBe('user');
    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toMatchObject({ type: 'text', text: '在吗', status: 'sent' });
    const batch = h.app.repos.replyBatches.findByMessage(result.messageId);
    expect(batch).toBeTruthy();
    expect(h.app.repos.replyBatches.messageIds(batch!.id)).toContain(result.messageId);
  });

  it('treats a repeated clientMessageId as a duplicate without double-inserting', async () => {
    h = await createHarness();
    const first = await h.app.services.ingress.accept(ingressInput({ clientMessageId: 'dup-1', content: [{ type: 'text', text: '重复' }] }));
    const second = await h.app.services.ingress.accept(ingressInput({ clientMessageId: 'dup-1', content: [{ type: 'text', text: '重复' }] }));
    expect(second.duplicate).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(h.app.repos.messages.page(50).messages.filter((m) => m.role === 'user')).toHaveLength(1);
    // No second message.received event may leak past the idempotency layer.
    expect(h.app.repos.events.recent(50).filter((e) => e.type === 'message.received')).toHaveLength(1);
  });

  it('stores replyTo and rejects an unknown reply target', async () => {
    h = await createHarness();
    const first = await h.app.services.ingress.accept(ingressInput({ clientMessageId: 'rt-1', content: [{ type: 'text', text: '第一条' }] }));
    const second = await h.app.services.ingress.accept(
      ingressInput({ clientMessageId: 'rt-2', replyTo: first.messageId, content: [{ type: 'text', text: '引用回复' }] })
    );
    expect(second.duplicate).toBe(false);
    expect(h.app.repos.messages.get(second.messageId)!.replyTo).toBe(first.messageId);

    const bad = h.app.services.ingress.accept(ingressInput({ clientMessageId: 'rt-bad', replyTo: 'missing-id' }));
    await expect(bad).rejects.toMatchObject({ details: { error: 'unknown_reply_target', replyTo: 'missing-id' } });
  });

  it('stores multi-part content in order', async () => {
    h = await createHarness();
    const result = await h.app.services.ingress.accept(
      ingressInput({ clientMessageId: 'multi-1', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] })
    );
    const message = h.app.repos.messages.get(result.messageId)!;
    expect(message.content.map((p) => p.text)).toEqual(['第一段', '第二段']);
  });

  it('accepts an image part backed by uploaded media', async () => {
    h = await createHarness();
    const form = new FormData();
    form.set('image', new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' }), 'a.png');
    const upload = await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form });
    expect(upload.statusCode).toBe(200);
    const mediaId = upload.json().media[0].id;

    const result = await h.app.services.ingress.accept(
      ingressInput({ clientMessageId: 'img-1', content: [{ type: 'text', text: '看' }, { type: 'image', mediaId }] })
    );
    expect(result.duplicate).toBe(false);
    const message = h.app.repos.messages.get(result.messageId)!;
    expect(message.content.map((p) => p.type)).toEqual(['text', 'image']);
    expect(message.content[1].mediaId).toBe(mediaId);
  });

  it('rejects an image whose media does not exist', async () => {
    h = await createHarness();
    const accept = h.app.services.ingress.accept(
      ingressInput({ clientMessageId: 'img-bad', content: [{ type: 'image', mediaId: 'missing-media' }] })
    );
    await expect(accept).rejects.toMatchObject({ details: { error: 'unknown_media', mediaId: 'missing-media' } });
  });

  it('ingests two concurrent messages without losing either', async () => {
    h = await createHarness();
    const [a, b] = await Promise.all([
      h.app.services.ingress.accept(ingressInput({ clientMessageId: 'con-a', content: [{ type: 'text', text: '同时A' }] })),
      h.app.services.ingress.accept(ingressInput({ clientMessageId: 'con-b', content: [{ type: 'text', text: '同时B' }] }))
    ]);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
    expect(a.messageId).not.toBe(b.messageId);
    expect(h.app.repos.messages.page(50).messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('merges rapid messages into a single reply batch', async () => {
    h = await createHarness({ chat: { script: [['合并回复']] } });
    const a = await h.app.services.ingress.accept(ingressInput({ clientMessageId: 'm-a', content: [{ type: 'text', text: '第一条' }] }));
    const b = await h.app.services.ingress.accept(ingressInput({ clientMessageId: 'm-b', content: [{ type: 'text', text: '第二条' }] }));
    expect(b.duplicate).toBe(false);
    const batchA = h.app.repos.replyBatches.findByMessage(a.messageId);
    const batchB = h.app.repos.replyBatches.findByMessage(b.messageId);
    expect(batchA?.id).toBe(batchB?.id);
    expect(h.app.repos.replyBatches.messageIds(batchA!.id)).toEqual(expect.arrayContaining([a.messageId, b.messageId]));
  });

  it('rolls back the whole transaction when a downstream step fails', async () => {
    h = await createHarness({ startWorkers: false });
    const before = h.app.repos.messages.count();
    const original = h.app.repos.replyBatches.appendOrCreateMessage;
    h.app.repos.replyBatches.appendOrCreateMessage = (() => {
      throw new Error('boom');
    }) as typeof original;
    try {
      await expect(h.app.services.ingress.accept(ingressInput({ clientMessageId: 'rb-1' }))).rejects.toThrow('boom');
    } finally {
      h.app.repos.replyBatches.appendOrCreateMessage = original;
    }
    expect(h.app.repos.messages.count()).toBe(before);
    expect(h.app.repos.messages.page(50).messages.filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('parses user directives into stored metadata', async () => {
    h = await createHarness();
    const result = await h.app.services.ingress.accept(
      ingressInput({ clientMessageId: 'dir-1', content: [{ type: 'text', text: '不要发表情' }] })
    );
    expect(h.app.repos.messages.get(result.messageId)!.meta?.directives).toMatchObject({ noSticker: true });
  });

  it('lets explicit directives win over parsed ones', async () => {
    h = await createHarness();
    const result = await h.app.services.ingress.accept(
      ingressInput({
        clientMessageId: 'dir-2',
        content: [{ type: 'text', text: '不要发表情' }],
        metadata: { directives: { noSticker: false } }
      })
    );
    expect(h.app.repos.messages.get(result.messageId)!.meta?.directives).toMatchObject({ noSticker: false });
  });
});

describe('MessageIngressService.acceptAndReply', () => {
  it('waits for a real assistant reply', async () => {
    h = await createHarness({ chat: { script: [['收到']] } });
    const result = await h.app.services.ingress.acceptAndReply(
      ingressInput({ clientMessageId: 'sync-1', content: [{ type: 'text', text: '你好' }] })
    );
    expect(result.duplicate).toBe(false);
    expect(result.outcome?.ok).toBe(true);
    expect(result.reply?.role).toBe('assistant');
    expect(result.reply?.content[0].text).toBe('收到');
  });

  it('returns the existing reply for a duplicate without re-running the model', async () => {
    h = await createHarness({ chat: { script: [['第一次'], ['第二次']] } });
    const first = await h.app.services.ingress.acceptAndReply(
      ingressInput({ clientMessageId: 'sync-dup', content: [{ type: 'text', text: '你好' }] })
    );
    const second = await h.app.services.ingress.acceptAndReply(
      ingressInput({ clientMessageId: 'sync-dup', content: [{ type: 'text', text: '你好' }] })
    );
    expect(second.duplicate).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(second.reply?.id).toBe(first.reply?.id);
    expect(h.state.chatCalls).toHaveLength(1);
  });
});

describe('HTTP contract', () => {
  it('maps ingress validation failures to 400 with the same error shape as before', async () => {
    h = await createHarness();
    const res = await h.app.server.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { clientMsgId: 'x', content: [{ type: 'image', mediaId: 'missing-media' }] }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unknown_media', mediaId: 'missing-media' });
  });

  it('still answers the async endpoint with the documented duplicate shape', async () => {
    h = await createHarness({ chat: { script: [['慢回复']], delayMs: 800 } });
    const post = (clientMsgId: string) =>
      h.app.server.inject({
        method: 'POST',
        url: '/api/messages',
        payload: { clientMsgId, content: [{ type: 'text', text: '你好' }] }
      });
    const first = (await post('http-dup-1')).json() as { message: { id: string }; duplicate: boolean };
    expect(first.duplicate).toBe(false);
    const batch = h.app.repos.replyBatches.findByMessage(first.message.id);
    expect(batch).toBeTruthy();

    const second = (await post('http-dup-1')).json() as { duplicate: boolean; replyPending: boolean; batchId?: string };
    expect(second.duplicate).toBe(true);
    expect(second.replyPending).toBe(true);
    expect(second.batchId).toBe(batch!.id);
  });
});