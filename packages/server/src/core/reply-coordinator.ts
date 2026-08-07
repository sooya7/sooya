import type { EventBus } from '../events/bus.js';
import type { MessageRepo } from '../db/repos/message.repo.js';
import type { ErrorLogRepo } from '../db/repos/misc.repo.js';
import type { ReplyBatchRepo, ReplyBatchRow, AppendAction } from '../db/repos/reply-batch.repo.js';
import type { ChatMessage, ReplyFailure } from './types.js';
import type { ReplyOptions, ReplyOutcome, Replier } from './replier.js';
import type { PublicFailure } from './public-error.js';
import { sortableId } from '../util/ids.js';
import { abortableDelay, isBenignAbort, StaleGenerationError, UserInterruptedError } from '../util/abort.js';
import { HttpTimeoutError } from '../util/http.js';

const LEASE_MS = 120_000;
const LEASE_HEARTBEAT_MS = 30_000;

export interface AcceptUserMessageResult {
  batchId: string;
  revision: number;
  action: AppendAction;
}

export interface ReplyCoordinatorOptions {
  initialDebounceMs?: number;
  interruptDebounceMs?: number;
  maxCollectionMs?: number;
  publishGraceMs?: number;
  requestTimeoutMs?: number;
  timeoutRetries?: number;
  retryBaseDelayMs?: number;
  interruptible?: boolean;
  messages: MessageRepo;
  batches: ReplyBatchRepo;
  replier: Replier;
  bus: EventBus;
  errorLog?: ErrorLogRepo;
  onCompleted?: (
    batchId: string,
    userMessages: ChatMessage[],
    outcome: ReplyOutcome,
    owner: string,
    revision: number
  ) => void | Promise<void>;
}

interface BatchRuntime {
  options: ReplyOptions;
  waiters: Array<{ resolve: (outcome: ReplyOutcome) => void; reject: (error: unknown) => void }>;
}

interface ActiveGeneration {
  batchId: string;
  revision: number;
  controller: AbortController;
  startedAt: number;
  attempt: number;
  published: boolean;
  firstTokenAt: number | null;
}

/**
 * Serializes durable reply batches and owns the interruptible generation
 * lifecycle:
 *
 *   collecting → queued → generating → publishing → completed
 *                                ↘ superseded (benign, no failure UI)
 *
 * The publish barrier (`visible_at`) is the single line between "a newer
 * message may silently replace this" and "this reply is out for good".
 * Revision fencing in the database decides every race — aborting the HTTP
 * request is only an optimization.
 */
export class ReplyCoordinator {
  private readonly initialDebounceMs: number;
  private readonly interruptDebounceMs: number;
  private readonly maxCollectionMs: number;
  private readonly publishGraceMs: number;
  private readonly requestTimeoutMs: number;
  private readonly timeoutRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly interruptible: boolean;

  private readonly runtime = new Map<string, BatchRuntime>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly ready: string[] = [];
  private readonly readySet = new Set<string>();
  private readonly activeGenerations = new Map<string, ActiveGeneration>();
  /** Abort handles for timeout-retry backoffs, which outlive their active generation entry. */
  private readonly retryControllers = new Map<string, AbortController>();
  private running = false;
  private stopped = false;
  private readonly owner = sortableId('reply-worker');

  constructor(private readonly deps: ReplyCoordinatorOptions) {
    this.initialDebounceMs = deps.initialDebounceMs ?? 200;
    this.interruptDebounceMs = deps.interruptDebounceMs ?? 300;
    this.maxCollectionMs = deps.maxCollectionMs ?? 4000;
    this.publishGraceMs = deps.publishGraceMs ?? 600;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 45_000;
    this.timeoutRetries = deps.timeoutRetries ?? 1;
    this.retryBaseDelayMs = deps.retryBaseDelayMs ?? 600;
    this.interruptible = deps.interruptible ?? true;
  }

  dueAt(now = Date.now(), interrupt = false): string {
    const delay = interrupt ? this.interruptDebounceMs : this.initialDebounceMs;
    return new Date(now + delay).toISOString();
  }

