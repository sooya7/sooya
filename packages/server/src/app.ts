import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { Logger } from 'pino';
import { loadEnv, type AppEnv } from './config/env.js';
import { createLogger } from './util/logger.js';
import { closeDatabase, openDatabase, reconcileCounters } from './db/index.js';
import { DbHandle } from './db/handle.js';
import { ConfigStore } from './config/store.js';
import { MediaRepo } from './db/repos/media.repo.js';
import { MessageRepo } from './db/repos/message.repo.js';
import { MemoryRepo } from './db/repos/memory.repo.js';
import { StickerRepo } from './db/repos/sticker.repo.js';
import { ErrorLogRepo, EventRepo, JobRepo, SettingsRepo, SummaryRepo } from './db/repos/misc.repo.js';
import { AuditRepo, PushSubscriptionRepo, StorageSampleRepo } from './db/repos/feature.repo.js';
import { MediaStore } from './media/store.js';
import { StickerLibrary } from './media/stickers.js';
import { ImageVariantService } from './media/variants.js';
import { CapabilityRegistry } from './core/capabilities.js';
import { MemoryService } from './core/memory.js';
import { ContextBuilder } from './core/context.js';
import { Summarizer } from './core/summarizer.js';
import { Replier } from './core/replier.js';
import { isSafeApplicationError, publicFailure, redactDiagnostic } from './core/public-error.js';
import { LifeEngine, DEFAULT_LIFE_CONFIG, type LifeConfig } from './core/life.js';
import { LifeRepo } from './db/repos/life.repo.js';
import { ReplyBatchRepo } from './db/repos/reply-batch.repo.js';
import { ReplyCoordinator } from './core/reply-coordinator.js';
import { PushService } from './core/push.js';
import { StorageService } from './core/storage.js';
import { maintenanceCoordinator } from './core/maintenance.js';
import { EventBus } from './events/bus.js';
import { JobWorker, registerDefaultJobs } from './core/jobs.js';
import { BackupService } from './backup/service.js';
import { AgentRegistry, CapabilityRegistryStub, ToolRegistry } from './agent/registry.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerFeatureRoutes } from './routes/features.js';
import { ensureDirSync, cleanupTempFiles } from './util/fsx.js';

export interface BuildAppOptions {
  env?: Partial<NodeJS.ProcessEnv>;
  /**
   * Injectable clock. The life engine derives everything from wall-clock time,
   * so a test that cannot move the clock can only assert whatever she happens
   * to be doing when it runs -- which at 01:00 is "asleep", making the
   * behaviour that matters untestable.
   */
  clock?: () => Date;
  logger?: Logger;
  skipStickerImport?: boolean;
  assetsDir?: string;
  fetchImpl?: typeof fetch;
  startWorkers?: boolean;
  /** Test seam; production uses the coordinator's 900ms default. */
  replyDebounceMs?: number;
}

export interface SooyaApp {
  server: FastifyInstance;
  env: AppEnv;
  db: DbHandle;
  config: ConfigStore;
  repos: {
    messages: MessageRepo;
    media: MediaRepo;
    memories: MemoryRepo;
    stickers: StickerRepo;
    summaries: SummaryRepo;
    jobs: JobRepo;
    settings: SettingsRepo;
    events: EventRepo;
    errors: ErrorLogRepo;
    pushSubscriptions: PushSubscriptionRepo;
    life: LifeRepo;
    audit: AuditRepo;
    storageSamples: StorageSampleRepo;
    replyBatches: ReplyBatchRepo;
  };
  services: {
    mediaStore: MediaStore;
    mediaVariants: ImageVariantService;
    stickerLibrary: StickerLibrary;
    capabilities: CapabilityRegistry;
    memory: MemoryService;
    life: LifeEngine;
    push: PushService;
    storage: StorageService;
    context: ContextBuilder;
    summarizer: Summarizer;
    replier: Replier;
    replyCoordinator: ReplyCoordinator;
    bus: EventBus;
    worker: JobWorker;
    backups: BackupService;
    agents: AgentRegistry;
    tools: ToolRegistry;
    agentCapabilities: CapabilityRegistryStub;
  };
  state: {
    startedAt: string;
    dbRecovered: boolean;
    dbRecoveredFrom?: string;
    /** `foreign_key_check` complaint the database opened with, if any. */
    dbInconsistent?: string;
    version: string;
  };
  /** Injected in tests so routes can reach the network through a stub. */
  fetchImpl?: typeof fetch;
  reopenDatabase: () => void;
  close: () => Promise<void>;
}

