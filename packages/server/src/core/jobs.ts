import type { JobRepo, ErrorLogRepo } from '../db/repos/misc.repo.js';
import type { MemoryService } from './memory.js';
import type { Summarizer } from './summarizer.js';
import type { MessageRepo } from '../db/repos/message.repo.js';
import type { EventBus } from '../events/bus.js';
import type { BackupService } from '../backup/service.js';
import type { MediaStore } from '../media/store.js';
import type { LifeRuntime } from './life.js';
import type { ReplyBatchRepo } from '../db/repos/reply-batch.repo.js';
import { LifeSimEngine } from './life2/engine.js';
import type { CapabilityRegistry } from './capabilities.js';
import type { ChatProvider } from '../providers/types.js';
import type { ConfigStore } from '../config/store.js';
import type { PushService } from './push.js';
import type { ProactiveComposer } from './proactive.js';
import type { StorageService } from './storage.js';
import type { MediaTextRepo } from '../db/repos/media-text.repo.js';
import { extractText } from '../media/text-extractor.js';
import { cleanupTempFiles } from '../util/fsx.js';
import { textForMemoryExtraction } from './web-search/isolation.js';
import type { StickerAnalyzer } from './stickers/analyzer.js';
import type { StickerRepo } from '../db/repos/sticker.repo.js';
import { STICKER_ANALYSIS_VERSION } from './stickers/constants.js';
import { stickerSemanticText } from './stickers/semantic-text.js';
import type { StickerUserMeaningLearner } from './stickers/user-meaning.js';

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
  mediaText: MediaTextRepo;
  memory: MemoryService;
  summarizer: Summarizer;
  messages: MessageRepo;
  bus: EventBus;
  backups: BackupService;
  life: LifeRuntime;
  batches: ReplyBatchRepo;
  proactive: ProactiveComposer;
  capabilities: CapabilityRegistry;
  stickerAnalyzer: StickerAnalyzer;
  stickerRepo: StickerRepo;
  stickerUserMeaning: StickerUserMeaningLearner;
  config: ConfigStore;
  reachOutEnabled: boolean;
  push: PushService;
  storage: StorageService;
  tmpDirs: string[];
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

  worker.register('sticker.analyze', async (payload) => {
    const stickerId = String(payload.stickerId ?? '');
    if (!stickerId) return;
    const result = await deps.stickerAnalyzer.analyze(stickerId);
    if (result) {
      deps.jobs.enqueue('sticker.embed', { stickerId }, { maxAttempts: 2 });
      deps.bus.publish('sticker.analysis.updated', { stickerId, status: 'ready', version: STICKER_ANALYSIS_VERSION });
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
    const missing = deps.stickerRepo.list({ enabledOnly: true }).filter((sticker) =>
      sticker.analysisStatus === 'ready' && (!sticker.embedding || sticker.embeddingModel !== deps.config.getModels().embedding.model)
    ).slice(0, 20);
    for (const sticker of missing) deps.jobs.enqueue('sticker.embed', { stickerId: sticker.id }, { maxAttempts: 2 });
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
    const candidates = await deps.memory.extractCandidates(userText, assistantText);
    if (candidates.length === 0) return;
    const result = await deps.memory.remember(candidates, userMessageId);
    if (result.stored > 0 || result.merged > 0 || result.superseded > 0) deps.bus.publish('memory.updated', result);
  });

  worker.register('push.reply', async (payload) => {
    const messageId = String(payload.messageId ?? '');
    const message = deps.messages.get(messageId);
    if (!message || message.role !== 'assistant' || message.status !== 'sent') return;
    const result = await deps.push.notifyReply(message);
    if (result.delivered || result.removed || result.failed) deps.bus.publish('push.updated', { ...result });
  });

  /*
   * Life conversation bridge (§49-50): a completed exchange may carry a user
   * suggestion ("试试 X") and a warmth signal for the vitals. Runs as its own
   * durable job so a failure here never re-runs the reply model; the revision
   * fence guarantees only the final revision writes into life state.
   */
  worker.register('life.conversation', async (payload) => {
    if (!(deps.life instanceof LifeSimEngine)) return;
    const batchId = payload.batchId ? String(payload.batchId) : '';
    const revision = Number(payload.revision ?? 0);
    if (batchId && revision > 0 && !deps.batches.isCurrentRevision(batchId, revision)) return;
    const ids = Array.isArray(payload.userMessageIds) ? payload.userMessageIds.map((id) => String(id)).filter(Boolean) : [];
    const lastUserMessageId = payload.lastUserMessageId ? String(payload.lastUserMessageId) : null;
    const userText = ids.map((id) => textOf(deps.messages.get(id))).filter(Boolean).join('\n');
    if (lastUserMessageId) deps.life.extractConversationIntent(userText, lastUserMessageId);
    deps.life.applyConversationEffect(payload.warmth === 'warm' ? 'warm' : 'neutral');
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
    if (!deps.reachOutEnabled) return;
    await deps.proactive.run();
  });

  worker.register('memory.embed.backfill', async () => { await deps.memory.backfillEmbeddings(20); });
  worker.register('summary.build', async () => { await deps.summarizer.runOnce(); });

  worker.register('maintenance', async () => {
    deps.jobs.purgeDone();
    await cleanupTempFiles(deps.tmpDirs);
    const orphans = await deps.media.collectOrphans(undefined, deps.storage.avatarMediaIds());
    if (orphans.length > 0) deps.bus.publish('system.notice', { notice: 'cleaned orphan media', count: orphans.length });
    deps.memory.purgeExpired?.();
    const cleanup = await deps.storage.cleanup({
      apply: true,
      internal: true,
      categories: ['expiredTrash', 'tempFiles', 'orphanFiles', 'oldBackups', 'missingRecords']
    });
    if (cleanup.releasedBytes > 0) deps.bus.publish('storage.updated', { releasedBytes: cleanup.releasedBytes, deleted: cleanup.deleted });
  });

  worker.register('backup.create', async (payload) => { await deps.backups.create(String(payload.reason ?? 'scheduled')); });
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
