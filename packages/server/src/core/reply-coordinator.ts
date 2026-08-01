import type { EventBus } from '../events/bus.js';
import type { MessageRepo } from '../db/repos/message.repo.js';
import type { ReplyBatchRepo, ReplyBatchRow } from '../db/repos/reply-batch.repo.js';
import type { ChatMessage } from './types.js';
import type { ReplyOptions, ReplyOutcome, Replier } from './replier.js';
import { sortableId } from '../util/ids.js';

const LEASE_MS = 120_000;
const LEASE_HEARTBEAT_MS = 30_000;
const MAX_COMPLETION_ATTEMPTS = 3;

export interface ReplyCoordinatorOptions {
  debounceMs?: number;
  messages: MessageRepo;
  batches: ReplyBatchRepo;
  replier: Replier;
  bus: EventBus;
  onCompleted?: (batchId: string, userMessages: ChatMessage[], outcome: ReplyOutcome, owner: string) => void | Promise<void>;
}

interface BatchRuntime {
  options: ReplyOptions;
  waiters: Array<{ resolve: (outcome: ReplyOutcome) => void; reject: (error: unknown) => void }>;
}

/** Serializes durable reply batches while keeping the collection debounce restart-safe. */
export class ReplyCoordinator {
  private readonly debounceMs: number;
  private readonly runtime = new Map<string, BatchRuntime>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly ready: string[] = [];
  private readonly readySet = new Set<string>();
  private running = false;
  private stopped = false;
  private readonly owner = sortableId('reply-worker');

  constructor(private readonly deps: ReplyCoordinatorOptions) {
    const requested = deps.debounceMs ?? 900;
    this.debounceMs = requested === 0 ? 0 : Math.max(500, Math.min(requested, 1500));
  }

  dueAt(now = Date.now()): string {
    return new Date(now + this.debounceMs).toISOString();
  }

  enqueue(batchId: string, options: ReplyOptions): Promise<ReplyOutcome> {
    if (this.stopped) return Promise.reject(new Error('reply coordinator is stopped'));
    const batch = this.deps.batches.get(batchId);
    if (!batch) return Promise.reject(new Error(`reply batch not found: ${batchId}`));
    return new Promise<ReplyOutcome>((resolve, reject) => {
      const current = this.runtime.get(batchId) ?? { options, waiters: [] };
      current.options = options;
      current.waiters.push({ resolve, reject });
      this.runtime.set(batchId, current);
      this.activate(batch);
      const messageIds = this.deps.batches.messageIds(batchId);
      this.deps.bus.publish('reply.queued', { count: messageIds.length, latestMessageId: messageIds.at(-1), batchId });
    });
  }

