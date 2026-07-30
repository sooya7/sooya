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
import { AuditRepo, PushSubscriptionRepo, StorageSampleRepo, WorldRepo } from './db/repos/feature.repo.js';
import { MediaStore } from './media/store.js';
import { StickerLibrary } from './media/stickers.js';
import { CapabilityRegistry } from './core/capabilities.js';
import { MemoryService } from './core/memory.js';
import { ContextBuilder } from './core/context.js';
import { Summarizer } from './core/summarizer.js';
import { Replier } from './core/replier.js';
import { isSafeApplicationError, publicFailure, redactDiagnostic } from './core/public-error.js';
import { WorldEngine } from './core/world.js';
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
  logger?: Logger;
  skipStickerImport?: boolean;
  assetsDir?: string;
  fetchImpl?: typeof fetch;
  startWorkers?: boolean;
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
    world: WorldRepo;
    audit: AuditRepo;
    storageSamples: StorageSampleRepo;
  };
  services: {
    mediaStore: MediaStore;
    stickerLibrary: StickerLibrary;
    capabilities: CapabilityRegistry;
    memory: MemoryService;
    world: WorldEngine;
    push: PushService;
    storage: StorageService;
    context: ContextBuilder;
    summarizer: Summarizer;
    replier: Replier;
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
    version: string;
  };
  reopenDatabase: () => void;
  close: () => Promise<void>;
}

const VERSION = '1.0.0';

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
    world: new WorldRepo(dbHandle),
    audit: new AuditRepo(dbHandle),
    storageSamples: new StorageSampleRepo(dbHandle)
  };

  const mediaStore = new MediaStore(env.mediaDirs, repos.media, { maxUploadBytes: env.MAX_UPLOAD_BYTES });
  const stickerLibrary = new StickerLibrary(repos.stickers, repos.media, mediaStore);
  const capabilities = new CapabilityRegistry(config, { allowPrivateNetwork: env.ALLOW_PRIVATE_NETWORK_FETCH, fetchImpl: opts.fetchImpl });
  const bus = new EventBus(repos.events);
  const memory = new MemoryService(repos.memories, capabilities, repos.errors, { disabled: env.DISABLE_MEMORY_PIPELINE });
  const world = new WorldEngine(repos.world, capabilities, repos.errors, repos.messages);
  const push = new PushService(repos.pushSubscriptions, repos.settings, repos.errors, opts.fetchImpl, env.SOOYA_PUSH_SUBJECT);
  const storage = new StorageService(env, repos.media, mediaStore, repos.settings, repos.audit, repos.storageSamples, config, repos.errors, maintenanceCoordinator);
  const context = new ContextBuilder(repos.messages, repos.summaries, memory, repos.media, mediaStore, world);
  const summarizer = new Summarizer(repos.messages, repos.summaries, capabilities, repos.errors, {
    triggerMessages: env.SUMMARY_TRIGGER_MESSAGES,
    chunkMessages: env.SUMMARY_CHUNK_MESSAGES,
    keepRecent: env.CONTEXT_RECENT_MESSAGES
  });
  const replier = new Replier({ messages: repos.messages, media: mediaStore, stickers: stickerLibrary, capabilities, context, bus, config, errorLog: repos.errors, settings: repos.settings });
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
    world,
    push,
    storage,
    tmpDirs: [env.mediaDirs.tmp, env.mediaDirs.images, env.mediaDirs.audio, env.mediaDirs.files, env.dbDir]
  });

  const tools = new ToolRegistry();
  const agents = new AgentRegistry();
  const agentCapabilities = new CapabilityRegistryStub();
  for (const cap of ['chat', 'vision', 'summary', 'embedding', 'image', 'tts', 'stt'] as const) {
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
  const orphaned = dbHandle.prepare("UPDATE messages SET status = 'failed', error = 'interrupted by restart' WHERE status = 'sending'").run().changes;
  if (orphaned > 0) logger.warn({ orphaned }, 'marked interrupted assistant messages as failed');
  await cleanupTempFiles([env.mediaDirs.tmp, env.mediaDirs.images, env.mediaDirs.audio, env.mediaDirs.files]);

  const state = { startedAt: new Date().toISOString(), dbRecovered: opened.recovered, dbRecoveredFrom: opened.recoveredFrom, version: VERSION };
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
    services: { mediaStore, stickerLibrary, capabilities, memory, world, push, storage, context, summarizer, replier, bus, worker, backups, agents, tools, agentCapabilities },
    state,
    reopenDatabase: () => {
      const previous = dbHandle.raw;
      closeDatabase(previous);
      const reopened = openDatabase({ file: dbFile, backupDir: env.backupDir, onLog: (level, msg, extra) => logger[level]({ ...extra }, msg) });
      dbHandle.swap(reopened.db);
    },
    close: async () => {
      await worker.stop();
      try { await server.close(); } catch { /* ignore */ }
      closeDatabase(dbHandle.raw);
    }
  };

  registerHealthRoutes(app);
  registerChatRoutes(app);
  registerMediaRoutes(app);
  registerStreamRoutes(app);
  registerAdminRoutes(app);
  registerFeatureRoutes(app);

  const configuredWebDir = env.webDir;
  const webDir = configuredWebDir ?? resolveWebDir();
  if (webDir && fs.existsSync(path.join(webDir, 'index.html'))) {
    await server.register(fastifyStatic, { root: webDir, prefix: '/', index: ['index.html'], wildcard: false });
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
