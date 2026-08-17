import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { Logger } from 'pino';
import { loadEnv, type AppEnv } from './config/env.js';
import { createLogger } from './util/logger.js';
import { createProxyFetch } from './util/proxyFetch.js';
import { closeDatabase, openDatabase, reconcileCounters } from './db/index.js';
import { DbHandle } from './db/handle.js';
import { ConfigStore } from './config/store.js';
import { MediaRepo } from './db/repos/media.repo.js';
import { MessageRepo } from './db/repos/message.repo.js';
import { MemoryRepo } from './db/repos/memory.repo.js';
import { OmbreCommitRepo } from './db/repos/ombre.repo.js';
import { StickerRepo } from './db/repos/sticker.repo.js';
import { ErrorLogRepo, EventRepo, JobRepo, SettingsRepo, SummaryRepo } from './db/repos/misc.repo.js';
import { MediaTextRepo } from './db/repos/media-text.repo.js';
import { AuditRepo, PushSubscriptionRepo, StorageSampleRepo } from './db/repos/feature.repo.js';
import { MediaStore } from './media/store.js';
import { StickerLibrary } from './media/stickers.js';
import { StickerAnalyzer } from './core/stickers/analyzer.js';
import { StickerRetriever } from './core/stickers/retriever.js';
import { StickerPicker } from './core/stickers/picker.js';
import { StickerUserMeaningLearner } from './core/stickers/user-meaning.js';
import { PersonaReferenceLoader } from './media/persona-references.js';
import { ImageVariantService } from './media/variants.js';
import { CapabilityRegistry } from './core/capabilities.js';
import { DirectorClient } from './core/director/client.js';
import { MediaDirector } from './core/mediaDirector.js';
import { MemoryService } from './core/memory.js';
import { ContextBuilder } from './core/context.js';
import { Summarizer } from './core/summarizer.js';
import { Replier } from './core/replier.js';
import { isSafeApplicationError, publicFailure, redactDiagnostic } from './core/public-error.js';
import { LifeEngine, DEFAULT_LIFE_CONFIG, type LifeConfig, type LifeRuntime } from './core/life.js';
import { LifeRepo } from './db/repos/life.repo.js';
import { LifeV2Repo } from './db/repos/life-v2.repo.js';
import { LifeLocationRepo } from './db/repos/location.repo.js';
import { LocationService } from './core/location/service.js';
import { WeatherRepo } from './db/repos/weather.repo.js';
import { WeatherService } from './core/weather/service.js';
import { WorldContextService } from './core/world-context.js';
import { WorldPresenceCoordinator } from './core/world-presence.js';
import { MetricsRepo } from './db/repos/metrics.repo.js';
import { MetricsService } from './core/metrics.js';
import { createWeatherChain } from './core/weather/fallback.js';
import { ThoughtRepo } from './db/repos/thought.repo.js';
import { ThoughtsService } from './core/thoughts/service.js';
import { ThoughtPresenter } from './core/thoughts/presenter.js';
import { ThoughtSafetyFilter } from './core/thoughts/safety.js';
import { readThoughtsFlags } from './core/thoughts/flags.js';
import { LifeSimEngine } from './core/life2/engine.js';
import { ProactiveAttemptRepo } from './db/repos/proactive.repo.js';
import { MomentRepo } from './db/repos/moment.repo.js';
import { ReplyBatchRepo } from './db/repos/reply-batch.repo.js';
import { VoiceGenerationRepo } from './db/repos/voice.repo.js';
import { VoiceService } from './core/voice/service.js';
import { ReplyCoordinator } from './core/reply-coordinator.js';
import { MessageIngressService } from './core/message-ingress.js';
import { PushService } from './core/push.js';
import { ChannelEventRepo } from './db/repos/channel-event.repo.js';
import { ChannelIdentityRepo } from './db/repos/channel-identity.repo.js';
import { ChannelDeliveryRepo } from './db/repos/channel-delivery.repo.js';
import { QqChannel } from './channels/qq/channel.js';
import { qqBotConfigFromEnv } from './channels/qq/config.js';
import { QqApiClient } from './channels/qq/client.js';
import { QqDeliveryService } from './channels/qq/outbound.js';
import { ProactiveComposer } from './core/proactive.js';
import { StorageService } from './core/storage.js';
import { maintenanceCoordinator } from './core/maintenance.js';
import { WebSearchRegistry } from './core/web-search/registry.js';
import { EventBus } from './events/bus.js';
import { JobWorker, registerDefaultJobs } from './core/jobs.js';
import { BackupService } from './backup/service.js';
import { AgentRegistry, CapabilityRegistryStub, ToolRegistry } from './agent/registry.js';
import { ToolCallRuntime } from './agent/tool-runtime.js';
import { ToolPolicy } from './agent/tool-policy.js';
import { loadMcpConfig } from './mcp/config.js';
import { McpManager } from './mcp/manager.js';
import { OmbreMemoryBridge } from './core/ombre-memory.js';
import { OmbreAdminService } from './core/ombre-admin.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerQqRoutes } from './routes/qq.js';
import { registerQqAdminRoutes } from './routes/qq-admin.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerFeatureRoutes } from './routes/features.js';
import { registerVoiceRoutes } from './routes/voice.js';
import { registerLifeAdminRoutes } from './routes/life-admin.js';
import { registerThoughtRoutes } from './routes/thoughts.js';
import { registerMomentRoutes } from './routes/moments.js';
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
    mediaText: MediaTextRepo;
    memories: MemoryRepo;
    ombreCommits: OmbreCommitRepo;
    stickers: StickerRepo;
    summaries: SummaryRepo;
    jobs: JobRepo;
    settings: SettingsRepo;
    events: EventRepo;
    errors: ErrorLogRepo;
    pushSubscriptions: PushSubscriptionRepo;
    life: LifeRepo;
    proactive: ProactiveAttemptRepo;
    moments: MomentRepo;
    voice: VoiceGenerationRepo;
    lifeV2: LifeV2Repo;
    locations: LifeLocationRepo;
    weather: WeatherRepo;
    metrics: MetricsRepo;
    thoughts: ThoughtRepo;
    audit: AuditRepo;
    storageSamples: StorageSampleRepo;
    replyBatches: ReplyBatchRepo;
    channelEvents: ChannelEventRepo;
    channelIdentities: ChannelIdentityRepo;
    channelDeliveries: ChannelDeliveryRepo;
  };
  services: {
    mediaStore: MediaStore;
    mediaVariants: ImageVariantService;
    stickerLibrary: StickerLibrary;
    stickerAnalyzer: StickerAnalyzer;
    stickerRetriever: StickerRetriever;
    stickerPicker: StickerPicker;
    stickerUserMeaning: StickerUserMeaningLearner;
    capabilities: CapabilityRegistry;
    directorClient: DirectorClient;
    mediaDirector: MediaDirector;
    webSearch: WebSearchRegistry;
    memory: MemoryService;
    ombreMemory: OmbreMemoryBridge;
    ombreAdmin: OmbreAdminService;
    mcpManager: McpManager;
    toolPolicy: ToolPolicy;
    toolRuntime: ToolCallRuntime;
    life: LifeRuntime;
    proactive: ProactiveComposer;
    location: LocationService;
    weather: WeatherService;
    world: WorldContextService;
    presence: WorldPresenceCoordinator;
    metrics: MetricsService;
    thoughts: ThoughtsService;
    voice: VoiceService;
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
    ingress: MessageIngressService;
    qq: QqChannel;
    qqDelivery: QqDeliveryService;
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
  /** Handles started by scheduleRecurring; cleared on close() so tests don't leak timers. */
  recurringTimers: NodeJS.Timeout[];
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

  // Outbound proxy for provider calls when the host cannot reach the vendor
  // directly (SOOYA_HTTP_PROXY=socks5h://127.0.0.1:8082 for Fish from a CN
  // host). Node's native fetch ignores HTTPS_PROXY, so the providers receive
  // this implementation through the injectable fetchImpl seam instead.
  const fetchImpl = env.SOOYA_HTTP_PROXY ? createProxyFetch(env.SOOYA_HTTP_PROXY) : (opts.fetchImpl ?? fetch);

  for (const dir of [env.dataDir, env.dbDir, env.mediaDir, env.backupDir, env.logDir, ...Object.values(env.mediaDirs)]) ensureDirSync(dir);

  const dbFile = path.join(env.dbDir, 'sooya.db');
  const opened = openDatabase({ file: dbFile, backupDir: env.backupDir, onLog: (level, msg, extra) => logger[level]({ ...extra }, msg) });
  const dbHandle = new DbHandle(opened.db);
  const config = new ConfigStore({ configDir: env.configDir, env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv, onLog: (level, msg, extra) => logger[level]({ ...extra }, msg) });

  const mediaText = new MediaTextRepo(dbHandle);
  const repos = {
    messages: new MessageRepo(dbHandle, mediaText),
    media: new MediaRepo(dbHandle),
    mediaText,
    memories: new MemoryRepo(dbHandle),
    ombreCommits: new OmbreCommitRepo(dbHandle),
    stickers: new StickerRepo(dbHandle),
    summaries: new SummaryRepo(dbHandle),
    jobs: new JobRepo(dbHandle),
    settings: new SettingsRepo(dbHandle),
    events: new EventRepo(dbHandle),
    errors: new ErrorLogRepo(dbHandle),
    pushSubscriptions: new PushSubscriptionRepo(dbHandle),
    life: new LifeRepo(dbHandle),
    proactive: new ProactiveAttemptRepo(dbHandle),
    moments: new MomentRepo(dbHandle),
    voice: new VoiceGenerationRepo(dbHandle),
    lifeV2: new LifeV2Repo(dbHandle),
    locations: new LifeLocationRepo(dbHandle),
    weather: new WeatherRepo(dbHandle),
    metrics: new MetricsRepo(dbHandle),
    thoughts: new ThoughtRepo(dbHandle),
    audit: new AuditRepo(dbHandle),
    storageSamples: new StorageSampleRepo(dbHandle),
    replyBatches: new ReplyBatchRepo(dbHandle),
    channelEvents: new ChannelEventRepo(dbHandle),
    channelIdentities: new ChannelIdentityRepo(dbHandle),
    channelDeliveries: new ChannelDeliveryRepo(dbHandle)
  };

  const mediaStore = new MediaStore(env.mediaDirs, repos.media, { maxUploadBytes: env.MAX_UPLOAD_BYTES });
  const mediaVariants = new ImageVariantService(env.mediaDirs.variants, (message, id) => repos.errors.add('media.variant', message, { id }));
  const stickerLibrary = new StickerLibrary(repos.stickers, repos.media, mediaStore);
  mediaStore.setOnDelete(() => stickerLibrary.invalidate());
  const capabilities = new CapabilityRegistry(config, { allowPrivateNetwork: env.ALLOW_PRIVATE_NETWORK_FETCH, fetchImpl });
  const metrics = new MetricsService(repos.metrics, opts.clock, env.LIFE_TIME_ZONE);
  metrics.setEnabled(env.METRICS_DASHBOARD_ENABLED);
  const directorClient = new DirectorClient(
    () => capabilities.directorProvider(),
    { metrics, onEvent: (event) => logger.debug({ ...event }, `director.${event.event}`) }
  );
  const mediaDirector = new MediaDirector(directorClient);
  const stickerAnalyzer = new StickerAnalyzer(
    repos.stickers,
    mediaStore,
    () => capabilities.visionProvider(),
    (event, data) => logger.info({ ...data }, `sticker.analysis.${event}`)
  );
  const stickerRetriever = new StickerRetriever(
    repos.stickers,
    stickerLibrary,
    () => capabilities.embeddingProvider(),
    (error) => logger.warn({ error: redactDiagnostic(error) }, 'sticker embedding retrieval degraded')
  );
  const stickerPicker = new StickerPicker(
    directorClient,
    stickerRetriever,
    (event, data) => logger.info({ ...data }, `sticker.pick.${event}`)
  );
  const stickerUserMeaning = new StickerUserMeaningLearner(
    repos.stickers,
    repos.messages,
    () => capabilities.chatProvider()
  );
  const bus = new EventBus(repos.events);
  const tools = new ToolRegistry();
  const runtimeEnv = { ...process.env, ...opts.env } as NodeJS.ProcessEnv;
  const sharedMcpConfigPath = path.join(env.configDir, 'mcp.json');
  const bundledMcpConfigPath = path.join(process.cwd(), 'config', 'mcp.json');
  const mcpConfigPath = env.MCP_CONFIG_PATH
    ? path.resolve(env.MCP_CONFIG_PATH)
    : fs.existsSync(sharedMcpConfigPath) ? sharedMcpConfigPath : bundledMcpConfigPath;
  const mcpConfig = loadMcpConfig(mcpConfigPath, runtimeEnv);
  const mcpManager = new McpManager({
    servers: Object.values(mcpConfig.servers),
    registry: tools,
    env: runtimeEnv,
    onEvent: (event) => {
      logger.info({ serverId: event.serverId, detail: event.detail }, `mcp.${event.event}`);
      const eventType = `mcp.${event.event}` as import('./core/types.js').StreamEventType;
      bus.publish(eventType, { serverId: event.serverId, ...(event.detail ? { error: event.detail.slice(0, 300) } : {}) });
    }
  });
  const toolPolicy = new ToolPolicy(tools, {
    readEnabled: env.MCP_READ_ENABLED,
    writeEnabled: env.MCP_WRITE_ENABLED,
    maintenanceEnabled: env.MCP_MAINTENANCE_ENABLED,
    serverPolicies: {
      ombre: {
        readEnabled: env.OMBRE_READ_ENABLED,
        writeEnabled: env.OMBRE_WRITE_ENABLED,
        maintenanceEnabled: env.OMBRE_DREAM_ENABLED
      }
    }
  });
  const toolRuntime = new ToolCallRuntime({
    registry: tools,
    policy: toolPolicy,
    maxRounds: env.TOOL_MAX_ROUNDS,
    maxCallsPerRound: env.TOOL_MAX_CALLS_PER_ROUND,
    timeoutMs: env.TOOL_CALL_TIMEOUT_MS,
    resultMaxBytes: env.TOOL_RESULT_MAX_BYTES,
    totalResultMaxBytes: env.TOOL_TOTAL_RESULT_MAX_BYTES
  });
  const memory = new MemoryService(repos.memories, capabilities, repos.errors, { disabled: env.DISABLE_MEMORY_PIPELINE, config });
  const ombreMemory = new OmbreMemoryBridge({
    manager: mcpManager,
    registry: tools,
    policy: toolPolicy,
    runtime: toolRuntime,
    commits: repos.ombreCommits,
    chatProvider: () => capabilities.chatProvider(),
    breathIdleMinutes: env.OMBRE_BREATH_IDLE_MINUTES,
    bus
  });
  const ombreAdmin = new OmbreAdminService({
    manager: mcpManager,
    registry: tools,
    policy: toolPolicy,
    commits: repos.ombreCommits,
    memories: repos.memories,
    events: repos.events,
    configSource: mcpConfigPath,
    globalPolicy: {
      readEnabled: env.MCP_READ_ENABLED,
      writeEnabled: env.MCP_WRITE_ENABLED,
      maintenanceEnabled: env.MCP_MAINTENANCE_ENABLED
    },
    dashboardUrl: env.OMBRE_DASHBOARD_URL,
    bus
  });
  // Unit/e2e environments must remain hermetic: the default production
  // connection should never make every buildApp() wait on an absent external
  // Ombre service. Production and development keep the opt-out flag intact.
  if (env.MCP_CONNECT_ON_START && env.NODE_ENV !== 'test') await mcpManager.connectAllBestEffort();
  const push = new PushService(repos.pushSubscriptions, repos.settings, repos.errors, fetchImpl, env.SOOYA_PUSH_SUBJECT);
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
      reachOut: policy.reachOut ?? true,
      proactiveMode: policy.proactiveMode ?? DEFAULT_LIFE_CONFIG.proactiveMode
    };
  };
  // Weather identity is the active city (city + country), never a location id.
  let location: LocationService;
  const cityWeatherCondition = (): string | null => {
    const city = location.activeCity();
    if (!city) return null;
    const country = city.country ?? '中国';
    const region = city.region ?? null;
    return weather.cachedCondition({ key: `${country}|${region ?? ''}|${city.name}`, country, region, city: city.name });
  };
  location = new LocationService(repos.locations, repos.audit, opts.clock, cityWeatherCondition, { timeZone: env.LIFE_TIME_ZONE });
  location.setEnabled(env.WORLD_CONTEXT_ENABLED && env.LOCATION_MODEL_ENABLED);
  const weather = new WeatherService(repos.weather, repos.locations, repos.life, opts.clock);
  weather.setEnabled(env.WORLD_CONTEXT_ENABLED && env.WEATHER_ENABLED);
  // Production provider chain (primary -> secondary -> cache -> unknown);
  // the default Open-Meteo provider is keyless, while an explicit unknown
  // provider still falls back to the inert no-op adapter.
  weather.setProvider(createWeatherChain({
    provider: env.WEATHER_PROVIDER,
    baseUrl: env.WEATHER_BASE_URL,
    geocodingBaseUrl: env.WEATHER_GEOCODING_BASE_URL,
    apiKey: env.WEATHER_API_KEY,
    timeoutMs: env.WEATHER_TIMEOUT_MS,
    fetchImpl,
    clock: opts.clock
  }, repos.weather));
  const world = new WorldContextService(location, weather, opts.clock, env.LIFE_TIME_ZONE, repos.locations);
  const presence = new WorldPresenceCoordinator(world, location, bus);
  presence.initialize();
  const webSearch = new WebSearchRegistry({
    fetchImpl,
    onError: (provider, error) =>
      repos.errors.add('web-search', `${provider}:unavailable`, { diagnostic: redactDiagnostic(error) })
  });
  webSearch.rebuild(config.getModels().webSearch);
  // Thread location tags: real open threads feed the location selector.
  location.setThreadsProvider(() => repos.lifeV2.threads('open'));
  const life = env.ENABLE_LIFE_V2
    ? new LifeSimEngine(repos.life, repos.lifeV2, lifeSettings, opts.clock, location, weather, metrics)
    : new LifeEngine(repos.life, lifeSettings, opts.clock);
  const voiceService = new VoiceService({
    messages: repos.messages,
    media: mediaStore,
    voice: repos.voice,
    batches: repos.replyBatches,
    capabilities,
    mediaDirector,
    config,
    settings: repos.settings,
    bus,
    errorLog: repos.errors,
    flags: {
      independentScript: env.VOICE_INDEPENDENT_SCRIPT_ENABLED,
      naturalnessGuard: env.VOICE_NATURALNESS_GUARD_ENABLED,
      advancedDelivery: env.VOICE_ADVANCED_DELIVERY_ENABLED,
      autoComplement: env.VOICE_AUTO_COMPLEMENT_ENABLED,
      readAloud: env.VOICE_READ_ALOUD_ENABLED,
      ttsRetries: env.VOICE_TTS_RETRIES
    },
    metrics
  });
  voiceService.dailyAutoCap = env.VOICE_DAILY_AUTO_CAP;

  const context = new ContextBuilder(
    repos.messages,
    repos.summaries,
    env.MEMORY_BACKEND === 'legacy' ? memory : null,
    repos.media,
    mediaStore,
    repos.mediaText,
    repos.stickers,
    stickerLibrary,
    env.ENABLE_LIFE_ENGINE ? life : undefined,
    env.LIFE_TIME_ZONE,
    () => world.snapshot()
  );
  const summarizer = new Summarizer(repos.messages, repos.summaries, capabilities, repos.errors, {
    triggerMessages: env.SUMMARY_TRIGGER_MESSAGES,
    chunkMessages: env.SUMMARY_CHUNK_MESSAGES,
    keepRecent: env.CONTEXT_RECENT_MESSAGES
  });
  const personaReferences = new PersonaReferenceLoader(resolveReferencesDir(env), () => config.getPersona().referenceImages, (level, msg, extra) => logger[level]({ ...extra }, msg));

  const replier = new Replier({ messages: repos.messages, media: mediaStore, stickers: stickerLibrary, stickerPicker, capabilities, mediaDirector, context, bus, config, errorLog: repos.errors, settings: repos.settings, personaReferences, voice: voiceService, voiceV2Enabled: env.VOICE_V2_ENABLED, webSearch, worldSnapshot: () => world.snapshot(), toolRuntime, ombreMemory });
  const thoughtFlags = readThoughtsFlags(process.env);
  const thoughts = new ThoughtsService({
    flags: thoughtFlags,
    repo: repos.thoughts,
    context: {
      worldSnapshot: () => world.snapshot(),
      lifeSummary: () => { const snap = life.snapshot(); return { activity: snap.activity, mood: snap.mood }; },
      memoryRecallStats: () => { try { return context.memoryRecallTrace(); } catch { return null; } },
      voiceRowFor: (messageId: string) => repos.voice.latestForMessage(messageId)
    },
    presenter: new ThoughtPresenter({
      repo: repos.thoughts,
      chat: () => capabilities.chatProvider(),
      safety: new ThoughtSafetyFilter(),
      bus,
      errorLog: repos.errors,
      safetyRefs: { personaName: config.getPersona().name },
      timeoutMs: thoughtFlags.thoughtTimeoutMs
    }),
    messages: repos.messages,
    errorLog: repos.errors
  });
  const replyCoordinator = new ReplyCoordinator({
    messages: repos.messages,
    batches: repos.replyBatches,
    replier,
    bus,
    db: dbHandle,
    initialDebounceMs: opts.replyDebounceMs ?? env.REPLY_INITIAL_DEBOUNCE_MS,
    interruptDebounceMs: env.REPLY_INTERRUPT_DEBOUNCE_MS,
    maxCollectionMs: env.REPLY_MAX_COLLECTION_MS,
    publishGraceMs: env.REPLY_PUBLISH_GRACE_MS,
    requestTimeoutMs: env.CHAT_REQUEST_TIMEOUT_MS,
    timeoutRetries: env.CHAT_TIMEOUT_RETRIES,
    retryBaseDelayMs: env.CHAT_RETRY_BASE_DELAY_MS,
    interruptible: env.REPLY_INTERRUPTIBLE_GENERATION,
    errorLog: repos.errors,
    metrics,
    thoughts,
    onCompleted: (batchId, userMessages, outcome, owner, revision) => {
      // The batch is already marked completed by the coordinator (revision-
      // fenced); this hook only enqueues the downstream jobs atomically.
      const tx = dbHandle.transaction(() => {
        if (!env.DISABLE_MEMORY_PIPELINE) {
repos.jobs.enqueue(
          env.MEMORY_BACKEND === 'ombre' ? 'ombre.memory_commit' : 'memory.extract',
          { batchId, revision, userMessageIds: userMessages.map((message) => message.id), assistantMessageId: outcome.messageId }
        );
      }
      // QQ 单通道（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §8.2）：回复完成后入队
      // durable qq.deliver，由 outbox 负责幂等/重试；push.reply 在 QQ 停用（回滚/降级）
      // 时保留，直到 PR7 彻底下线。
      if (qqConfig.enabled) {
        repos.jobs.enqueue('qq.deliver', { messageId: outcome.messageId });
      } else {
        repos.jobs.enqueue('push.reply', { batchId, messageId: outcome.messageId }, { maxAttempts: 3 });
      }
      if (summarizer.needsSummary()) repos.jobs.enqueue('summary.build', { batchId });
      // Life conversation bridge (§49-50): extracted as a durable job; the
      // handler re-checks the revision so only the final one applies.
      if (env.ENABLE_LIFE_ENGINE && env.ENABLE_LIFE_V2) {
          repos.jobs.enqueue('life.conversation', {
            batchId,
            revision,
            userMessageIds: userMessages.map((message) => message.id),
            lastUserMessageId: userMessages.at(-1)?.id ?? null,
            warmth: outcome.ok ? 'warm' : 'neutral'
          });
        }
      });
      tx();
    }
  });

  const ingress = new MessageIngressService({
    db: dbHandle,
    messages: repos.messages,
    replyBatches: repos.replyBatches,
    media: repos.media,
    stickers: repos.stickers,
    jobs: repos.jobs,
    errors: repos.errors,
    bus,
    config,
    mediaStore,
    replyCoordinator,
    replyOptions: { recentMessages: env.CONTEXT_RECENT_MESSAGES, memoryLimit: env.CONTEXT_MEMORY_LIMIT }
  });

  const qqConfig = qqBotConfigFromEnv({ ...process.env, ...opts.env });

  const qq = new QqChannel({
    config: qqConfig,
    events: repos.channelEvents,
    identities: repos.channelIdentities,
    ingress,
    errors: repos.errors,
    metrics
  });

  const qqApi = new QqApiClient(qqConfig, { fetchImpl });
  const qqDelivery = new QqDeliveryService({
    deliveries: repos.channelDeliveries,
    identities: repos.channelIdentities,
    events: repos.channelEvents,
    messages: repos.messages,
    replyBatches: repos.replyBatches,
    media: repos.media,
    mediaStore,
    jobs: repos.jobs,
    errors: repos.errors,
    client: qqApi,
    metrics
  });

  const proactive = new ProactiveComposer({
    attempts: repos.proactive,
    replyBatches: repos.replyBatches,
    messages: repos.messages,
    moments: repos.moments,
    life,
    capabilities,
    config,
    media: mediaStore,
    bus,
    coordinator: replyCoordinator,
    metrics,
    mediaDirector,
    personaReferences,
    locations: repos.locations,
    worldSnapshot: () => world.snapshot(),
    toolRuntime,
    jobs: repos.jobs,
    deliveries: repos.channelDeliveries,
    qqDeliveryEnabled: qqConfig.enabled
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
    batches: repos.replyBatches,
    ombreCommits: repos.ombreCommits,
    settings: repos.settings,
    media: mediaStore,
    memory,
    ombreMemory,
    memoryBackend: env.MEMORY_BACKEND,
    summarizer,
    messages: repos.messages,
    bus,
    backups,
    life,
    presence,
    proactive,
    capabilities,
    stickerAnalyzer,
    stickerRepo: repos.stickers,
    stickerUserMeaning,
    config,
    reachOutEnabled: env.ENABLE_LIFE_ENGINE && env.ENABLE_LIFE_REACH_OUT,
    push,
    storage,
    mediaText: repos.mediaText,
    tmpDirs: [env.mediaDirs.tmp, env.mediaDirs.images, env.mediaDirs.audio, env.mediaDirs.files, env.dbDir],
    qqDelivery
  });

  const agents = new AgentRegistry();
  const agentCapabilities = new CapabilityRegistryStub();
  for (const cap of ['chat', 'vision', 'summary', 'director', 'embedding', 'image', 'tts'] as const) {
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
  const enqueuePendingStickerMaintenance = (): void => {
    if (opts.startWorkers === false || !env.ENABLE_BACKGROUND_JOBS) return;
    // Startup maintenance must yield to interactive jobs (chat completion,
    // life bridge, memory and push). A large legacy catalogue can otherwise
    // occupy the single durable worker long enough to make a fresh reply look
    // stuck. The jobs remain durable and will be claimed once this short grace
    // period expires.
    const runAfter = new Date(Date.now() + 30_000).toISOString();
    const jobs = repos.jobs.list(500);
    const activeAnalysis = jobs.some((job) =>
      (job.type === 'sticker.analyze' || job.type === 'sticker.analyze.backfill')
      && (job.status === 'pending' || job.status === 'running')
    );
    const hasPendingAnalysis = repos.stickers.list({ enabledOnly: true }).some((sticker) =>
      sticker.analysisStatus !== 'ready' && sticker.analysisSource !== 'manual'
    );
    if (capabilities.visionProvider() && hasPendingAnalysis && !activeAnalysis) {
      repos.jobs.enqueue('sticker.analyze.backfill', {}, { maxAttempts: 2, runAfter });
    }
    if (capabilities.has('embedding')) {
      const embedding = config.getModels().embedding;
      const needsBackfill = repos.stickers.list({ enabledOnly: true }).some((sticker) =>
        sticker.analysisStatus === 'ready' && (
          !sticker.embedding
          || (embedding.model.trim().length > 0 && sticker.embeddingModel !== embedding.model.trim())
          || (embedding.dimensions !== undefined && sticker.embeddingDim !== embedding.dimensions)
        )
      );
      const activeBackfill = jobs.some((job) => job.type === 'sticker.embed.backfill' && (job.status === 'pending' || job.status === 'running'));
      if (needsBackfill && !activeBackfill) repos.jobs.enqueue('sticker.embed.backfill', {}, { runAfter });
    }
  };
  enqueuePendingStickerMaintenance();

  const startupCounters = reconcileCounters(dbHandle);
  logger.debug(startupCounters, 'sequence counters reconciled at startup');
  const requeued = repos.jobs.recoverStuck();
  if (requeued > 0) logger.warn({ requeued }, 'requeued interrupted jobs');
  const orphaned = dbHandle.prepare(
    "UPDATE messages SET status = 'failed', error = 'interrupted by restart' WHERE status = 'sending' AND batch_id IS NULL"
  ).run().changes;
  if (orphaned > 0) logger.warn({ orphaned }, 'marked interrupted assistant messages as failed');
  /*
   * Messages already marked failed (e.g. interrupted batch shells) may still
   * hold image/audio parts stuck in 'pending'; the frontend would render them
   * as "generating…" forever. After a restart nothing will ever finish them,
   * so mark them failed too. Runs AFTER the update above so newly orphaned
   * messages are covered as well.
   */
  const orphanedParts = dbHandle.prepare(
    `UPDATE message_parts SET status = 'failed', error = 'interrupted by restart'
     WHERE status = 'pending' AND type IN ('image', 'audio')
       AND message_id IN (SELECT id FROM messages WHERE status = 'failed')`
  ).run().changes;
  if (orphanedParts > 0) logger.warn({ orphanedParts }, 'marked interrupted media parts as failed');
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
  // 不设 limits.files：multipart 库会在第 N+1 个文件直接抛 413，打断 media.ts 对超限分片的
  // resume 排空。文件数上限由业务计数接管；请求总大小仍受 bodyLimit 与 fileSize 双重约束。
  await server.register(multipart, { limits: { fileSize: env.MAX_UPLOAD_BYTES, fields: 20, fieldSize: 64 * 1024 } });
  /*
   * QQ webhook 的 Ed25519 签名覆盖「timestamp + 原始 Body 字节」，所以 JSON 解析
   * 必须保留原始字节。这里替换默认 JSON 解析器：解析语义不变（utf8 → JSON.parse 同
   * Fastify 默认），只是把原始 Buffer 挂在 req.rawBody 上供 routes/qq.ts 校验。
   */
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as { rawBody?: Buffer }).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (error) {
      done(error as Error);
    }
  });

  let stopModelWatcher: (() => void) | null = null;
  const app: SooyaApp = {
    server,
    env,
    db: dbHandle,
    config,
    repos,
    services: { mediaStore, mediaVariants, stickerLibrary, stickerAnalyzer, stickerRetriever, stickerPicker, stickerUserMeaning, capabilities, directorClient, mediaDirector, webSearch, memory, ombreMemory, ombreAdmin, mcpManager, toolPolicy, toolRuntime, life, proactive, location, weather, world, presence, metrics, thoughts, voice: voiceService, push, storage, context, summarizer, replier, replyCoordinator, bus, worker, backups, agents, tools, agentCapabilities, ingress, qq, qqDelivery },
    state,
    fetchImpl,
    recurringTimers: [],
    reopenDatabase: () => {
      const previous = dbHandle.raw;
      closeDatabase(previous);
      const reopened = openDatabase({ file: dbFile, backupDir: env.backupDir, onLog: (level, msg, extra) => logger[level]({ ...extra }, msg) });
      dbHandle.swap(reopened.db);
    },
    close: async () => {
      stopModelWatcher?.();
      stopModelWatcher = null;
      for (const timer of app.recurringTimers.splice(0)) clearInterval(timer);
      await replyCoordinator.stop();
      await worker.stop();
      await mcpManager.close();
      try { await server.close(); } catch { /* ignore */ }
      closeDatabase(dbHandle.raw);
    }
  };
  stopModelWatcher = config.watchModels(() => {
    capabilities.rebuild();
    webSearch.rebuild(config.getModels().webSearch);
    enqueuePendingStickerMaintenance();
  });

  repos.voice.recoverInFlight();
  repos.channelDeliveries.recoverInFlight();
  replyCoordinator.recover({ recentMessages: env.CONTEXT_RECENT_MESSAGES, memoryLimit: env.CONTEXT_MEMORY_LIMIT });

  registerHealthRoutes(app);
  registerQqRoutes(app);
  registerChatRoutes(app);
  registerAdminRoutes(app);
  registerQqAdminRoutes(app);
  registerMediaRoutes(app);
  registerStreamRoutes(app);
  registerVoiceRoutes(app);
  registerLifeAdminRoutes(app);
  registerThoughtRoutes(app);
  registerMomentRoutes(app);
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
  const enqueueIfIdle = (type: string, payload: Record<string, unknown>): void => {
    try {
      if (!repos.jobs.hasActive(type)) repos.jobs.enqueue(type, payload);
    } catch { /* scheduling is best effort and never blocks chat */ }
  };
  /*
   * 到期待投递的兜底扫描（QQ 单通道 §9.2）：主路径是失败重试时自行重新入队；
   * 这里覆盖「入队后进程崩溃 / 定时器丢失 / 重启」等漏网场景。deliver() 内部
   * 用条件领取保证并发安全，重复入队无副作用。
   */
  const enqueueDueQqDeliveries = (): void => {
    if (!env.QQ_BOT_ENABLED) return;
    try {
      for (const row of repos.channelDeliveries.dueNow('qq', 20)) {
        repos.jobs.enqueue('qq.deliver', { messageId: row.message_id }, { runAfter: row.next_retry_at ?? undefined, maxAttempts: 1 });
      }
    } catch { /* best effort */ }
  };
  // 启动即兜底扫描一次：恢复重启前已在 outbox 里的待发消息。
  enqueueDueQqDeliveries();
  const maintenance = setInterval(() => {
    try {
      repos.jobs.enqueue('maintenance', {});
      services.bus.prune(env.EVENTS_KEEP);
      enqueueDueQqDeliveries();
      // 周期性兜底：入队后因进程内异常或计时器丢失而滞留的批次，靠重启之外的另一条
      // 路径重新拉起，避免「消息发出去了但永远等不到回复」。recover 只碰开放批次，幂等。
      services.replyCoordinator.recover({ recentMessages: env.CONTEXT_RECENT_MESSAGES, memoryLimit: env.CONTEXT_MEMORY_LIMIT });
    } catch { /* ignore */ }
  }, 30 * 60 * 1000);
  maintenance.unref?.();
  app.recurringTimers.push(maintenance);

  if (env.ENABLE_LIFE_ENGINE && env.LIFE_TICK_INTERVAL_MS > 0) {
    // Enqueued immediately as well: a restart should not leave her state
    // frozen at whatever she was doing when the process died.
    try { repos.jobs.enqueue('life.tick', {}); } catch { /* ignore */ }
    const life = setInterval(() => {
      try { repos.jobs.enqueue('life.tick', {}); } catch { /* ignore */ }
    }, env.LIFE_TICK_INTERVAL_MS);
    life.unref?.();
    app.recurringTimers.push(life);
  }

  if (env.WORLD_CONTEXT_ENABLED && env.LOCATION_MODEL_ENABLED) {
    const presence = setInterval(() => {
      try { void services.presence.sync('timer'); } catch { /* ignore */ }
    }, 60_000);
    presence.unref?.();
    app.recurringTimers.push(presence);
  }

  if (env.WORLD_CONTEXT_ENABLED && env.LOCATION_MODEL_ENABLED && env.WEATHER_ENABLED && env.WEATHER_REFRESH_INTERVAL_MS > 0) {
    try { repos.jobs.enqueue('weather.refresh', { reason: 'startup' }); } catch { /* ignore */ }
    const weather = setInterval(() => {
      try { repos.jobs.enqueue('weather.refresh', { reason: 'scheduled' }); } catch { /* ignore */ }
    }, env.WEATHER_REFRESH_INTERVAL_MS);
    weather.unref?.();
    app.recurringTimers.push(weather);
  }

  if (env.MEMORY_BACKEND === 'ombre' && env.MCP_TOOL_REFRESH_INTERVAL_MS > 0) {
    const refreshTools = setInterval(() => {
      enqueueIfIdle('ombre.refresh_tools', { reason: 'scheduled' });
    }, env.MCP_TOOL_REFRESH_INTERVAL_MS);
    refreshTools.unref?.();
    app.recurringTimers.push(refreshTools);
  }

  if (env.MEMORY_BACKEND === 'ombre' && env.OMBRE_DREAM_ENABLED && env.OMBRE_DREAM_INTERVAL_MS > 0) {
    const enqueueDreamIfEligible = (reason: string): void => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const latest = repos.ombreCommits.latestCompleted();
      if (!latest?.completed_at || latest.completed_at < since) return;
      const lastDreamAt = repos.settings.get<string | null>('ombre.lastDreamAt', null);
      const lastDreamCommitAt = repos.settings.get<string | null>('ombre.lastDreamCommitAt', null);
      const dreamAt = lastDreamAt ? Date.parse(lastDreamAt) : NaN;
      if (Number.isFinite(dreamAt) && Date.now() - dreamAt < env.OMBRE_DREAM_INTERVAL_MS) return;
      if (lastDreamCommitAt && latest.completed_at <= lastDreamCommitAt) return;
      enqueueIfIdle('ombre.dream', { reason, commitAt: latest.completed_at });
    };
    enqueueDreamIfEligible('startup');
    const dream = setInterval(() => enqueueDreamIfEligible('scheduled'), env.OMBRE_DREAM_INTERVAL_MS);
    dream.unref?.();
    app.recurringTimers.push(dream);
  }

  if (env.BACKUP_INTERVAL_MS > 0) {
    const backup = setInterval(() => {
      try { repos.jobs.enqueue('backup.create', { reason: 'scheduled' }); } catch { /* ignore */ }
    }, env.BACKUP_INTERVAL_MS);
    backup.unref?.();
    app.recurringTimers.push(backup);
  }
  if (env.BACKUP_ON_START) repos.jobs.enqueue('backup.create', { reason: 'startup' });
}

