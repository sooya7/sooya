import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/core/types.js';
import { ReplyCoordinator } from '../src/core/reply-coordinator.js';
import type { ReplyBatchRow } from '../src/db/repos/reply-batch.repo.js';
import type { GenerationOptions, TextGenerationResult } from '../src/core/replier.js';
import { HttpTimeoutError } from '../src/util/http.js';
import { abortableDelay, StaleGenerationError } from '../src/util/abort.js';
import { createHarness, type Harness } from './helpers/harness.js';
import { resolveVisualTime } from '../src/core/visual-time.js';

const options = { recentMessages: 24, memoryLimit: 8 };
let harness: Harness | undefined;
let coordinator: ReplyCoordinator | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await coordinator?.stop();
  await harness?.cleanup();
  coordinator = undefined;
  harness = undefined;
});

function textResult(overrides: Partial<TextGenerationResult> = {}): TextGenerationResult {
  return {
    text: '回复内容',
    rawText: '回复内容',
    directives: {},
    degraded: [],
    contextBudget: {},
    firstTokenAt: null,
    published: false,
    visualTime: resolveVisualTime({ now: '2026-08-26T05:17:23.000Z' }),
    mediaPlan: {
      sticker: false,
      stickers: [],
      stickerRequired: false,
      stickerOnly: false,
      forceDifferent: false,
      imagePrompt: null,
      selfImagePrompt: null,
      voice: false,
      voiceOnly: false
    },
    worldSnapshot: null,
    ...overrides
  };
}

/** A replier stub whose two phases are controllable per test. */
function stubReplier(overrides: {
  generateText?: (messages: ChatMessage[], opts: GenerationOptions) => Promise<TextGenerationResult>;
  publishGeneratedReply?: (batch: { id: string; revision: number }, messages: ChatMessage[], generated: TextGenerationResult, opts: { signal: AbortSignal; owner: string; beginPublish: () => Promise<boolean> }) => Promise<{ messageId: string; ok: boolean; parts: string[]; degraded: string[] }>;
} = {}) {
  return {
    generateText: overrides.generateText ?? (async () => textResult({ published: true })),
    publishGeneratedReply: overrides.publishGeneratedReply ?? (async (_batch, _messages, _generated, opts) => {
      // The real replier opens the publish barrier before persisting anything.
      const won = await opts.beginPublish();
      if (!won) throw new StaleGenerationError('publish barrier lost');
      return { messageId: 'assistant-1', ok: true, parts: ['text'], degraded: [] };
    })
  } as never;
}

/** A mocked ReplyBatchRepo with every method the coordinator touches. */
function mockBatches(row: ReplyBatchRow) {
  const batches: Record<string, ReturnType<typeof vi.fn>> = {
    get: vi.fn(() => row),
    messageIds: vi.fn(() => []),
    markQueued: vi.fn(() => { row.status = 'queued'; return true; }),
    beginGenerating: vi.fn(() => { row.status = 'generating'; return { ...row }; }),
    renewLease: vi.fn(() => true),
    recordGeneration: vi.fn(),
    complete: vi.fn(() => { row.status = 'completed'; return true; }),
    fail: vi.fn(() => { row.status = 'failed'; }),
    requeue: vi.fn(() => true),
    prepareRetry: vi.fn(() => { row.status = 'queued'; return { ...row }; }),
    incrementRetry: vi.fn(() => true),
    recoverOpen: vi.fn(() => []),
    recoverExpired: vi.fn(() => false),
    retry: vi.fn(),
    beginPublishing: vi.fn(() => true),
    isCurrentRevision: vi.fn(() => true),
    supersedeIfOpen: vi.fn(() => true),
    markSuperseded: vi.fn(),
    appendOrCreateMessage: vi.fn()
  };
  return batches as never;
}