  /**
   * Route-side admission hook. The transaction already appended the message to
   * a batch (see ReplyBatchRepo.appendOrCreateMessage); this reacts to the
   * action: abort hidden generations, reschedule with the right debounce.
   */
  async onMessageAccepted(action: AppendAction, batchId: string, options: ReplyOptions): Promise<void> {
    const batch = this.deps.batches.get(batchId);
    if (!batch) return;
    const runtime = this.runtime.get(batchId) ?? { options, waiters: [] };
    runtime.options = options;
    this.runtime.set(batchId, runtime);

    if (action === 'interrupt') {
      this.interruptGeneration(batchId, 'new_user_message');
      this.deps.bus.publish('reply.generation.interrupted', {
        batchId,
        revision: batch.revision,
        reason: 'new_user_message'
      });
      this.schedule(batch, true);
      return;
    }
    if (action === 'next_batch') {
      this.deps.bus.publish('reply.batch.collecting', {
        batchId,
        revision: batch.revision,
        messageCount: this.deps.batches.messageIds(batchId).length
      });
    }
    this.schedule(batch, false);
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
      this.schedule(batch, false);
    });
  }

  /** Re-queues persisted open work after a process restart. */
  recover(options: ReplyOptions): void {
    for (const batch of this.deps.batches.recoverOpen()) {
      if (!this.runtime.has(batch.id)) this.runtime.set(batch.id, { options, waiters: [] });
      this.schedule(batch, false);
    }
  }

  /** Explicit user retry (failed / partial batches). */
  async retryBatch(batchId: string): Promise<ReplyBatchRow | undefined> {
    const batch = this.deps.batches.retry(batchId);
    if (!batch) return undefined;
    const options = this.runtime.get(batchId)?.options ?? { recentMessages: 24, memoryLimit: 8 };
    const runtime = this.runtime.get(batchId) ?? { options, waiters: [] };
    runtime.options = options;
    this.runtime.set(batchId, runtime);
    this.deps.bus.publish('reply.batch.queued', { batchId, revision: batch.revision });
    this.schedule(batch, false);
    return batch;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const batchId of [...this.activeGenerations.keys()]) {
      this.interruptGeneration(batchId, 'shutdown');
    }
    for (const controller of this.retryControllers.values()) controller.abort(new UserInterruptedError('coordinator shutdown'));
    this.retryControllers.clear();
    const error = new Error('reply coordinator stopped');
    for (const [batchId, runtime] of this.runtime) {
      for (const waiter of runtime.waiters) waiter.reject(error);
      this.runtime.delete(batchId);
    }
  }

  private schedule(batch: ReplyBatchRow, interrupted: boolean): void {
    if (this.stopped) return;
    const existing = this.timers.get(batch.id);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(batch.id);
    }
    if (batch.status === 'collecting') {
      const due = Date.parse(batch.due_at);
      const now = Date.now();
      // Max collection caps the TOTAL time this batch has been collecting,
      // not just the current debounce window.
      const sinceOpen = now - Date.parse(batch.opened_at);
      const capLeft = Math.max(0, this.maxCollectionMs - sinceOpen);
      const delay = Math.max(0, Math.min(due - now, capLeft));
      const timer = setTimeout(() => {
        this.timers.delete(batch.id);
        if (this.deps.batches.markQueued(batch.id)) {
          const row = this.deps.batches.get(batch.id);
          if (row) this.deps.bus.publish('reply.batch.queued', { batchId: row.id, revision: row.revision });
        }
        this.makeReady(batch.id);
      }, delay);
      timer.unref?.();
      this.timers.set(batch.id, timer);
      return;
    }
    if (batch.status === 'queued') {
      this.makeReady(batch.id);
      return;
    }
    if (batch.status === 'generating') {
      return;
    }
    if (batch.status === 'publishing') {
      this.observeActive(batch.id);
      return;
    }
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
        const batch = this.deps.batches.get(batchId);
        if (!batch || batch.status !== 'queued') continue;
        if (!this.interruptible) {
          const claimed = this.deps.batches.beginGenerating(batchId, batch.revision, this.owner, LEASE_MS);
          if (!claimed) continue;
          void this.runLegacyGeneration(batchId, claimed.revision);
          continue;
        }
        await this.startGeneration(batchId, batch.revision, false);
      }
    } finally {
      this.running = false;
      if (this.ready.length > 0 && !this.stopped) void this.drain();
    }
  }

  private async startGeneration(batchId: string, revision: number, isRetry: boolean): Promise<void> {
    const batch = this.deps.batches.beginGenerating(batchId, revision, this.owner, LEASE_MS);
    if (!batch) return;
    const startedAt = Date.now();
    const controller = new AbortController();
    const active: ActiveGeneration = {
      batchId,
      revision,
      controller,
      startedAt,
      attempt: batch.attempts,
      published: false,
      firstTokenAt: null
    };
    this.activeGenerations.set(batchId, active);

    if (isRetry) {
      this.deps.bus.publish('reply.generation.retrying', { batchId, revision, attempt: batch.attempts });
    } else {
      this.deps.bus.publish('reply.generation.started', { batchId, revision, attempt: batch.attempts });
    }
    this.deps.batches.recordGeneration({
      batchId,
      revision,
      attempt: batch.attempts,
      status: 'started',
      startedAt: new Date(startedAt).toISOString()
    });

    const runtime = this.runtime.get(batchId);
    const options = runtime?.options ?? { recentMessages: 24, memoryLimit: 8 };
    const userMessages = this.deps.batches.messageIds(batchId)
      .map((id) => this.deps.messages.get(id))
      .filter((message): message is ChatMessage => Boolean(message));

    const heartbeat = setInterval(() => {
      try {
        if (!this.deps.batches.renewLease(batchId, this.owner, LEASE_MS)) controller.abort(new StaleGenerationError('lease lost'));
      } catch {
        controller.abort(new StaleGenerationError('lease heartbeat failed'));
      }
    }, LEASE_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      const generated = await this.deps.replier.generateText(userMessages, {
        recentMessages: options.recentMessages,
        memoryLimit: options.memoryLimit,
        signal: controller.signal,
        batchId,
        revision,
        owner: this.owner,
        publishGraceMs: this.publishGraceMs,
        requestTimeoutMs: this.requestTimeoutMs,
        beginPublish: async () => {
          const won = this.deps.batches.beginPublishing(batchId, revision, this.owner);
          if (won) active.published = true;
          return won;
        }
      });

      const outcome = await this.deps.replier.publishGeneratedReply(batch, userMessages, generated, {
        signal: controller.signal,
        owner: this.owner,
        beginPublish: async () => {
          const won = this.deps.batches.beginPublishing(batchId, revision, this.owner);
          if (won) active.published = true;
          return won;
        }
      });

      clearInterval(heartbeat);
      this.activeGenerations.delete(batchId);
      this.deps.batches.recordGeneration({
        batchId,
        revision,
        attempt: batch.attempts,
        status: 'completed',
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        firstTokenMs: generated.firstTokenAt !== null ? generated.firstTokenAt - startedAt : null,
        visibleMs: active.published ? Math.max(0, Date.now() - startedAt) : null
      });

      if (!outcome.ok) {
        this.deps.batches.fail(batchId, revision, outcome.error?.code ?? 'internal_error', outcome.error?.message ?? 'reply failed', this.owner);
        this.publishFailure(batchId, revision, toReplyFailureFromPublic(outcome.error, batchId, revision));
        for (const waiter of runtime?.waiters ?? []) waiter.resolve(outcome);
        this.runtime.delete(batchId);
        return;
      }
      const partial = generated.interrupted !== undefined;
      if (!this.deps.batches.complete(batchId, revision, outcome.messageId, this.owner, partial)) {
        this.deps.bus.publish('reply.superseded', { batchId, revision });
        for (const waiter of runtime?.waiters ?? []) waiter.reject(new StaleGenerationError('batch completed by competing worker'));
        this.runtime.delete(batchId);
        return;
      }
      try {
        await this.deps.onCompleted?.(batchId, userMessages, outcome, this.owner, revision);
      } catch (error) {
        // The batch is already completed. Post-processing (memory/push/summary/
        // life bridge) runs as durable jobs with their own retries, so a hook
        // failure must never requeue the batch — that would re-run the model
        // and could publish a second reply.
        this.deps.errorLog?.add('reply.completion', 'post_processing_failed', {
          batchId,
          revision,
          message: (error as Error).message ?? String(error)
        });
      }
      this.deps.bus.publish('reply.completed', {
        batchId,
        revision,
        messageId: outcome.messageId,
        message: this.deps.messages.get(outcome.messageId),
        partial
      });
      for (const waiter of runtime?.waiters ?? []) waiter.resolve(outcome);
      this.runtime.delete(batchId);
    } catch (error) {
      clearInterval(heartbeat);
      this.activeGenerations.delete(batchId);
      await this.handleGenerationFailure(batchId, revision, active, runtime, startedAt, error, userMessages);
    }
  }

  private async handleGenerationFailure(
    batchId: string,
    revision: number,
    active: ActiveGeneration,
    runtime: BatchRuntime | undefined,
    startedAt: number,
    error: unknown,
    userMessages: ChatMessage[]
  ): Promise<void> {
    const batch = this.deps.batches.get(batchId);
    if (isBenignAbort(error)) {
      this.deps.batches.recordGeneration({
        batchId, revision, attempt: active.attempt, status: 'superseded',
        startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
        interruptionReason: (error as Error).name, durationMs: Date.now() - startedAt
      });
      if (batch && batch.revision === revision && batch.status === 'generating') {
        this.deps.batches.requeue(batchId, revision, 'interrupted', this.owner);
        if (!this.stopped) {
          const timer = setTimeout(() => {
            this.timers.delete(batchId);
            this.makeReady(batchId);
          }, this.interruptDebounceMs);
          timer.unref?.();
          this.timers.set(batchId, timer);
        }
      }
      return;
    }

    const isTimeout = error instanceof HttpTimeoutError;
    const retryable = !active.published && batch?.retry_count !== undefined && batch.retry_count < this.timeoutRetries;
    if (isTimeout && retryable) {
      this.deps.batches.recordGeneration({
        batchId, revision, attempt: active.attempt, status: 'retrying',
        startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
        errorCode: 'model_timeout', durationMs: Date.now() - startedAt
      });
      this.deps.bus.publish('reply.generation.retrying', { batchId, revision, attempt: active.attempt + 1 });
      // The active generation entry was already removed by the catch in
      // startGeneration, so the backoff gets its own cancellable controller:
      // a newer user message or shutdown aborts it instead of waiting it out.
      const retryController = new AbortController();
      this.retryControllers.set(batchId, retryController);
      try {
        await abortableDelay(this.retryBaseDelayMs, retryController.signal);
      } catch (abortErr) {
        this.retryControllers.delete(batchId);
        if (isBenignAbort(abortErr)) return;
        return this.handleGenerationFailure(batchId, revision, active, runtime, startedAt, abortErr, userMessages);
      }
      this.retryControllers.delete(batchId);
      if (this.stopped) return;
      const current = this.deps.batches.get(batchId);
      if (!current || current.revision !== revision || current.visible_at !== null) {
        return this.handleGenerationFailure(batchId, revision, active, runtime, startedAt, new StaleGenerationError(), userMessages);
      }
      // Atomic generating → queued (+retry_count) with the lease cleared;
      // startGeneration only claims queued batches, so without this the
      // retry would never actually restart the provider call.
      if (!this.deps.batches.prepareRetry(batchId, revision, this.owner)) {
        return this.handleGenerationFailure(batchId, revision, active, runtime, startedAt, new StaleGenerationError('retry fence lost'), userMessages);
      }
      await this.startGeneration(batchId, revision, true);
      return;
    }

    const failure: ReplyFailure = toReplyFailure(error, isTimeout, active.published);
    this.deps.batches.recordGeneration({
      batchId, revision, attempt: active.attempt, status: 'failed',
      startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
      errorCode: failure.code, durationMs: Date.now() - startedAt
    });
    if (active.published) {
      // Published content stays: complete the batch as partial (fenced on
      // publishing) instead of failing it, and record the provider error only
      // in the generation audit. Order matters — fail() would make the
      // publishing-fenced complete() lose the race.
      const shell = this.deps.messages.findAssistantByBatchId(batchId);
      if (shell && this.deps.batches.complete(batchId, revision, shell.id, this.owner, true)) {
        this.deps.messages.setStatus(shell.id, 'sent', 'partial:interrupted');
        this.deps.bus.publish('reply.publishing.partial', { batchId, revision, messageId: shell.id });
        const outcome: ReplyOutcome = {
          messageId: shell.id,
          ok: true,
          parts: shell.content.filter((part) => part.status === 'sent').map((part) => part.type),
          degraded: ['partial:interrupted']
        };
        for (const waiter of runtime?.waiters ?? []) waiter.resolve(outcome);
        this.runtime.delete(batchId);
        return;
      }
      // Fence lost (e.g. the user retried): a competing worker owns the batch.
      for (const waiter of runtime?.waiters ?? []) waiter.reject(new StaleGenerationError('batch owned by competing worker'));
      this.runtime.delete(batchId);
      return;
    }
    this.deps.batches.fail(batchId, revision, failure.code, failure.message, this.owner);
    this.publishFailure(batchId, revision, failure);
    const outcome: ReplyOutcome = {
      messageId: '',
      ok: false,
      parts: [],
      degraded: [],
      error: publicFailureFromReply(failure)
    };
    for (const waiter of runtime?.waiters ?? []) waiter.resolve(outcome);
    this.runtime.delete(batchId);
  }

  private publishFailure(batchId: string, revision: number, failure: ReplyFailure): void {
    this.deps.bus.publish('reply.failed', { batchId, revision, failure });
  }

  private interruptGeneration(batchId: string, reason: 'new_user_message' | 'shutdown'): void {
    const active = this.activeGenerations.get(batchId);
    if (active) {
      active.controller.abort(new UserInterruptedError(reason === 'new_user_message' ? 'superseded by newer user message' : 'coordinator shutdown'));
      this.activeGenerations.delete(batchId);
    }
    // A timeout retry still in its backoff must also stop when a newer
    // message lands or the coordinator shuts down.
    this.retryControllers.get(batchId)?.abort(new UserInterruptedError(reason === 'new_user_message' ? 'superseded by newer user message' : 'coordinator shutdown'));
  }

  private observeActive(batchId: string): void {
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
    if (!batch || batch.status === 'failed' || batch.status === 'cancelled' || batch.status === 'superseded') {
      const error = new Error(batch?.last_error ?? `reply batch ${batch?.status ?? 'missing'}`);
      for (const waiter of runtime.waiters) waiter.reject(error);
      this.runtime.delete(batchId);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(batchId);
      this.observeActive(batchId);
    }, 500);
    timer.unref?.();
    this.timers.set(batchId, timer);
  }

  private async runLegacyGeneration(batchId: string, revision: number): Promise<void> {
    try {
      const batch = this.deps.batches.get(batchId);
      if (!batch || batch.status !== 'generating') return;
      const runtime = this.runtime.get(batchId);
      const options = runtime?.options ?? { recentMessages: 24, memoryLimit: 8 };
      const userMessages = this.deps.batches.messageIds(batchId)
        .map((id) => this.deps.messages.get(id))
        .filter((message): message is ChatMessage => Boolean(message));
      const outcome = await this.deps.replier.replyBatch(userMessages, options, batchId);
      if (!outcome.ok) {
        this.deps.batches.fail(batchId, revision, outcome.error?.code ?? 'internal_error', outcome.error?.message ?? 'reply failed', this.owner);
        for (const waiter of runtime?.waiters ?? []) waiter.resolve(outcome);
        this.runtime.delete(batchId);
        return;
      }
      if (this.deps.batches.complete(batchId, revision, outcome.messageId, this.owner)) {
        await this.deps.onCompleted?.(batchId, userMessages, outcome, this.owner, revision);
        this.deps.bus.publish('reply.completed', { batchId, revision, messageId: outcome.messageId, message: this.deps.messages.get(outcome.messageId) });
      }
      for (const waiter of runtime?.waiters ?? []) waiter.resolve(outcome);
      this.runtime.delete(batchId);
    } catch (error) {
      this.deps.batches.fail(batchId, revision, 'internal_error', (error as Error).message, this.owner);
    }
  }
}