const VERSION = '1.0.0';

/** Vite 产物：`index-D9-2lj-S.js` 这类文件名里带内容哈希，内容变了文件名一定会变。 */
const HASHED_ASSET = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
/** 文件名固定、内容会随发布改变的入口文件：缓存住就等于发布不上去。 */
const ALWAYS_REVALIDATE = /(?:\.html|\/sw\.js|\.webmanifest)$/;
/** 图标、头像这类文件名带版本后缀（sooya-photo-v2-192.png），一天足够短也足够省。 */
const STATIC_ASSET_MAX_AGE_S = 86400;

/*
 * @fastify/static 不传 maxAge 时，底层 @fastify/send 会发 `Cache-Control: public, max-age=0`，
 * 于是每一次加载、每一个静态文件都要回源验证一次：浏览器发条件请求，Cloudflare 边缘也只能
 * 是 REVALIDATED 而不是 HIT，实测每个文件因此多花 0.3–0.5s（隧道回源的往返）。
 * 带哈希的产物永远可以 immutable；入口文件必须 no-cache，否则发新版用户看不到。
 */
export function staticCacheControl(filePath: string): string {
  const pathname = filePath.split(path.sep).join('/');
  if (ALWAYS_REVALIDATE.test(pathname)) return 'no-cache';
  if (HASHED_ASSET.test(pathname)) return 'public, max-age=31536000, immutable';
  return `public, max-age=${STATIC_ASSET_MAX_AGE_S}`;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<SooyaApp> {
  const env = loadEnv({ ...process.env, ...opts.env } as NodeJS.ProcessEnv);
  const logger = opts.logger ?? createLogger({ level: env.LOG_LEVEL, logDir: env.NODE_ENV === 'test' ? null : env.logDir, pretty: env.NODE_ENV === 'development' });

  for (const dir of [env.dataDir, env.dbDir, env.mediaDir, env.backupDir, env.logDir, ...Object.values(env.mediaDirs)]) ensureDirSync(dir);

  const dbFile = path.join(env.dbDir, 'sooya.db');
  const opened = openDatabase({ file: dbFile, backupDir: env.backupDir, onLog: (level, msg, extra) => logger[level]({ ...extra }, msg) });
  const dbHandle = new DbHandle(opened.db);
  const config = new ConfigStore({ configDir: env.configDir, env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv, onLog: (level, msg, extra) => logger[level]({ ...extra }, msg) });

  const repos = {
    messages: new MessageRepo(dbHandle),
    media: new MediaRepo(dbHandle),
    memories: new MemoryRepo(dbHandle),
    stickers: new StickerRepo(dbHandle),
    summaries: new SummaryRepo(dbHandle),
    jobs: new JobRepo(dbHandle),
    settings: new SettingsRepo(dbHandle),
    events: new EventRepo(dbHandle),
    errors: new ErrorLogRepo(dbHandle),
    pushSubscriptions: new PushSubscriptionRepo(dbHandle),
    life: new LifeRepo(dbHandle),
    audit: new AuditRepo(dbHandle),
    storageSamples: new StorageSampleRepo(dbHandle),
    replyBatches: new ReplyBatchRepo(dbHandle)
  };

  const mediaStore = new MediaStore(env.mediaDirs, repos.media, { maxUploadBytes: env.MAX_UPLOAD_BYTES });
  const mediaVariants = new ImageVariantService(env.mediaDirs.variants, (message, id) => repos.errors.add('media.variant', message, { id }));
  const stickerLibrary = new StickerLibrary(repos.stickers, repos.media, mediaStore);
  const capabilities = new CapabilityRegistry(config, { allowPrivateNetwork: env.ALLOW_PRIVATE_NETWORK_FETCH, fetchImpl: opts.fetchImpl });
  const bus = new EventBus(repos.events);
  const memory = new MemoryService(repos.memories, capabilities, repos.errors, { disabled: env.DISABLE_MEMORY_PIPELINE });
  const push = new PushService(repos.pushSubscriptions, repos.settings, repos.errors, opts.fetchImpl, env.SOOYA_PUSH_SUBJECT);
  const storage = new StorageService(env, repos.media, mediaStore, repos.settings, repos.audit, repos.storageSamples, config, repos.errors, maintenanceCoordinator);
  /*
   * Env vars stay the deployment default; anything the user set in the panel wins
   * over them. Resolved per call so a panel change lands on the next 5-minute
   * tick instead of waiting for a restart.
   */
  const lifeSettings = (): LifeConfig => {
    const policy = config.getPersona().lifePolicy ?? {};
    return {
      ...DEFAULT_LIFE_CONFIG,
      timeZone: env.LIFE_TIME_ZONE,
      tzOffsetMinutes: env.LIFE_TZ_OFFSET_MINUTES,
      quietGapMinutes: policy.quietGapMinutes ?? env.LIFE_QUIET_GAP_MINUTES,
      maxReachOutsPerDay: policy.maxReachOutsPerDay ?? env.LIFE_MAX_REACH_OUTS_PER_DAY,
      silentHours: {
        from: policy.silentFrom ?? DEFAULT_LIFE_CONFIG.silentHours.from,
        to: policy.silentTo ?? DEFAULT_LIFE_CONFIG.silentHours.to
      },
      reachOut: policy.reachOut ?? true
    };
  };
  const life = new LifeEngine(repos.life, lifeSettings, opts.clock);
  const context = new ContextBuilder(repos.messages, repos.summaries, memory, repos.media, mediaStore, env.ENABLE_LIFE_ENGINE ? life : undefined, env.LIFE_TIME_ZONE);
  const summarizer = new Summarizer(repos.messages, repos.summaries, capabilities, repos.errors, {
    triggerMessages: env.SUMMARY_TRIGGER_MESSAGES,
    chunkMessages: env.SUMMARY_CHUNK_MESSAGES,
    keepRecent: env.CONTEXT_RECENT_MESSAGES
  });
  const replier = new Replier({ messages: repos.messages, media: mediaStore, stickers: stickerLibrary, capabilities, context, bus, config, errorLog: repos.errors, settings: repos.settings });
  const replyCoordinator = new ReplyCoordinator({
    messages: repos.messages,
    batches: repos.replyBatches,
    replier,
    bus,
    debounceMs: opts.replyDebounceMs,
    onCompleted: (batchId, userMessages, outcome, owner) => {
      const tx = dbHandle.transaction(() => {
        if (!repos.replyBatches.completeInTransaction(batchId, outcome.messageId, owner)) {
          throw new Error(`lost reply batch lease: ${batchId}`);
        }
        if (!env.DISABLE_MEMORY_PIPELINE) repos.jobs.enqueue('memory.extract', { batchId, userMessageIds: userMessages.map((message) => message.id), assistantMessageId: outcome.messageId });
        repos.jobs.enqueue('push.reply', { batchId, messageId: outcome.messageId }, { maxAttempts: 3 });
        if (summarizer.needsSummary()) repos.jobs.enqueue('summary.build', { batchId });
      });
      tx();
    }
  });
  const backups = new BackupService({
    db: () => dbHandle,
    dbFile,
    backupDir: env.backupDir,
    mediaDir: env.mediaDir,
    keep: env.BACKUP_KEEP,
    maintenance: maintenanceCoordinator,
    closeForRestore: () => closeDatabase(dbHandle.raw),
    reopenAfterRestore: () => {
      const reopened = openDatabase({ file: dbFile, backupDir: env.backupDir, onLog: (level, msg, extra) => logger[level]({ ...extra }, msg) });
      dbHandle.swap(reopened.db);
    },
    readCounters: () => ({ messageSeq: repos.messages.maxSeq(), eventSeq: bus.lastSeq() }),
    afterRestore: (before) => {
      const next = reconcileCounters(dbHandle, { messageSeq: before.messageSeq, eventSeq: before.eventSeq });
      logger.warn({ ...next, before }, 'counters reconciled after restore');
    },
    onLog: (level, msg, extra) => logger[level]({ ...extra }, msg)
  });
  const worker = new JobWorker(repos.jobs, repos.errors, { intervalMs: 800 });
  registerDefaultJobs(worker, {
    jobs: repos.jobs,
    media: mediaStore,
    memory,
    summarizer,
    messages: repos.messages,
    bus,
    backups,
    life,
    capabilities,
    config,
    reachOutEnabled: env.ENABLE_LIFE_ENGINE && env.ENABLE_LIFE_REACH_OUT,
    push,
    storage,
    tmpDirs: [env.mediaDirs.tmp, env.mediaDirs.images, env.mediaDirs.audio, env.mediaDirs.files, env.dbDir]
  });

  const tools = new ToolRegistry();
  const agents = new AgentRegistry();
  const agentCapabilities = new CapabilityRegistryStub();
  for (const cap of ['chat', 'vision', 'summary', 'embedding', 'image', 'tts'] as const) {
    agentCapabilities.register({ name: cap, description: `model capability: ${cap}`, available: () => capabilities.has(cap) });
  }

  if (!opts.skipStickerImport) {
    const assetsDir = opts.assetsDir ?? resolveAssetsDir();
    if (assetsDir && fs.existsSync(assetsDir)) {
      try {
        const result = await stickerLibrary.importBuiltin(assetsDir);
        if (result.imported > 0) logger.info(result, 'imported built-in stickers');
        if (result.failed > 0) logger.warn(result, 'some built-in stickers failed to import');
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'sticker import failed');
      }
    } else {
      logger.warn({ assetsDir }, 'built-in sticker assets not found');
    }
  }

  const startupCounters = reconcileCounters(dbHandle);
  logger.debug(startupCounters, 'sequence counters reconciled at startup');
  const requeued = repos.jobs.recoverStuck();
  if (requeued > 0) logger.warn({ requeued }, 'requeued interrupted jobs');
  const orphaned = dbHandle.prepare(
    "UPDATE messages SET status = 'failed', error = 'interrupted by restart' WHERE status = 'sending' AND json_extract(meta_json, '$.batchId') IS NULL"
  ).run().changes;
  if (orphaned > 0) logger.warn({ orphaned }, 'marked interrupted assistant messages as failed');
  await cleanupTempFiles([env.mediaDirs.tmp, env.mediaDirs.images, env.mediaDirs.audio, env.mediaDirs.files]);

  const state = { startedAt: new Date().toISOString(), dbRecovered: opened.recovered, dbRecoveredFrom: opened.recoveredFrom, dbInconsistent: opened.inconsistent, version: VERSION };
  const server: FastifyInstance = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger, bodyLimit: env.MAX_BODY_BYTES, trustProxy: true });
  server.setErrorHandler((error, _request, reply) => {
    if (isSafeApplicationError(error)) {
      void reply.code(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : undefined;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      const safeExpectedErrors: Record<number, { error: string; message: string }> = {
        400: { error: 'bad_request', message: '请求格式不正确。' },
        401: { error: 'unauthorized', message: '需要有效的访问凭据。' },
        403: { error: 'forbidden', message: '无权执行此请求。' },
        404: { error: 'not_found', message: '请求的资源不存在。' },
        409: { error: 'conflict', message: '请求状态冲突。' },
        413: { error: 'request_too_large', message: '请求内容过大。' },
        429: { error: 'too_many_requests', message: '请求过于频繁，请稍后重试。' }
      };
      const safe = safeExpectedErrors[statusCode] ?? { error: 'request_rejected', message: '请求无法处理。' };
      void reply.code(statusCode).send(safe);
      return;
    }
    const failure = publicFailure('internal_error');
    const diagnostic = redactDiagnostic(error);
    void reply.code(500).send({
      error: failure.code,
      message: failure.message,
      incidentId: failure.incidentId
    });
    try {
      repos.errors.add('http.unexpected', failure.code, { incidentId: failure.incidentId, diagnostic });
    } catch (persistenceError) {
      try {
        server.log.error(
          { incidentId: failure.incidentId, diagnostic: redactDiagnostic(persistenceError) },
          'failed to persist unexpected request failure'
        );
      } catch {
        // Logging must never replace the already-sanitized client response.
      }
    }
    try {
      server.log.error({ incidentId: failure.incidentId, diagnostic }, 'unexpected request failure');
    } catch {
      // Logging is best-effort during an error boundary.
    }
  });
  const allowedOrigins = new Set(env.CORS_ALLOWED_ORIGINS);
  await server.register(cors, {
    origin: (origin, callback) => callback(null, origin !== undefined && allowedOrigins.has(origin)),
    credentials: false,
    allowedHeaders: ['content-type', 'x-sooya-token', 'x-admin-token', 'authorization']
  });
  await server.register(multipart, { limits: { fileSize: env.MAX_UPLOAD_BYTES, files: env.MAX_UPLOAD_FILES, fields: 20, fieldSize: 64 * 1024 } });

  const app: SooyaApp = {
    server,
    env,
    db: dbHandle,
    config,
    repos,
    services: { mediaStore, mediaVariants, stickerLibrary, capabilities, memory, life, push, storage, context, summarizer, replier, replyCoordinator, bus, worker, backups, agents, tools, agentCapabilities },
    state,
    fetchImpl: opts.fetchImpl,
    reopenDatabase: () => {
      const previous = dbHandle.raw;
      closeDatabase(previous);
      const reopened = openDatabase({ file: dbFile, backupDir: env.backupDir, onLog: (level, msg, extra) => logger[level]({ ...extra }, msg) });
      dbHandle.swap(reopened.db);
    },
    close: async () => {
      await replyCoordinator.stop();
      await worker.stop();
      try { await server.close(); } catch { /* ignore */ }
      closeDatabase(dbHandle.raw);
    }
  };

  replyCoordinator.recover({ recentMessages: env.CONTEXT_RECENT_MESSAGES, memoryLimit: env.CONTEXT_MEMORY_LIMIT });

  registerHealthRoutes(app);
  registerChatRoutes(app);
  registerMediaRoutes(app);
  registerStreamRoutes(app);
  registerAdminRoutes(app);
  registerFeatureRoutes(app);

  const configuredWebDir = env.webDir;
  const webDir = configuredWebDir ?? resolveWebDir();
  if (webDir && fs.existsSync(path.join(webDir, 'index.html'))) {
    await server.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      index: ['index.html'],
      wildcard: false,
      // send 的默认值是 max-age=0，见 staticCacheControl 的注释。
      cacheControl: false,
      // @fastify/static v10 把 reply 交给 setHeaders，不是 raw res。
      setHeaders: (reply, filePath) => {
        (reply as unknown as { header: (k: string, v: string) => unknown }).header(
          'cache-control',
          staticCacheControl(filePath)
        );
      }
    });
    server.get('/admin', async (_req, reply) => reply.type('text/html').sendFile('index.html'));
    server.get('/admin/', async (_req, reply) => reply.type('text/html').sendFile('index.html'));
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/health')) {
        void reply.code(404).send({ error: 'not_found' });
        return;
      }
      const pathname = new URL(req.url, 'http://x').pathname;
      const accept = String(req.headers.accept ?? '');
      const looksLikeAsset = /\.[a-z0-9]{2,5}$/i.test(pathname);
      if (looksLikeAsset || !accept.includes('text/html')) {
        void reply.code(404).send({ error: 'not_found' });
        return;
      }
      void reply.type('text/html').sendFile('index.html');
    });
    logger.info({ webDir }, 'serving web client');
  } else {
    logger.warn({ webDir }, 'web client build not found; API-only mode');
  }

  if (opts.startWorkers !== false && env.ENABLE_BACKGROUND_JOBS) {
    worker.start();
    scheduleRecurring(app);
  }
  return app;
}