describe('ReplyCoordinator — debounce & collection', () => {
  it('releases a collecting batch only after the initial debounce and starts the generation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    const user = message('user-1', 'user');
    const row: ReplyBatchRow = {
      id: 'rb_1', conversation_id: 'main', status: 'collecting', trigger_message_id: user.id,
      assistant_message_id: null, opened_at: new Date().toISOString(), due_at: new Date(Date.now() + 200).toISOString(),
      started_at: null, completed_at: null, last_error: null, attempts: 0,
      lease_owner: null, lease_expires_at: null, meta_json: '{}', revision: 1, last_message_at: null,
      generation_started_at: null, publish_started_at: null, visible_at: null,
      retry_count: 0, interrupted_count: 0, superseded_at: null, failure_code: null
    };
    const batches = mockBatches(row);
    (batches as unknown as { messageIds: ReturnType<typeof vi.fn> }).messageIds.mockReturnValue([user.id]);
    const generateText = vi.fn(async () => textResult({ published: true }));
    coordinator = new ReplyCoordinator({
      messages: { get: vi.fn(() => user), findAssistantByBatchId: vi.fn() } as never,
      batches,
      replier: stubReplier({ generateText }),
      bus: { publish: vi.fn(), persist: vi.fn(() => ({ type: 'reply.completed' })), fanout: vi.fn() } as never,
      initialDebounceMs: 200,
      onCompleted: vi.fn()
    });

    const pending = coordinator.enqueue(row.id, options);
    await vi.advanceTimersByTimeAsync(199);
    expect(generateText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('caps the total collection window with maxCollectionMs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    const user = message('user-1', 'user');
    // due_at is far in the future, but maxCollectionMs (4000ms) must win.
    const row: ReplyBatchRow = {
      id: 'rb_cap', conversation_id: 'main', status: 'collecting', trigger_message_id: user.id,
      assistant_message_id: null, opened_at: new Date().toISOString(), due_at: new Date(Date.now() + 60_000).toISOString(),
      started_at: null, completed_at: null, last_error: null, attempts: 0,
      lease_owner: null, lease_expires_at: null, meta_json: '{}', revision: 1, last_message_at: null,
      generation_started_at: null, publish_started_at: null, visible_at: null,
      retry_count: 0, interrupted_count: 0, superseded_at: null, failure_code: null
    };
    const batches = mockBatches(row);
    (batches as unknown as { messageIds: ReturnType<typeof vi.fn> }).messageIds.mockReturnValue([user.id]);
    const generateText = vi.fn(async () => textResult({ published: true }));
    coordinator = new ReplyCoordinator({
      messages: { get: vi.fn(() => user), findAssistantByBatchId: vi.fn() } as never,
      batches,
      replier: stubReplier({ generateText }),
      bus: { publish: vi.fn(), persist: vi.fn(() => ({ type: 'reply.completed' })), fanout: vi.fn() } as never,
      initialDebounceMs: 200,
      maxCollectionMs: 4000,
      onCompleted: vi.fn()
    });

    const pending = coordinator.enqueue(row.id, options);
    await vi.advanceTimersByTimeAsync(3999);
    expect(generateText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('duplicate client messages never bump the revision', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0 });
    const first = harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '第一条' }] }).message;
    const admission = harness.app.repos.replyBatches.appendOrCreateMessage(first.id, new Date(Date.now() + 1000).toISOString(), new Date(Date.now() + 500).toISOString());
    expect(admission.action).toBe('created');
    expect(admission.revision).toBe(1);
    const duplicate = harness.app.repos.replyBatches.appendOrCreateMessage(first.id, new Date(Date.now() + 1000).toISOString(), new Date(Date.now() + 500).toISOString());
    expect(duplicate.action).toBe('appended');
    expect(duplicate.revision).toBe(1);
  });
});

