import type { JobRepo, ErrorLogRepo } from '../db/repos/misc.repo.js';
import type { MemoryService } from './memory.js';
import type { OmbreMemoryBridge } from './ombre-memory.js';
import type { Summarizer } from './summarizer.js';
import type { MessageRepo } from '../db/repos/message.repo.js';
import type { EventBus } from '../events/bus.js';
import type { BackupService } from '../backup/service.js';
import type { MediaStore } from '../media/store.js';
import type { LifeRuntime } from './life.js';
import type { ReplyBatchRepo } from '../db/repos/reply-batch.repo.js';
import type { OmbreCommitRepo } from '../db/repos/ombre.repo.js';
import type { SettingsRepo } from '../db/repos/misc.repo.js';
import type { CapabilityRegistry } from './capabilities.js';
import type { ChatProvider } from '../providers/types.js';
import type { ConfigStore } from '../config/store.js';
import type { ProactiveComposer } from './proactive.js';
import type { StorageService } from './storage.js';
import type { MediaTextRepo } from '../db/repos/media-text.repo.js';
import { extractText } from '../media/text-extractor.js';
import { cleanupTempFiles } from '../util/fsx.js';
import { textForMemoryExtraction } from './web-search/isolation.js';
import type { StickerAnalyzer } from './stickers/analyzer.js';
import type { StickerAutoCollector } from './stickers/auto-collector.js';
import type { StickerRepo } from '../db/repos/sticker.repo.js';
import { STICKER_ANALYSIS_VERSION } from './stickers/constants.js';
import { stickerSemanticText } from './stickers/semantic-text.js';
import type { StickerUserMeaningLearner } from './stickers/user-meaning.js';
import type { WorldPresenceCoordinator } from './world-presence.js';
import type { QqDeliveryService } from '../channels/qq/outbound.js';
import type { FutureService } from './future/service.js';
import type { FlowTraceService } from './flow-trace.js';
import { JOB_PRIORITY } from './job-priority.js';
import { nowIso } from '../util/ids.js';
import { LANE_CONFIG } from './jobs/lanes.js';
import { executeWithContract } from './jobs/executor.js';
import { JobRegistry } from './jobs/registry.js';
import type { JobContract, JobContext, JobDefinition, JobHandler, JobLane, JobTimeoutMode } from './jobs/types.js';

export type { JobContract, JobContext, JobDefinition, JobHandler, JobLane, JobTimeoutMode } from './jobs/types.js';
export const STICKER_MAINTENANCE_BATCH = 8;

/**
 * Persisted in-process workers with independent execution lanes.
 *
 * The jobs table remains shared, but a slow autonomous or maintenance job can
 * no longer occupy the critical delivery lane. `drain()` intentionally keeps
 * the old deterministic, one-job-at-a-time test seam.
 */