function scheduleRecurring(app: SooyaApp): void {
  const { env, repos, services } = app;
  const maintenance = setInterval(() => {
    try {
      repos.jobs.enqueue('maintenance', {});
      services.bus.prune(2000);
    } catch { /* ignore */ }
  }, 30 * 60 * 1000);
  maintenance.unref?.();

  if (env.ENABLE_LIFE_ENGINE && env.LIFE_TICK_INTERVAL_MS > 0) {
    // Enqueued immediately as well: a restart should not leave her state
    // frozen at whatever she was doing when the process died.
    try { repos.jobs.enqueue('life.tick', {}); } catch { /* ignore */ }
    const life = setInterval(() => {
      try { repos.jobs.enqueue('life.tick', {}); } catch { /* ignore */ }
    }, env.LIFE_TICK_INTERVAL_MS);
    life.unref?.();
  }

  if (env.BACKUP_INTERVAL_MS > 0) {
    const backup = setInterval(() => {
      try { repos.jobs.enqueue('backup.create', { reason: 'scheduled' }); } catch { /* ignore */ }
    }, env.BACKUP_INTERVAL_MS);
    backup.unref?.();
  }
  if (env.BACKUP_ON_START) repos.jobs.enqueue('backup.create', { reason: 'startup' });
}

function resolveAssetsDir(): string | null {
  const candidates = [
    process.env.SOOYA_ASSETS_DIR,
    path.resolve(process.cwd(), 'assets/stickers'),
    path.resolve(process.cwd(), '../../assets/stickers'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../assets/stickers'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../assets/stickers')
  ].filter(Boolean) as string[];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}

function resolveWebDir(): string | null {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [path.resolve(process.cwd(), 'public'), path.resolve(process.cwd(), 'packages/web/dist'), path.resolve(here, '../public'), path.resolve(here, '../../../web/dist')];
  for (const candidate of candidates) if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  return null;
}

export { VERSION };