describe('ReplyCoordinator — interrupt & revision fencing', () => {
  it('interrupts a hidden generation on a new message and restarts it on the new revision', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0 });
    const app = harness.app;
    const user1 = app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '第一条' }] }).message;
    const admission = app.repos.replyBatches.appendOrCreateMessage(user1.id, new Date(0).toISOString(), new Date(0).toISOString());
    const batchId = admission.batch.id;
    app.repos.replyBatches.markQueued(batchId);

    const calls: string[] = [];
    const generateText = vi.fn(async (_messages: ChatMessage[], opts: GenerationOptions) => {
      calls.push(`start:${opts.revision}`);
      await abortableDelay(60_000, opts.signal);
      return textResult({ published: true });
    });
    coordinator = new ReplyCoordinator({
      messages: app.repos.messages,
      batches: app.repos.replyBatches,
      replier: stubReplier({ generateText }),
      bus: app.services.bus,
      interruptDebounceMs: 300,
      onCompleted: vi.fn()
    });
    coordinator.recover(options);
    await vi.waitFor(() => expect(calls).toEqual(['start:1']));

    // A second message while revision 1 is hidden: interrupt + revision bump.
    const user2 = app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '第二条' }] }).message;
    const second = app.repos.replyBatches.appendOrCreateMessage(user2.id, new Date(Date.now() + 300).toISOString(), new Date(Date.now() + 300).toISOString());
    expect(second.action).toBe('interrupt');
    expect(second.revision).toBe(2);
    await coordinator.onMessageAccepted('interrupt', batchId, options);

    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    expect(calls[1]).toBe('start:2');
    expect(app.repos.replyBatches.get(batchId)?.revision).toBe(2);
  });

  it('a generation that loses the publish barrier publishes nothing (stale revision)', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0 });
    const app = harness.app;
    const user = app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '第一条' }] }).message;
    const admission = app.repos.replyBatches.appendOrCreateMessage(user.id, new Date(0).toISOString(), new Date(0).toISOString());
    const batchId = admission.batch.id;
    app.repos.replyBatches.markQueued(batchId);

    const publishGeneratedReply = vi.fn(async (_batch: { id: string; revision: number }, _messages: ChatMessage[], _generated: TextGenerationResult, opts: { beginPublish: () => Promise<boolean> }) => {
      const won = await opts.beginPublish();
      if (!won) throw new StaleGenerationError('publish barrier lost');
      return { messageId: 'assistant-1', ok: true, parts: [], degraded: [] };
    });
    coordinator = new ReplyCoordinator({
      messages: app.repos.messages,
      batches: app.repos.replyBatches,
      replier: stubReplier({
        // While the generation is in flight, a competing worker supersedes
        // this revision — the publish fence must then refuse it.
        generateText: async () => {
          app.repos.replyBatches.markSuperseded(batchId, 1, 'superseded by test');
          return textResult({ published: false });
        },
        publishGeneratedReply: publishGeneratedReply as never
      }),
      bus: app.services.bus,
      onCompleted: vi.fn()
    });
    coordinator.recover(options);
    await vi.waitFor(() => expect(publishGeneratedReply).toHaveBeenCalled(), { timeout: 5000 });
    const row = app.repos.replyBatches.get(batchId)!;
    // revision 1 must not complete or attach a message.
    expect(row.assistant_message_id).toBeNull();
    expect(row.status).toBe('superseded');
  });
});