export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private pumping = false;
  private draining = false;
  private readonly registry = new JobRegistry();
  private readonly active = new Map<JobLane, Map<string, Promise<void>>>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly repo: JobRepo,
    private readonly errorLog: ErrorLogRepo,
    private readonly opts: { intervalMs?: number } = {}
  ) {}

  register(type: string, handler: JobHandler, contract: Partial<JobContract> = {}): void {
    this.registry.register(type, handler, contract);
    this.syncEnqueuePolicy();
  }

  registerDefinition(definition: JobDefinition): void {
    this.registry.registerDefinition(definition);
    this.syncEnqueuePolicy();
  }

  private syncEnqueuePolicy(): void {
    for (const definition of this.registry.all()) {
      this.repo.registerJobDefinition(definition.type, definition.maxAttempts);
    }
  }

  definition(type: string): JobDefinition | undefined {
    return this.registry.get(type);
  }

  definitions(): JobDefinition[] {
    return this.registry.all();
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const interval = this.opts.intervalMs ?? 1000;
    void this.pump();
    this.timer = setInterval(() => { void this.pump(); }, interval);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const controller of this.controllers.values()) controller.abort();
    const deadline = Date.now() + 10_000;
    while (this.controllers.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.active.values()].flatMap((jobs) => [...jobs.values()])),
        new Promise((resolve) => setTimeout(resolve, 50))
      ]);
    }
  }

  async drain(maxJobs = 100): Promise<number> {
    if (this.draining || this.stopped) return 0;
    this.draining = true;
    let done = 0;
    try {
      for (let i = 0; i < maxJobs; i++) {
        const job = this.repo.claimNext();
        if (!job) break;
        await this.executeJob(job);
        done++;
      }
    } finally {
      this.draining = false;
    }
    return done;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      for (const lane of Object.keys(LANE_CONFIG) as JobLane[]) {
        const active = this.activeFor(lane);
        const types = this.registry.typesForLane(lane);
        while (active.size < LANE_CONFIG[lane].concurrency) {
          // Unregistered rows are treated as background poison pills. They are
          // still surfaced and failed instead of starving known lanes forever.
          const job = this.repo.claimNext(types.length > 0 ? types : undefined, types.length > 0 ? undefined : this.registry.allTypes());
          if (!job) break;
          const task = this.executeJob(job).finally(() => {
            active.delete(job.id);
            this.controllers.delete(job.id);
          });
          active.set(job.id, task);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private activeFor(lane: JobLane): Map<string, Promise<void>> {
    let active = this.active.get(lane);
    if (!active) {
      active = new Map();
      this.active.set(lane, active);
    }
    return active;
  }

  private async executeJob(job: { id: string; type: string; payload_json: string; attempts: number }): Promise<void> {
    const definition = this.registry.get(job.type);
    if (!definition) {
      this.repo.fail(job.id, `no handler registered for ${job.type}`, { retryable: false });
      return;
    }
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(job.payload_json) as Record<string, unknown>; } catch { /* fail at handler boundary */ }
    const context: JobContext = {
      jobId: job.id,
      type: job.type,
      lane: definition.lane,
      attempt: job.attempts,
      signal: controller.signal,
      cancel: () => controller.abort()
    };
    try {
      await executeWithContract(definition, payload, context);
      this.repo.complete(job.id);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const retryable = error.name === 'JobTimeoutError'
        ? definition.timeoutMode === 'abort' && definition.retryable
        : definition.retryable;
      this.repo.fail(job.id, error.message, { retryable });
      this.errorLog.add(`job.${job.type}`, error.message);
    } finally {
      this.controllers.delete(job.id);
    }
  }
}

export interface JobDeps {
  jobs: JobRepo;
  media: MediaStore;
  mediaText: MediaTextRepo;
  memory?: MemoryService;
  ombreMemory?: OmbreMemoryBridge;
  ombreCommits?: OmbreCommitRepo;
  settings?: SettingsRepo;
  memoryBackend?: 'legacy' | 'ombre';
  summarizer: Summarizer;
  messages: MessageRepo;
  bus: EventBus;
  backups: BackupService;
  life: LifeRuntime;
  presence: WorldPresenceCoordinator;
  batches: ReplyBatchRepo;
  proactive: ProactiveComposer;
  capabilities: CapabilityRegistry;
  stickerAnalyzer: StickerAnalyzer;
  stickerAutoCollector: StickerAutoCollector;
  stickerRepo: StickerRepo;
  stickerUserMeaning: StickerUserMeaningLearner;
  config: ConfigStore;
  reachOutEnabled: boolean;
  storage: StorageService;
  tmpDirs: string[];
  qqDelivery?: QqDeliveryService;
  future?: FutureService;
  relationship?: { tick(now?: Date): { cooling: number; archived: number } };
  timeline?: { sweep(now?: Date): Promise<{ closed: number; opened: number; attached: number; milestones: number }> };
  feedback?: { sweep(now?: Date): { recorded: number } };
  flowTrace?: FlowTraceService;
}

export function registerDefaultJobs(worker: JobWorker, deps: JobDeps): void {
  worker.register('media.extract_text', async (payload) => {
    const mediaId = String(payload.mediaId ?? '');
    if (!mediaId) return;
    const read = await deps.media.read(mediaId);
    if (!read || read.row.kind !== 'file') {
      if (read) {
        deps.mediaText.upsert({ mediaId, status: 'failed', error: 'not_a_file', metadata: { reason: 'not_a_file' } });
        deps.bus.publish('media.updated', { mediaId, textStatus: 'failed' });
      }
      return;
    }
    const result = extractText(read.data, read.row.mime, mediaName(read.row.meta_json));
    deps.mediaText.upsert({ mediaId, status: result.status, text: result.status === 'ready' ? result.text : null, metadata: result.metadata, error: result.status === 'failed' ? result.error : null });
    deps.bus.publish('media.updated', { mediaId, textStatus: result.status });
  });

  worker.register('sticker.auto-collect', async (payload) => {
    const mediaId = String(payload.mediaId ?? '');
    if (!mediaId) return;
    const result = await deps.stickerAutoCollector.collect(mediaId);
    if (result.collected && result.stickerId) {
      deps.jobs.enqueue('sticker.embed', { stickerId: result.stickerId }, { maxAttempts: 2 });
      deps.bus.publish('sticker.updated', { stickerId: result.stickerId, autoCollected: true });
    }
  });

  worker.register('sticker.analyze', async (payload) => {
    const stickerId = String(payload.stickerId ?? '');
    if (!stickerId) return;
    const result = await deps.stickerAnalyzer.analyze(stickerId, {
      force: payload.force === true,
      expectedSemanticRevision: typeof payload.expectedSemanticRevision === 'number' ? payload.expectedSemanticRevision : undefined
    });
    if (result) {
      deps.jobs.enqueue('sticker.embed', { stickerId }, { maxAttempts: 2 });
      deps.bus.publish('sticker.analysis.updated', { stickerId, status: 'ready', version: STICKER_ANALYSIS_VERSION });
    }
  });

  worker.register('sticker.analyze.backfill', async (payload) => {
    if (!deps.capabilities.visionProvider()) return;
    const requestedIds = Array.isArray(payload.ids)
      ? payload.ids.map((id) => String(id)).filter(Boolean)
      : null;
    const active = new Set(
      deps.jobs.list(500)
        .filter((job) => job.type === 'sticker.analyze' && (job.status === 'pending' || job.status === 'running'))
        .map((job) => stickerIdFromJob(job.payload_json))
        .filter(Boolean)
    );
    const source = requestedIds
      ? requestedIds.map((id) => deps.stickerRepo.get(id)).filter((sticker): sticker is NonNullable<typeof sticker> => Boolean(sticker))
      : deps.stickerRepo.list({ enabledOnly: true });
    const candidates = source.filter((sticker) =>
      sticker.analysisStatus !== 'ready'
      && sticker.analysisSource !== 'manual'
      && !active.has(sticker.id)
    );
    const batch = candidates.slice(0, STICKER_MAINTENANCE_BATCH);
    for (const sticker of batch) {
      deps.jobs.enqueue('sticker.analyze', { stickerId: sticker.id }, { maxAttempts: 2, priority: JOB_PRIORITY.stickerAnalyze });
    }
    const remaining = candidates.slice(batch.length).map((sticker) => sticker.id);
    if (remaining.length > 0) {
      deps.jobs.enqueue('sticker.analyze.backfill', { ids: remaining }, { priority: JOB_PRIORITY.stickerAnalyze });
    }
  });

  worker.register('sticker.embed', async (payload) => {
    const stickerId = String(payload.stickerId ?? '');
    const sticker = deps.stickerRepo.get(stickerId);
    if (!sticker || sticker.analysisStatus !== 'ready') return;
    const provider = deps.capabilities.embeddingProvider();
    if (!provider.configured) return;
    const result = await provider.embed([stickerSemanticText(sticker)]);
    const vector = result.vectors[0];
    if (!vector) return;
    deps.stickerRepo.setEmbedding(stickerId, vector, result.model, result.dimensions);
    deps.bus.publish('sticker.updated', { stickerId, embedding: true, embeddingModel: result.model, embeddingDim: result.dimensions });
  });

  worker.register('sticker.embed.backfill', async () => {
    const embeddingConfig = deps.config.getModels().embedding;
    const expectedModel = embeddingConfig.model.trim();
    const expectedDimensions = embeddingConfig.dimensions;
    const candidates = deps.stickerRepo.list({ enabledOnly: true }).filter((sticker) =>
      sticker.analysisStatus === 'ready' && (
        !sticker.embedding
        || (expectedModel.length > 0 && sticker.embeddingModel !== expectedModel)
        || (expectedDimensions !== undefined && sticker.embeddingDim !== expectedDimensions)
      )
    );
    const missing = candidates.slice(0, STICKER_MAINTENANCE_BATCH);
    for (const sticker of missing) {
      deps.jobs.enqueue('sticker.embed', { stickerId: sticker.id }, { maxAttempts: 2, priority: JOB_PRIORITY.stickerEmbed });
    }
    // Keep draining large catalogues in bounded batches. The next durable job
    // is queued only after this batch is claimed, so startup never floods the
    // job table with one row per sticker.
    if (candidates.length > missing.length) deps.jobs.enqueue('sticker.embed.backfill', {});
  });

  worker.register('sticker.user-meaning.learn', async (payload) => {
    const stickerId = String(payload.stickerId ?? '');
    if (!stickerId) return;
    if (await deps.stickerUserMeaning.learn(stickerId)) {
      deps.jobs.enqueue('sticker.embed', { stickerId }, { maxAttempts: 2 });
      deps.bus.publish('sticker.updated', { stickerId, userMeaning: true });
    }
  });

  worker.register('memory.extract', async (payload) => {
    const userMessageIds = Array.isArray(payload.userMessageIds)
      ? payload.userMessageIds.map((id) => String(id)).filter(Boolean)
      : [String(payload.userMessageId ?? '')].filter(Boolean);
    const userMessageId = userMessageIds.at(-1) ?? '';
    const assistantMessageId = payload.assistantMessageId ? String(payload.assistantMessageId) : null;
    const userMessages = userMessageIds.map((id) => deps.messages.get(id)).filter((message): message is NonNullable<typeof message> => Boolean(message));
    if (userMessages.length === 0) return;
    const userText = userMessages.map(textForMemoryExtraction).filter(Boolean).join('\n');
    const assistantText = assistantMessageId ? textForMemoryExtraction(deps.messages.get(assistantMessageId)) : '';
    if (!deps.memory) return;
    const candidates = await deps.memory.extractCandidates(userText, assistantText);
    if (candidates.length === 0) return;
    const result = await deps.memory.remember(candidates, userMessageId);
    if (result.stored > 0 || result.merged > 0 || result.superseded > 0) deps.bus.publish('memory.updated', result);
  });

  worker.register('ombre.memory_commit', async (payload) => {
    if (!deps.ombreMemory) return;
    const batchId = String(payload.batchId ?? '');
    const revision = Number(payload.revision ?? 0);
    if (!batchId || !Number.isInteger(revision) || revision <= 0) return;
    if (!deps.batches.isCurrentRevision(batchId, revision)) return;
    const userMessageIds = Array.isArray(payload.userMessageIds) ? payload.userMessageIds.map((id) => String(id)).filter(Boolean) : [];
    const assistantMessageId = payload.assistantMessageId ? String(payload.assistantMessageId) : '';
    const userText = userMessageIds.map((id) => textForMemoryExtraction(deps.messages.get(id))).filter(Boolean).join('\n');
    const assistantText = assistantMessageId ? textForMemoryExtraction(deps.messages.get(assistantMessageId)) : '';
    try {
      const result = await deps.ombreMemory.commit({
        batchId,
        revision,
        userText,
        assistantText,
        userMessageIds,
        assistantMessageId,
        allowUncertainRetry: payload.manualRetry === true
      });
      deps.bus.publish('memory.updated', { backend: 'ombre', batchId, revision, ...result });
    } catch (error) {
      deps.bus.publish('ombre.memory.error', { phase: 'commit_job', batchId, revision, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      throw error;
    }
  });

  /*
   * 通道投递（QQ 单通道，docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §8.3）：
   * 回复完成后只入队这一个 job，其余（outbox、幂等、重试、媒体）都在
   * QqDeliveryService 内完成。重试由其内部按退避重新入队 runAfter 任务，
   * 不依赖本 job 的 maxAttempts 阶梯。
   */
  worker.register('qq.deliver', async (payload, context) => {
    if (!deps.qqDelivery) return;
    const traceId = typeof payload.flowTraceId === 'string' ? payload.flowTraceId : undefined;
    deps.flowTrace?.stage(traceId, 'qq.delivery.started', 'running', { messageId: String(payload.messageId ?? '') });
    const status = await deps.qqDelivery.deliver({
      messageId: String(payload.messageId ?? ''),
      conversationId: payload.conversationId ? String(payload.conversationId) : undefined,
      traceId,
      signal: context.signal
    });
    if (status === 'sent' || status === 'skipped') {
      deps.flowTrace?.stage(traceId, 'qq.delivery.completed', status === 'sent' ? 'ok' : 'blocked', { status });
      deps.flowTrace?.finish(traceId, status === 'sent' ? 'ok' : 'blocked', { status });
    } else if (status === 'failed') {
      deps.flowTrace?.fail(traceId, 'qq.delivery.failed', status);
    } else {
      deps.flowTrace?.stage(traceId, 'qq.delivery.retrying', 'running', { status });
    }
  }, { lane: 'critical', timeoutMs: 15_000, maxAttempts: 1, retryable: true, cancellable: true, timeoutMode: 'abort' });

  /*
   * Life conversation bridge (§49-50): a completed exchange may carry a user
   * suggestion ("试试 X") and a warmth signal for the vitals. Runs as its own
   * durable job so a failure here never re-runs the reply model; the revision
   * fence guarantees only the final revision writes into life state.
   */
  worker.register('life.conversation', async (payload) => {
    const batchId = payload.batchId ? String(payload.batchId) : '';
    const revision = Number(payload.revision ?? 0);
    if (batchId && revision > 0 && !deps.batches.isCurrentRevision(batchId, revision)) return;
    const ids = Array.isArray(payload.userMessageIds) ? payload.userMessageIds.map((id) => String(id)).filter(Boolean) : [];
    const lastUserMessageId = payload.lastUserMessageId ? String(payload.lastUserMessageId) : null;
    const userText = ids.map((id) => textOf(deps.messages.get(id))).filter(Boolean).join('\n');
    deps.life.applyConversationSignal({
      mood: payload.warmth === 'warm' ? 'warm' : payload.warmth === 'rough' ? 'rough' : 'neutral',
      text: userText || undefined,
      messageId: lastUserMessageId ?? undefined
    });
  });

  /*
   * Future engine (§8): runs beside ombre.memory_commit after the final reply
   * is published. The revision fence plus the extraction-run claim make a
   * crashed job safe to retry — the analyzer never runs twice per message.
   */
  worker.register('future.analyze', async (payload) => {
    if (!deps.future) return;
    const batchId = payload.batchId ? String(payload.batchId) : '';
    const revision = Number(payload.revision ?? 0);
    if (batchId && Number.isInteger(revision) && revision > 0 && !deps.batches.isCurrentRevision(batchId, revision)) return;
    const userMessageIds = Array.isArray(payload.userMessageIds) ? payload.userMessageIds.map((id) => String(id)).filter(Boolean) : [];
    const assistantMessageId = payload.assistantMessageId ? String(payload.assistantMessageId) : null;
    const lastUserMessageId = userMessageIds.at(-1) ?? '';
    if (!lastUserMessageId) return;
    const userText = userMessageIds.map((id) => textForMemoryExtraction(deps.messages.get(id))).filter(Boolean).join('\n');
    const assistantText = assistantMessageId ? textForMemoryExtraction(deps.messages.get(assistantMessageId)) : '';
    const createdAt = deps.messages.get(lastUserMessageId)?.createdAt;
    await deps.future.analyzeAndApply({
      userText,
      assistantText,
      sourceMessageId: lastUserMessageId,
      at: createdAt ? new Date(createdAt) : undefined
    });
  });

  worker.register('weather.refresh', async (payload) => {
    await deps.presence.refreshWeather(String(payload.reason ?? 'scheduled'));
  });

  /*
   * Advances her day. Runs on a timer, not off a user message, because the
   * whole point is that she exists while nobody is looking. The engine
   * resolves the activity from the clock, so a tick that was missed while the
   * process was down does not leave her stuck in yesterday's afternoon.
   */
  worker.register('life.tick', async () => {
    const result = deps.life.tick();
    if (result.changed) deps.bus.publish('life.updated', { activity: result.activity, kind: result.kind, mood: result.mood });
    deps.presence.sync('life.tick');
    if (!deps.reachOutEnabled) return;
    // Do not let slow proactive composition/media generation occupy the single
    // durable JobWorker. ReplyCoordinator owns cancellation and user-message
    // priority, so launch the proactive task outside the durable queue.
    void deps.proactive.run().catch((error) => {
      deps.bus.publish('system.notice', {
        notice: 'proactive reach-out failed',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300)
      });
    });
  }, { lane: 'autonomous', timeoutMs: 30_000, maxAttempts: 2, retryable: true, cancellable: true, timeoutMode: 'observe' });

  worker.register('ombre.dream', async (payload) => {
    if (!deps.ombreMemory) return;
    const result = await deps.ombreMemory.dream();
    if (result === null) return;
    const commitAt = typeof payload.commitAt === 'string' ? payload.commitAt : deps.ombreCommits?.latestCompleted()?.completed_at;
    deps.settings?.set('ombre.lastDreamAt', nowIso());
    if (commitAt) deps.settings?.set('ombre.lastDreamCommitAt', commitAt);
  });
  worker.register('ombre.refresh_tools', async () => {
    if (!deps.ombreMemory) return;
    await deps.ombreMemory.refreshTools();
  });
  worker.register('memory.embed.backfill', async () => { if (deps.memory) await deps.memory.backfillEmbeddings(20); });
  worker.register('summary.build', async () => { await deps.summarizer.runOnce(); });

  worker.register('maintenance', async () => {
    deps.jobs.purgeDone();
    await cleanupTempFiles(deps.tmpDirs);
    const orphans = await deps.media.collectOrphans(undefined, deps.storage.avatarMediaIds());
    if (orphans.length > 0) deps.bus.publish('system.notice', { notice: 'cleaned orphan media', count: orphans.length });
    if (deps.memoryBackend === 'legacy') deps.memory?.purgeExpired?.();
    // Time-driven commitment lifecycle (§13): due promotion, missed explicit
    // promises, expired tentatives, grace-window archiving.
    deps.future?.tick();
    // Relationship thread decay (docs/RELATIONSHIP-CONTRACT.md §4).
    deps.relationship?.tick();
    // Episode building sweep (§22): close elapsed windows, fold new messages.
    await deps.timeline?.sweep();
    // Interaction outcome derivation (§22): what the user did with proactive sends.
    deps.feedback?.sweep();
    const cleanup = await deps.storage.cleanup({
      apply: true,
      internal: true,
      categories: ['expiredTrash', 'tempFiles', 'orphanFiles', 'oldBackups', 'missingRecords']
    });
    if (cleanup.releasedBytes > 0) deps.bus.publish('storage.updated', { releasedBytes: cleanup.releasedBytes, deleted: cleanup.deleted });
  });

  worker.register('backup.create', async (payload) => { await deps.backups.create(String(payload.reason ?? 'scheduled')); });
}

function stickerIdFromJob(payloadJson: string): string {
  try { return String((JSON.parse(payloadJson) as { stickerId?: unknown }).stickerId ?? ''); } catch { return ''; }
}

function mediaName(metaJson: string): string | undefined {
  try { return (JSON.parse(metaJson) as { name?: string | null }).name ?? undefined; } catch { return undefined; }
}

/**
 * One short unprompted line, grounded in what she actually just did. The
 * activity is passed in rather than left to the model so the message cannot
 * contradict the state the user can see in the UI.
 */
async function composeReachOut(
  provider: ChatProvider,
  personaPrompt: string,
  lifeLines: string[],
  activity: string
): Promise<string> {
  const result = await provider.complete({
    system: [
      personaPrompt.trim(),
      lifeLines.join('\n'),
      `你想主动跟用户说说刚才${activity}的事。`,
      '写一条 40 字以内的消息，像随手发的碎碎念，只说这一件事。',
      '不要打招呼式的开场，不要问“你在吗”，不要提到任何系统、功能或设置。',
      '直接输出这句话本身，不要引号。'
    ].join('\n'),
    messages: [{ role: 'user', content: [{ type: 'text', text: '（无人说话，你主动开口）' }] }],
    temperature: 0.9,
    maxTokens: 120
  });
  return result.text.trim().replace(/^["“']|["”']$/g, '').slice(0, 120);
}

function textOf(msg: { content: Array<{ type: string; text?: string | null; transcript?: string | null }> } | undefined): string {
  if (!msg) return '';
  return msg.content
    .map((part) => part.type === 'text' ? part.text ?? '' : part.type === 'audio' ? part.transcript ?? '' : '')
    .filter(Boolean)
    .join('\n');
}