// 用 fileURLToPath 而非 new URL(import.meta.url).pathname：后者在 Windows 上产生 /C:/... 且不解码百分号。
const here = path.dirname(fileURLToPath(import.meta.url));

function resolveAssetsDir(): string | null {
  const candidates = [
    process.env.SOOYA_ASSETS_DIR,
    path.resolve(process.cwd(), 'assets/stickers'),
    path.resolve(process.cwd(), '../../assets/stickers'),
    path.resolve(here, '../../../assets/stickers'),
    path.resolve(here, '../../../../assets/stickers')
  ].filter(Boolean) as string[];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}

export function resolveReferencesDir(env?: { SOOYA_REFERENCES_DIR?: string }): string | null {
  // 显式配置优先：生产可以把参考图放在代码目录之外的持久化位置，
  // 管理面板上传的图才不会随代码升级被覆盖。目录不存在也返回，
  // 上传路由会负责创建；加载器读不到文件时自己会降级并报警。
  const explicit = (env?.SOOYA_REFERENCES_DIR ?? process.env.SOOYA_REFERENCES_DIR)?.trim();
  if (explicit) return path.resolve(explicit);
  const stickersDir = resolveAssetsDir();
  if (!stickersDir) return null;
  const refsDir = path.join(path.dirname(stickersDir), 'references');
  return fs.existsSync(refsDir) ? refsDir : null;
}

function resolveWebDir(): string | null {
  const candidates = [path.resolve(process.cwd(), 'public'), path.resolve(process.cwd(), 'packages/web/dist'), path.resolve(here, '../public'), path.resolve(here, '../../../web/dist')];
  for (const candidate of candidates) if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  return null;
}

export { VERSION };
