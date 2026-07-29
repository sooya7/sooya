import type { JobRepo, ErrorLogRepo } from '../db/repos/misc.repo.js';
import type { MemoryService } from './memory.js';
import type { Summarizer } from './summarizer.js';
import type { MessageRepo } from '../db/repos/message.repo.js';
import type { EventBus } from '../events/bus.js';
import type { BackupService } from '../backup/service.js';
import type { MediaStore } from '../media/store.js';
import type { WorldEngine } from './world.js';
import type { PushService } from './push.js';
import type { StorageService } from './storage.js';
import { cleanupTempFiles } from '../util/fsx.js';

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

/** Small persisted in-process job worker. */
export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly handlers = new Map<string, JobHandler>();

  constructor(
    private readonly repo: JobRepo,
    private readonly errorLog: ErrorLogRepo,
    private readonly opts: { intervalMs?: number } = {}
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const interval = this.opts.intervalMs ?? 1000;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const deadline = Date.now() + 10_000;
    while (this.running && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  async drain(maxJobs = 100): Promise<number> {
    let done = 0;
    for (let i = 0; i < maxJobs; i++) {
      const processed = await this.tick();
      if (!processed) break;
      done++;
    }
    return done;
  }

  private async tick(): Promise<boolean> {
    if (this.running || this.stopped) return false;
    const job = this.repo.claimNext();
    if (!job) return false;
    this.running = true;
    try {
      const handler = this.handlers.get(job.type);
      if (!handler) {
        this.repo.fail(job.id, `no handler registered for ${job.type}`);
        return true;
      }
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(job.payload_json) as Record<string, unknown>; } catch { /* ignore */ }
      await handler(payload);
      this.repo.complete(job.id);
    } catch (err) {
      const error = err as Error;
      this.repo.fail(job.id, error.message);
      this.errorLog.add(`job.${job.type}`, error.message);
    } finally {
      this.running = false;
    }
    return true;
  }
}

export interface JobDeps {
  jobs: JobRepo;
  media: MediaStore;
  memory: MemoryService;
  summarizer: Summarizer;
  messages: MessageRepo;
  bus: EventBus;
  backups: BackupService;
  world: WorldEngine;
  push: PushService;
  storage: StorageService;
  tmpDirs: string[];
}

export function registerDefaultJobs(worker: JobWorker, deps: JobDeps): void {
  worker.register('memory.extract', async (payload) => {
    const userMessageId = String(payload.userMessageId ?? '');
    const assistantMessageId = payload.assistantMessageId ? String(payload.assistantMessageId) : null;
    const userMsg = deps.messages.get(userMessageId);
    if (!userMsg) return;
    const userText = textOf(userMsg);
    const assistantText = assistantMessageId ? textOf(deps.messages.get(assistantMessageId)) : '';
    const candidates = await deps.memory.extractCandidates(userText, assistantText);
    if (candidates.length === 0) return;
    const result = await deps.memory.remember(candidates, userMessageId);
    if (result.stored > 0 || result.merged > 0) deps.bus.publish('memory.updated', { stored: result.stored, merged: result.merged });
  });

  worker.register('world.extract', async (payload) => {
    const userMessageId = String(payload.userMessageId ?? '');
    const assistantMessageId = payload.assistantMessageId ? String(payload.assistantMessageId) : null;
    const user = deps.messages.get(userMessageId);
    if (!user) return;
    const result = await deps.world.extract(textOf(user), assistantMessageId ? textOf(deps.messages.get(assistantMessageId)) : '', assistantMessageId ?? userMessageId);
    if (result.stored || result.merged || result.conflicts) deps.bus.publish('world.updated', result);
  });

  worker.register('world.rebuild', async (payload) => {
    const result = await deps.world.rebuild(Number(payload.limit ?? 400));
    deps.bus.publish('world.updated', { rebuilt: true, ...result });
  });

  worker.register('push.reply', async (payload) => {
    const messageId = String(payload.messageId ?? '');
    const message = deps.messages.get(messageId);
    if (!message || message.role !== 'assistant' || message.status !== 'sent') return;
    const result = await deps.push.notifyReply(message);
    if (result.delivered || result.removed || result.failed) deps.bus.publish('push.updated', { ...result });
  });

  worker.register('memory.embed.backfill', async () => { await deps.memory.backfillEmbeddings(20); });
  worker.register('summary.build', async () => { await deps.summarizer.runOnce(); });

  worker.register('maintenance', async () => {
    deps.jobs.purgeDone();
    await cleanupTempFiles(deps.tmpDirs);
    const orphans = await deps.media.collectOrphans();
    if (orphans.length > 0) deps.bus.publish('system.notice', { notice: 'cleaned orphan media', count: orphans.length });
    deps.memory.purgeExpired?.();
    const cleanup = await deps.storage.cleanup({ apply: true, categories: ['expiredTrash', 'tempFiles', 'orphanFiles', 'oldBackups', 'missingRecords'] });
    if (cleanup.releasedBytes > 0) deps.bus.publish('storage.updated', { releasedBytes: cleanup.releasedBytes, deleted: cleanup.deleted });
  });

  worker.register('backup.create', async (payload) => { await deps.backups.create(String(payload.reason ?? 'scheduled')); });
}

function textOf(msg: { content: Array<{ type: string; text?: string | null; transcript?: string | null }> } | undefined): string {
  if (!msg) return '';
  return msg.content
    .map((part) => part.type === 'text' ? part.text ?? '' : part.type === 'audio' ? part.transcript ?? '' : '')
    .filter(Boolean)
    .join('\n');
}