describe('ReplyCoordinator — timeout retry (B1)', () => {
  it('a timeout is retried once with a real second provider call, then succeeds', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0 });
    const app = harness.app;
    const user = app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '你好' }] }).message;
    const admission = app.repos.replyBatches.appendOrCreateMessage(user.id, new Date(0).toISOString(), new Date(0).toISOString());
    const batchId = admission.batch.id;
    app.repos.replyBatches.markQueued(batchId);

    let calls = 0;
    const generateText = vi.fn(async (_messages: ChatMessage[], opts: GenerationOptions) => {
      calls++;
      if (calls === 1) throw new HttpTimeoutError('first attempt timed out');
      return textResult({ published: true });
    });
    const publishGeneratedReply = vi.fn(async (_batch: { id: string; revision: number }, _messages: ChatMessage[], _generated: TextGenerationResult, opts: { beginPublish: () => Promise<boolean> }) => {
      const won = await opts.beginPublish();
      if (!won) throw new StaleGenerationError('publish barrier lost');
      const assistant = app.repos.messages.create({
        role: 'assistant', status: 'sent', replyTo: user.id, batchId,
        parts: [{ type: 'text', text: '重试后的回复' }], meta: { batchId, batchMessageIds: [user.id] }
      }).message;
      return { messageId: assistant.id, ok: true, parts: ['text'], degraded: [] };
    });
    coordinator = new ReplyCoordinator({
      messages: app.repos.messages,
      batches: app.repos.replyBatches,
      replier: stubReplier({ generateText, publishGeneratedReply: publishGeneratedReply as never }),
      bus: app.services.bus,
      timeoutRetries: 1,
      retryBaseDelayMs: 50,
      onCompleted: vi.fn()
    });
    coordinator.recover(options);

    await vi.waitFor(() => expect(app.repos.replyBatches.get(batchId)?.status).toBe('completed'), { timeout: 5000 });
    expect(calls).toBe(2);
    expect(app.repos.replyBatches.get(batchId)?.retry_count).toBe(1);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('a second timeout fails the batch exactly once (one failure card)', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0 });
    const app = harness.app;
    const user = app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '你好' }] }).message;
    const admission = app.repos.replyBatches.appendOrCreateMessage(user.id, new Date(0).toISOString(), new Date(0).toISOString());
    const batchId = admission.batch.id;
    app.repos.replyBatches.markQueued(batchId);

    const failedEvents: unknown[] = [];
    const publish = vi.fn((type: string, payload: unknown) => {
      if (type === 'reply.failed') failedEvents.push(payload);
    });
    const persist = vi.fn((type: string, payload: unknown) => {
      if (type === 'reply.failed') failedEvents.push(payload);
      return { type, payload };
    });
    const generateText = vi.fn(async () => { throw new HttpTimeoutError('always times out'); });
    coordinator = new ReplyCoordinator({
      messages: app.repos.messages,
      batches: app.repos.replyBatches,
      replier: stubReplier({ generateText }),
      bus: { publish, persist, fanout: vi.fn() } as never,
      timeoutRetries: 1,
      retryBaseDelayMs: 20,
      onCompleted: vi.fn()
    });
    coordinator.recover(options);

    await vi.waitFor(() => expect(app.repos.replyBatches.get(batchId)?.status).toBe('failed'), { timeout: 5000 });
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(failedEvents).toHaveLength(1);
    expect(app.repos.replyBatches.get(batchId)?.failure_code).toBe('model_timeout');
  });
});

describe('ReplyCoordinator — partial publication (B2)', () => {
  it('content published before a provider error completes as partial, never failed', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0 });
    const app = harness.app;
    const user = app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '你好' }] }).message;
    const admission = app.repos.replyBatches.appendOrCreateMessage(user.id, new Date(0).toISOString(), new Date(0).toISOString());
    const batchId = admission.batch.id;
    app.repos.replyBatches.markQueued(batchId);

    // Phase 1 opens the barrier (publishing) with visible text, then dies.
    const generateText = vi.fn(async (_messages: ChatMessage[], opts: GenerationOptions) => {
      const won = await opts.beginPublish();
      if (!won) throw new StaleGenerationError('barrier lost');
      const shell = app.repos.messages.create({
        role: 'assistant', status: 'sending', replyTo: user.id, batchId,
        parts: [{ type: 'text', text: '部分内容', status: 'pending' }], meta: { batchId, batchMessageIds: [user.id] }
      }).message;
      throw new HttpTimeoutError('provider died after visible text');
    });
    const partialEvents: unknown[] = [];
    const publish = vi.fn((type: string, payload: unknown) => {
      if (type === 'reply.publishing.partial') partialEvents.push(payload);
    });
    const persist = vi.fn((type: string, payload: unknown) => ({ type, payload }));
    coordinator = new ReplyCoordinator({
      messages: app.repos.messages,
      batches: app.repos.replyBatches,
      replier: stubReplier({ generateText }),
      bus: { publish, persist, fanout: vi.fn() } as never,
      timeoutRetries: 1,
      onCompleted: vi.fn()
    });
    coordinator.recover(options);

    await vi.waitFor(() => expect(app.repos.replyBatches.get(batchId)?.status).toBe('completed'), { timeout: 5000 });
    const row = app.repos.replyBatches.get(batchId)!;
    expect(row.assistant_message_id).toBeTruthy();
    const meta = JSON.parse(row.meta_json) as { partial?: number };
    expect(meta.partial).toBe(1);
    expect(partialEvents).toHaveLength(1);
    // Published text must stay: the shell is sent, not failed.
    const shell = app.repos.messages.get(row.assistant_message_id!)!;
    expect(shell.status).toBe('sent');
  });
});

