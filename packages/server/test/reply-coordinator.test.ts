import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/core/types.js';
import { ReplyCoordinator } from '../src/core/reply-coordinator.js';
import type { ReplyBatchRow } from '../src/db/repos/reply-batch.repo.js';
import { createHarness, type Harness } from './helpers/harness.js';

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

describe('ReplyCoordinator', () => {
  it('does not release a collecting batch before the 900ms boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    const row: ReplyBatchRow = {
      id: 'rb_1', conversation_id: 'main', status: 'collecting', trigger_message_id: 'user-1',
      assistant_message_id: null, opened_at: new Date().toISOString(), due_at: new Date(Date.now() + 900).toISOString(),
      started_at: null, completed_at: null, last_error: null, attempts: 0,
      lease_owner: null, lease_expires_at: null, meta_json: '{}'
    };
    const user = message('user-1', 'user');
    const batches = {
      get: vi.fn(() => row),
      messageIds: vi.fn(() => [user.id]),
      markQueued: vi.fn(() => { row.status = 'queued'; return true; }),
      claim: vi.fn(() => row.status === 'queued' ? { ...row, status: 'running' } : undefined),
      fail: vi.fn(), requeue: vi.fn(), renewLease: vi.fn(() => true), recoverExpired: vi.fn(() => false), recoverOpen: vi.fn(() => [])
    };
    const replyBatch = vi.fn(async () => ({ messageId: 'assistant-1', ok: true, parts: ['text'], degraded: [] }));
    coordinator = new ReplyCoordinator({
      messages: { get: vi.fn(() => user), findAssistantByBatchId: vi.fn() } as never,
      batches: batches as never,
      replier: { replyBatch } as never,
      bus: { publish: vi.fn() } as never,
      debounceMs: 900,
      onCompleted: vi.fn()
    });

    const pending = coordinator.enqueue(row.id, options);
    await vi.advanceTimersByTimeAsync(899);
    expect(replyBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(replyBatch).toHaveBeenCalledTimes(1);
  });

  it('recovers a persisted running batch and does not treat a failed shell as a completed reply', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0 });
    const user = harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: 'hello' }] }).message;
    const batch = harness.app.repos.replyBatches.addMessage(user.id, new Date(0).toISOString());
    harness.app.repos.replyBatches.markQueued(batch.id);
    harness.app.repos.replyBatches.claim(batch.id, 'dead-worker', -1);
    harness.app.repos.messages.create({
      role: 'assistant', status: 'failed', replyTo: user.id, parts: [], meta: { batchId: batch.id, batchMessageIds: [user.id] }
    });
    const replyBatch = vi.fn(async (_messages: ChatMessage[], _options: typeof options, batchId: string) => {
      const assistant = harness!.app.repos.messages.create({
        role: 'assistant', status: 'sent', replyTo: user.id,
        parts: [{ type: 'text', text: 'recovered' }], meta: { batchId, batchMessageIds: [user.id] }
      }).message;
      return { messageId: assistant.id, ok: true, parts: ['text'], degraded: [] };
    });
    coordinator = new ReplyCoordinator({
      messages: harness.app.repos.messages,
      batches: harness.app.repos.replyBatches,
      replier: { replyBatch } as never,
      bus: harness.app.services.bus,
      debounceMs: 0,
      onCompleted: (batchId, _messages, outcome, owner) => {
        harness!.app.repos.replyBatches.completeInTransaction(batchId, outcome.messageId, owner);
      }
    });

    coordinator.recover(options);
    await vi.waitFor(() => expect(harness!.app.repos.replyBatches.get(batch.id)?.status).toBe('completed'));

    expect(replyBatch).toHaveBeenCalledTimes(1);
    expect(harness.app.repos.replyBatches.get(batch.id)?.assistant_message_id).toBeTruthy();
  });

  it('marks an ok:false outcome failed without running completion jobs', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0 });
    const user = harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: 'hello' }] }).message;
    const batch = harness.app.repos.replyBatches.addMessage(user.id, new Date(0).toISOString());
    const onCompleted = vi.fn();
    coordinator = new ReplyCoordinator({
      messages: harness.app.repos.messages,
      batches: harness.app.repos.replyBatches,
      replier: { replyBatch: vi.fn(async () => ({ messageId: 'failed-assistant', ok: false, parts: [], degraded: [], error: { incidentId: 'inc_1', code: 'reply_failed', message: '回复失败' } })) } as never,
      bus: harness.app.services.bus,
      debounceMs: 0,
      onCompleted
    });

    const outcome = await coordinator.enqueue(batch.id, options);

    expect(outcome.ok).toBe(false);
    expect(harness.app.repos.replyBatches.get(batch.id)?.status).toBe('failed');
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('resolves a local waiter when another worker wins the claim and completes the batch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    const user = message('user-1', 'user');
    const assistant = message('assistant-1', 'assistant');
    const row: ReplyBatchRow = {
      id: 'rb_competing', conversation_id: 'main', status: 'collecting', trigger_message_id: user.id,
      assistant_message_id: null, opened_at: new Date().toISOString(), due_at: new Date().toISOString(),
      started_at: null, completed_at: null, last_error: null, attempts: 0,
      lease_owner: null, lease_expires_at: null, meta_json: '{}'
    };
    const batches = {
      get: vi.fn(() => row), messageIds: vi.fn(() => [user.id]),
      markQueued: vi.fn(() => { row.status = 'queued'; return true; }),
      claim: vi.fn(() => { row.status = 'running'; return undefined; }),
      fail: vi.fn(), requeue: vi.fn(), renewLease: vi.fn(), recoverExpired: vi.fn(), recoverOpen: vi.fn(() => [])
    };
    coordinator = new ReplyCoordinator({
      messages: { get: vi.fn((id: string) => id === assistant.id ? assistant : user), findAssistantByBatchId: vi.fn(), failInterruptedBatchShell: vi.fn() } as never,
      batches: batches as never,
      replier: { replyBatch: vi.fn() } as never,
      bus: { publish: vi.fn() } as never,
      debounceMs: 0
    });

    const pending = coordinator.enqueue(row.id, options);
    await vi.advanceTimersByTimeAsync(0);
    row.status = 'completed';
    row.assistant_message_id = assistant.id;
    await vi.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toMatchObject({ messageId: assistant.id, ok: true });
  });
});

function message(id: string, role: 'user' | 'assistant'): ChatMessage {
  return {
    id, conversationId: 'main', role, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    seq: 1, status: 'sent', content: [{ id: `${id}-part`, type: 'text', text: id, status: 'sent' }]
  };
}