function toReplyFailure(error: unknown, isTimeout: boolean, published: boolean): ReplyFailure {
  if (isTimeout) {
    return {
      batchId: '',
      revision: 0,
      code: published ? 'provider_unavailable' : 'model_timeout',
      retryable: !published,
      message: published ? '回复中断了。' : '这次回复没有生成成功。'
    };
  }
  const err = error as Error;
  const status = (err as { status?: number }).status;
  if (typeof status === 'number' && status === 429) {
    return { batchId: '', revision: 0, code: 'rate_limited', retryable: true, message: '请求太频繁了，稍后再试一次吧。' };
  }
  return {
    batchId: '',
    revision: 0,
    code: 'provider_unavailable',
    retryable: false,
    message: '这次回复没有生成成功。'
  };
}

/** PublicFailure (from the replier) → the richer ReplyFailure shape for events. */
function toReplyFailureFromPublic(failure: PublicFailure | undefined, batchId: string, revision: number): ReplyFailure {
  if (!failure) return { batchId, revision, code: 'internal_error', retryable: false, message: 'reply failed' };
  return {
    batchId,
    revision,
    code: failure.code === 'internal_error' ? 'internal_error' : 'provider_unavailable',
    retryable: failure.code === 'provider_unavailable',
    message: failure.message
  };
}

/** ReplyFailure → the public failure shape carried on ReplyOutcome.error. */
function publicFailureFromReply(failure: ReplyFailure): PublicFailure {
  return {
    incidentId: '',
    code: failure.code === 'internal_error' ? 'internal_error' : 'provider_unavailable',
    message: failure.message
  };
}

function outcomeFromMessage(message: ChatMessage): ReplyOutcome {
  return {
    messageId: message.id,
    ok: true,
    parts: message.content.filter((part) => part.status === 'sent').map((part) => part.type),
    degraded: []
  };
}

/** Exported for tests: shape of the structured failure events. */
export function failureCodeFor(error: unknown): ReplyFailure['code'] {
  return toReplyFailure(error, error instanceof HttpTimeoutError, false).code;
}