  /** Re-queues persisted collecting/queued/running work after a process restart. */
  recover(options: ReplyOptions): void {
    for (const batch of this.deps.batches.recoverOpen()) {
      if (!this.runtime.has(batch.id)) this.runtime.set(batch.id, { options, waiters: [] });
      this.activate(batch);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const error = new Error('reply coordinator stopped');
    for (const batch of this.runtime.values()) for (const waiter of batch.waiters) waiter.reject(error);
    this.runtime.clear();
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  private activate(batch: ReplyBatchRow): void {
    const previous = this.timers.get(batch.id);
    if (previous) clearTimeout(previous);
    this.timers.delete(batch.id);
    if (batch.status === 'queued') {
      this.makeReady(batch.id);
      return;
    }
    if (batch.status === 'running') {
      const delay = Math.max(0, Date.parse(batch.lease_expires_at ?? new Date().toISOString()) - Date.now());
      const timer = setTimeout(() => {
        this.timers.delete(batch.id);
        if (this.deps.batches.recoverExpired(batch.id)) {
          this.deps.messages.failInterruptedBatchShell(batch.id);
          this.makeReady(batch.id);
        } else {
          const current = this.deps.batches.get(batch.id);
          if (current) this.activate(current);
        }
      }, delay);
      timer.unref?.();
      this.timers.set(batch.id, timer);
      return;
    }
    if (batch.status !== 'collecting') return;
    const delay = Math.max(0, Date.parse(batch.due_at) - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(batch.id);
      this.deps.batches.markQueued(batch.id);
      this.makeReady(batch.id);
    }, delay);
    timer.unref?.();
    this.timers.set(batch.id, timer);
  }

  private makeReady(batchId: string): void {
    if (!this.readySet.has(batchId)) {
      this.readySet.add(batchId);
      this.ready.push(batchId);
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const batchId = this.ready.shift();
        if (!batchId) break;
        this.readySet.delete(batchId);
        const claimed = this.deps.batches.claim(batchId, this.owner, LEASE_MS);
        if (!claimed) {
          this.observeCompetingWorker(batchId);
          continue;
        }
        const runtime = this.runtime.get(batchId);
        const options = runtime?.options;
        if (!options) {
          if (!this.deps.batches.requeue(batchId, 'reply options unavailable', this.owner)) {
            this.observeCompetingWorker(batchId);
          }
          continue;
        }
        const messages = this.deps.batches.messageIds(batchId)
          .map((id) => this.deps.messages.get(id))
          .filter((message): message is ChatMessage => Boolean(message));
        try {
          let leaseLost = false;
          const heartbeat = setInterval(() => {
            try {
              if (!this.deps.batches.renewLease(batchId, this.owner, LEASE_MS)) leaseLost = true;
            } catch {
              leaseLost = true;
            }
          }, LEASE_HEARTBEAT_MS);
          heartbeat.unref?.();
          const existing = this.deps.messages.findAssistantByBatchId(batchId);
          let outcome: ReplyOutcome;
          try {
            outcome = existing?.status === 'sent'
              ? outcomeFromMessage(existing)
              : await this.deps.replier.replyBatch(messages, options, batchId);
          } finally {
            clearInterval(heartbeat);
          }
          if (leaseLost) {
            this.observeCompetingWorker(batchId);
            continue;
          }
          if (!outcome.ok) {
            this.deps.batches.fail(batchId, outcome.error?.message ?? 'reply failed', this.owner);
            for (const waiter of runtime?.waiters ?? []) waiter.resolve(outcome);
            this.runtime.delete(batchId);
            continue;
          }
          try {
            await this.deps.onCompleted?.(batchId, messages, outcome, this.owner);
          } catch (error) {
            if (claimed.attempts >= MAX_COMPLETION_ATTEMPTS) {
              this.deps.batches.fail(batchId, (error as Error).message, this.owner);
              for (const waiter of runtime?.waiters ?? []) waiter.reject(error);
              this.runtime.delete(batchId);
              continue;
            }
            if (!this.deps.batches.requeue(batchId, (error as Error).message, this.owner)) {
              this.observeCompetingWorker(batchId);
              continue;
            }
            const delay = Math.min(5000, 500 * Math.pow(2, claimed.attempts - 1));
            const timer = setTimeout(() => {
              this.timers.delete(batchId);
              this.makeReady(batchId);
            }, delay);
            timer.unref?.();
            this.timers.set(batchId, timer);
            continue;
          }
          for (const waiter of runtime?.waiters ?? []) waiter.resolve(outcome);
          this.runtime.delete(batchId);
        } catch (error) {
          this.deps.batches.fail(batchId, (error as Error).message, this.owner);
          for (const waiter of runtime?.waiters ?? []) waiter.reject(error);
          this.runtime.delete(batchId);
        }
      }
    } finally {
      this.running = false;
      if (this.ready.length > 0 && !this.stopped) void this.drain();
    }
  }

  private observeCompetingWorker(batchId: string): void {
    const batch = this.deps.batches.get(batchId);
    const runtime = this.runtime.get(batchId);
    if (!runtime) return;
    if (batch?.status === 'completed' && batch.assistant_message_id) {
      const assistant = this.deps.messages.get(batch.assistant_message_id);
      if (assistant) {
        const outcome = outcomeFromMessage(assistant);
        for (const waiter of runtime.waiters) waiter.resolve(outcome);
        this.runtime.delete(batchId);
        return;
      }
    }
    if (!batch || batch.status === 'failed' || batch.status === 'cancelled') {
      const error = new Error(batch?.last_error ?? `reply batch ${batch?.status ?? 'missing'}`);
      for (const waiter of runtime.waiters) waiter.reject(error);
      this.runtime.delete(batchId);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(batchId);
      this.observeCompetingWorker(batchId);
    }, 500);
    timer.unref?.();
    this.timers.set(batchId, timer);
  }
}

function outcomeFromMessage(message: ChatMessage): ReplyOutcome {
  return {
    messageId: message.id,
    ok: true,
    parts: message.content.filter((part) => part.status === 'sent').map((part) => part.type),
    degraded: []
  };
}