describe('ReplyCoordinator — restart recovery', () => {
  it('recovers an in-flight generating batch as queued and regenerates it', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0 });
    const app = harness.app;
    const user = app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '你好' }] }).message;
    const admission = app.repos.replyBatches.appendOrCreateMessage(user.id, new Date(0).toISOString(), new Date(0).toISOString());
    const batchId = admission.batch.id;
    app.repos.replyBatches.markQueued(batchId);
    // A dead worker held the generation with an expired lease.
    app.repos.replyBatches.beginGenerating(batchId, 1, 'dead-worker', -1);

    const generateText = vi.fn(async () => textResult({ published: true }));
    const publishGeneratedReply = vi.fn(async (_batch: { id: string; revision: number }, _messages: ChatMessage[], _generated: TextGenerationResult, opts: { beginPublish: () => Promise<boolean> }) => {
      const won = await opts.beginPublish();
      if (!won) throw new StaleGenerationError('publish barrier lost');
      const assistant = app.repos.messages.create({
        role: 'assistant', status: 'sent', replyTo: user.id, batchId,
        parts: [{ type: 'text', text: '恢复后的回复' }], meta: { batchId, batchMessageIds: [user.id] }
      }).message;
      return { messageId: assistant.id, ok: true, parts: ['text'], degraded: [] };
    });
    coordinator = new ReplyCoordinator({
      messages: app.repos.messages,
      batches: app.repos.replyBatches,
      replier: stubReplier({ generateText, publishGeneratedReply: publishGeneratedReply as never }),
      bus: app.services.bus,
      onCompleted: vi.fn()
    });
    coordinator.recover(options);

    await vi.waitFor(() => expect(generateText).toHaveBeenCalled(), { timeout: 5000 });
    await vi.waitFor(() => expect(app.repos.replyBatches.get(batchId)?.status).toBe('completed'), { timeout: 8000 });
    const row = app.repos.replyBatches.get(batchId)!;
    // The recovered batch was claimed again (attempts bumped past the dead
    // worker's claim) and ran to completion.
    expect(row.attempts).toBeGreaterThanOrEqual(2);
    expect(row.assistant_message_id).toBeTruthy();
  });

  it('a publishing batch with visible text is kept as completed/partial on recovery', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0 });
    const app = harness.app;
    const user = app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '你好' }] }).message;
    const admission = app.repos.replyBatches.appendOrCreateMessage(user.id, new Date(0).toISOString(), new Date(0).toISOString());
    const batchId = admission.batch.id;
    app.repos.replyBatches.markQueued(batchId);
    const shell = app.repos.messages.create({
      role: 'assistant', status: 'sending', replyTo: user.id, batchId,
      parts: [{ type: 'text', text: '已发布内容', status: 'sent' }], meta: { batchId, batchMessageIds: [user.id] }
    }).message;
    app.repos.replyBatches.beginGenerating(batchId, 1, 'dead-worker', -1);
    app.repos.replyBatches.beginPublishing(batchId, 1, 'dead-worker');

    coordinator = new ReplyCoordinator({
      messages: app.repos.messages,
      batches: app.repos.replyBatches,
      replier: stubReplier(),
      bus: app.services.bus,
      onCompleted: vi.fn()
    });
    coordinator.recover(options);

    await vi.waitFor(() => expect(app.repos.replyBatches.get(batchId)?.status).toBe('completed'), { timeout: 5000 });
    const row = app.repos.replyBatches.get(batchId)!;
    expect(row.assistant_message_id).toBe(shell.id);
    expect(JSON.parse(row.meta_json) as { partial?: number }).toMatchObject({ partial: 1 });
  });
});

function message(id: string, role: 'user' | 'assistant'): ChatMessage {
  return {
    id, conversationId: 'main', role, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    seq: 1, status: 'sent', content: [{ id: `${id}-part`, type: 'text', text: id, status: 'sent' }]
  };
}
