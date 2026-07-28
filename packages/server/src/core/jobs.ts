import type { JobRepo, ErrorLogRepo } from '../db/repos/misc.repo.js';
import type { MemoryService } from './memory.js';
import type { Summarizer } from './summarizer.js';
import type { MessageRepo } from '../db/repos/message.repo.js';
import type { EventBus } from '../events/bus.js';
import type { BackupService } from '../backup/service.js';
import type { MediaStore } from '../media/store.js';
import { cleanupTempFiles } from '../util/fsx.js';

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

/**
 * Small in-process job worker (no Redis / external queue).
 * Jobs are persisted in SQLite so an unexpected exit does not lose work:
 * `recoverStuck()` puts interrupted jobs back into the queue at boot.
 */
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
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for the current job to finish (graceful shutdown).
    const deadline = Date.now() + 10_000;
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Runs pending jobs until the queue is drained. Exposed for tests. */
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
      try {
        payload = JSON.parse(job.payload_json) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      await handler(payload);
      this.repo.complete(job.id);
    } catch (err) {
      const e = err as Error;
      this.repo.fail(job.id, e.message);
      this.errorLog.add(`job.${job.type}`, e.message);
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
    if (result.stored > 0 || result.merged > 0) {
      deps.bus.publish('memory.updated', { stored: result.stored, merged: result.merged });
    }
  });

  worker.register('memory.embed.backfill', async () => {
    await deps.memory.backfillEmbeddings(20);
  });

  worker.register('summary.build', async () => {
    await deps.summarizer.runOnce();
  });

  worker.register('maintenance', async () => {
    deps.jobs.purgeDone();
    await cleanupTempFiles(deps.tmpDirs);
    // Drafts that were uploaded but never sent would otherwise leak forever.
    const orphans = await deps.media.collectOrphans();
    if (orphans.length > 0) deps.bus.publish('system.notice', { notice: 'cleaned orphan media', count: orphans.length });
    deps.memory.purgeExpired?.();
  });

  worker.register('backup.create', async (payload) => {
    await deps.backups.create(String(payload.reason ?? 'scheduled'));
  });
}

function textOf(msg: { content: Array<{ type: string; text?: string | null; transcript?: string | null }> } | undefined): string {
  if (!msg) return '';
  return msg.content
    .map((p) => (p.type === 'text' ? p.text ?? '' : p.type === 'audio' ? p.transcript ?? '' : ''))
    .filter(Boolean)
    .join('\n');
}
