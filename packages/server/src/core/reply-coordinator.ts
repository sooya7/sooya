import type { EventBus } from '../events/bus.js';
import type { MessageRepo } from '../db/repos/message.repo.js';
import type { ChatMessage } from './types.js';
import type { ReplyOptions, ReplyOutcome, Replier } from './replier.js';

export interface ReplyCoordinatorOptions {
  debounceMs?: number;
  messages: MessageRepo;
  replier: Replier;
  bus: EventBus;
  onCompleted?: (userMessages: ChatMessage[], outcome: ReplyOutcome) => void;
}

interface PendingBatch {
  messages: ChatMessage[];
  options: ReplyOptions;
  waiters: Array<{ resolve: (outcome: ReplyOutcome) => void; reject: (error: unknown) => void }>;
  ready: boolean;
}

/** Debounces rapid user messages without absorbing messages into an active reply. */
export class ReplyCoordinator {
  private readonly debounceMs: number;
  private pending: PendingBatch | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly recovered = new Set<string>();

  constructor(private readonly deps: ReplyCoordinatorOptions) {
    const requested = deps.debounceMs ?? 900;
    // Zero is reserved for deterministic tests. Production values retain the
    // guarded 500-1500ms window so a config mistake cannot disable batching.
    this.debounceMs = requested === 0 ? 0 : Math.max(500, Math.min(requested, 1500));
  }

  enqueue(message: ChatMessage, options: ReplyOptions): Promise<ReplyOutcome> {
    if (this.stopped) return Promise.reject(new Error('reply coordinator is stopped'));
    return new Promise<ReplyOutcome>((resolve, reject) => {
      if (!this.pending) this.pending = { messages: [], options, waiters: [], ready: false };
      this.pending.messages.push(message);
      this.pending.options = options;
      this.pending.waiters.push({ resolve, reject });
      this.pending.ready = false;
      this.schedule();
      this.deps.bus.publish('reply.queued', { count: this.pending.messages.length, latestMessageId: message.id });
    });
  }

  /** Re-queues a trailing user-only tail after a process restart. */
  recover(options: ReplyOptions): void {
    const tail: ChatMessage[] = [];
    for (const message of this.deps.messages.recent(100).reverse()) {
      if (message.role === 'assistant') break;
      if (message.role !== 'user') break;
      if (!this.recovered.has(message.id)) tail.unshift(message);
    }
    if (tail.length === 0) return;
    for (const message of tail) {
      this.recovered.add(message.id);
      void this.enqueue(message, options).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      const error = new Error('reply coordinator stopped');
      for (const waiter of pending.waiters) waiter.reject(error);
    }
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.pending) return;
      this.pending.ready = true;
      void this.drain();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.running || !this.pending?.ready || this.stopped) return;
    const batch = this.pending;
    this.pending = null;
    this.running = true;
    try {
      const outcome = await this.deps.replier.replyBatch(batch.messages, batch.options);
      this.deps.onCompleted?.(batch.messages, outcome);
      for (const waiter of batch.waiters) waiter.resolve(outcome);
    } catch (error) {
      for (const waiter of batch.waiters) waiter.reject(error);
    } finally {
      this.running = false;
      const next = this.pending as PendingBatch | null;
      if (next?.ready) void this.drain();
    }
  }
}
