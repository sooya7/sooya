import path from 'node:path';
import { z } from 'zod';

/**
 * Environment configuration for SOOYA.
 * Everything is optional except the data root: the bot must boot even when no
 * AI capability is configured at all.
 */
const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return def;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const intish = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected number, got ${v}` });
        return def;
      }
      return Math.trunc(n);
    });

const originList = z
  .string()
  .optional()
  .transform((value) => {
    if (!value?.trim()) return [];
    return [...new Set(value.split(',').map((origin) => origin.trim()).filter(Boolean))];
  });

/**
 * Which proxies may set `X-Forwarded-For`, i.e. who is allowed to tell us the
 * client's address. Fastify derives `req.ip` from this, and `req.ip` is the
 * rate limiter's per-client key (util/rate-limit.ts).
 *
 * The default is `loopback`, matching the documented deployment (Nginx on the
 * same host, deploy/nginx.conf.example). It used to be an unconditional
 * `true`, which trusts the header from *any* source: a directly reachable
 * instance would then let a caller pick its own rate-limit bucket by sending
 * a forged header, and every logged client address became attacker-chosen.
 *
 * Accepted values: `false`/`off` (never trust), `true` (trust everything —
 * only sane when nothing untrusted can reach the port), or a comma-separated
 * list of proxy addresses/CIDRs (`loopback`, `10.0.0.0/8`, …).
 *
 * A hop count is deliberately NOT accepted. Fastify removed hop-count support
 * from `trustProxy` in 5.12 for GHSA-3m5p-2c4r-xxw2: counting hops lets a
 * caller prepend entries to `X-Forwarded-For` and land on any address it
 * likes, so `TRUST_PROXY=2` was never the protection it looked like. An
 * existing numeric value is rejected loudly rather than silently reinterpreted
 * as an address — a config that quietly stops meaning what it said is how the
 * unconditional `true` survived in the first place.
 */
const trustProxy = z
  .string()
  .optional()
  .transform((value, ctx): boolean | string => {
    const raw = value?.trim();
    if (!raw) return 'loopback';
    const lowered = raw.toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (/^\d+$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `hop counts are not supported (got ${raw}); they allow X-Forwarded-For spoofing `
          + '(GHSA-3m5p-2c4r-xxw2). Use "loopback", an address/CIDR list, true or false'
      });
      return 'loopback';
    }
    return raw;
  });

const webSearchProviders = z
  .string()
  .optional()
  .transform((value, ctx): Array<'doubao' | 'tavily' | 'responses'> => {
    const raw = value?.trim() || 'doubao,tavily,responses';
    const providers = [...new Set(raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
    const invalid = providers.filter((item) => item !== 'doubao' && item !== 'tavily' && item !== 'responses');
    if (invalid.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown web search provider: ${invalid.join(', ')}`
      });
      return [];
    }
    return providers as Array<'doubao' | 'tavily' | 'responses'>;
  });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: intish(8788),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATA_DIR: z.string().default('./data'),
  CONFIG_DIR: z.string().default('./config'),
  WEB_DIR: z.string().optional(),
  /* 参考图目录。生产部署应指向 shared 等持久化位置；不设置时仅为本地开发兼容尝试同级 references。 */
  SOOYA_REFERENCES_DIR: z.string().optional(),

  ADMIN_API_TOKEN: z.string().optional(),
  CORS_ALLOWED_ORIGINS: originList,
  TRUST_PROXY: trustProxy,

  MAX_BODY_BYTES: intish(2 * 1024 * 1024),
  MAX_UPLOAD_BYTES: intish(25 * 1024 * 1024),
  MAX_UPLOAD_FILES: intish(9),
  MAX_REMOTE_FETCH_BYTES: intish(15 * 1024 * 1024),
  REMOTE_FETCH_TIMEOUT_MS: intish(20_000),
  ALLOW_PRIVATE_NETWORK_FETCH: boolish(false),
  /**
   * Outbound proxy for provider calls where the host cannot reach the vendor
   * directly (e.g. `socks5h://127.0.0.1:8082` for Fish from a CN host).
   * Node's native fetch ignores HTTPS_PROXY, so this is wired into the
   * injectable fetchImpl instead.
   */
  SOOYA_HTTP_PROXY: z.string().optional(),

  /* Generic MCP host. Secrets are resolved from bearer-env references at runtime. */
  MCP_CONFIG_PATH: z.string().optional(),
  MCP_CONNECT_ON_START: boolish(true),
  MCP_READ_ENABLED: boolish(true),
  MCP_WRITE_ENABLED: boolish(true),
  MCP_MAINTENANCE_ENABLED: boolish(true),
  MCP_TOOL_REFRESH_INTERVAL_MS: intish(6 * 60 * 60 * 1000),
  MEMORY_BACKEND: z.enum(['ombre', 'legacy']).default('ombre'),
  OMBRE_MCP_URL: z.string().optional(),
  OMBRE_MCP_TOKEN: z.string().optional(),
  OMBRE_DASHBOARD_URL: z.string().optional(),
  OMBRE_READ_ENABLED: boolish(true),
  OMBRE_WRITE_ENABLED: boolish(true),
  OMBRE_DREAM_ENABLED: boolish(true),
  OMBRE_DREAM_INTERVAL_MS: intish(24 * 60 * 60 * 1000),
  OMBRE_BREATH_IDLE_MINUTES: intish(30),
  TOOL_MAX_ROUNDS: intish(6),
  TOOL_MAX_CALLS_PER_ROUND: intish(4),
  TOOL_CALL_TIMEOUT_MS: intish(15_000),
  TOOL_RESULT_MAX_BYTES: intish(32 * 1024),
  TOOL_TOTAL_RESULT_MAX_BYTES: intish(64 * 1024),

  /*
   * QQ 官方 Bot 单通道（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md）。
   * Secret 只存在于服务器环境变量：不进 git / 数据库导出 / 日志，Admin 只显示"已配置"。
   * QQ_CALLBACK_SECRET 是开放平台控制台的 Bot Secret，用于 webhook Ed25519 签名校验；
   * QQ_APP_SECRET 用于 OAuth 换取 Access Token（出站 API，PR3 使用）。
   */
  QQ_BOT_ENABLED: boolish(false),
  QQ_APP_ID: z.string().optional(),
  QQ_APP_SECRET: z.string().optional(),
  QQ_CALLBACK_SECRET: z.string().optional(),
  QQ_ENV: z.enum(['sandbox', 'production']).default('production'),
  QQ_ALLOWED_USERS: z.string().optional(),
  QQ_PROACTIVE_ENABLED: boolish(true),

  /*
   * Next-stage engines have passed their harness and ship enabled by default.
   * Operators can still disable any subsystem explicitly through .env.
   */
  FUTURE_ENGINE_ENABLED: boolish(true),
  FUTURE_PROACTIVE_ENABLED: boolish(true),
  RELATIONSHIP_CONTEXT_ENABLED: boolish(true),
  TIMELINE_ENABLED: boolish(true),
  INTERACTION_LEARNING_ENABLED: boolish(true),
  ADAPTIVE_PROVIDER_ROUTING_ENABLED: boolish(true),

  BACKUP_INTERVAL_MS: intish(6 * 60 * 60 * 1000),
  BACKUP_KEEP: intish(7),
  BACKUP_ON_START: boolish(false),
  /* Durable event log retention: how many tail events survive each prune. */
  EVENTS_KEEP: intish(2000),

  CONTEXT_RECENT_MESSAGES: intish(24),
  CONTEXT_MEMORY_LIMIT: intish(8),
  SUMMARY_TRIGGER_MESSAGES: intish(40),
  SUMMARY_CHUNK_MESSAGES: intish(30),
  WITHDRAW_WINDOW_MS: intish(5 * 60_000),

  /* Interruptible reply pipeline (see docs/plan: 可打断回复与连续消息合并). */
  REPLY_INTERRUPTIBLE_GENERATION: boolish(true),
  REPLY_INITIAL_DEBOUNCE_MS: intish(200),
  REPLY_INTERRUPT_DEBOUNCE_MS: intish(300),
  REPLY_PUBLISH_GRACE_MS: intish(600),
  REPLY_MAX_COLLECTION_MS: intish(4000),
  CHAT_REQUEST_TIMEOUT_MS: intish(45_000),
  CHAT_TIMEOUT_RETRIES: intish(1),
  CHAT_RETRY_BASE_DELAY_MS: intish(600),

  /* Independent voice expression system (see docs/plan: 独立语音表达系统). */
  VOICE_V2_ENABLED: boolish(true),
  VOICE_INDEPENDENT_SCRIPT_ENABLED: boolish(true),
  VOICE_NATURALNESS_GUARD_ENABLED: boolish(true),
  VOICE_ADVANCED_DELIVERY_ENABLED: boolish(true),
  VOICE_AUTO_COMPLEMENT_ENABLED: boolish(true),
  VOICE_READ_ALOUD_ENABLED: boolish(true),
  VOICE_DAILY_AUTO_CAP: intish(20),
  VOICE_TTS_RETRIES: intish(0),

  ENABLE_BACKGROUND_JOBS: boolish(true),
  DISABLE_MEMORY_PIPELINE: boolish(false),

  /* She keeps her own hours whether or not anyone is talking to her. */
  ENABLE_LIFE_ENGINE: boolish(true),
  /* v2 life simulation: vitals / themes / scored activities / threads. */
  ENABLE_LIFE_V2: boolish(true),
  /* IANA timezone; the old fixed offset remains available for compatibility. */
  LIFE_TIME_ZONE: z.string().default('Asia/Shanghai'),
  LIFE_TZ_OFFSET_MINUTES: intish(8 * 60),
  LIFE_TICK_INTERVAL_MS: intish(5 * 60 * 1000),
  /* Silence required before she will speak first. */
  LIFE_QUIET_GAP_MINUTES: intish(180),
  LIFE_MAX_REACH_OUTS_PER_DAY: intish(3),
  /* Proactive reach-out is part of the default single-user experience; explicit false remains a kill switch. */
  ENABLE_LIFE_REACH_OUT: boolish(true),
  // World context is useful out of the box; each feature remains individually
  // disableable for deployments that need the stable no-world behavior.
  WORLD_CONTEXT_ENABLED: boolish(true),
  LOCATION_MODEL_ENABLED: boolish(true),
  WEATHER_ENABLED: boolish(true),
  LIFE_ADMIN_UI_ENABLED: boolish(false),
  VOICE_PREFERENCES_UI_ENABLED: boolish(false),
  METRICS_DASHBOARD_ENABLED: boolish(false),
  /* Open-Meteo is free and keyless; an explicit provider still wins. */
  WEATHER_PROVIDER: z.string().optional().transform((value) => value?.trim() || 'open-meteo'),
  WEATHER_BASE_URL: z.string().default(''),
  WEATHER_GEOCODING_BASE_URL: z.string().default('https://geocoding-api.open-meteo.com'),
  WEATHER_API_KEY: z.string().default(''),
  WEATHER_TIMEOUT_MS: intish(5000),
  WEATHER_REFRESH_INTERVAL_MS: intish(10 * 60 * 1000),

  /* City-aware web search. Disabled until at least one server-side key is set. */
  SOOYA_WEB_SEARCH_ENABLED: boolish(false),
  SOOYA_WEB_SEARCH_PROVIDERS: webSearchProviders,
  SOOYA_WEB_SEARCH_MAX_RESULTS: intish(5),
  SOOYA_WEB_SEARCH_TIMEOUT_MS: intish(15_000),
  SOOYA_DOUBAO_SEARCH_EDITION: z.enum(['custom', 'global']).default('custom'),
  SOOYA_DOUBAO_SEARCH_BASE_URL: z.string().default('https://open.feedcoopapi.com/search_api/web_search'),
  SOOYA_DOUBAO_SEARCH_API_KEY: z.string().default(''),
  SOOYA_TAVILY_BASE_URL: z.string().default('https://api.tavily.com/search'),
  SOOYA_TAVILY_API_KEY: z.string().default(''),

  /* Visible thoughts layer (next phase): safe public thought summaries +
     admin decision traces. All off by default. */
  VISIBLE_THOUGHTS_ENABLED: boolish(false),
  VISIBLE_INNER_MONOLOGUE_ENABLED: boolish(false),
  VISIBLE_THOUGHTS_TIMEOUT_MS: intish(8000)
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface AppEnv extends RawEnv {
  dataDir: string;
  configDir: string;
  dbDir: string;
  mediaDir: string;
  mediaDirs: { images: string; audio: string; stickers: string; files: string; tmp: string; variants: string };
  backupDir: string;
  logDir: string;
  webDir: string | null;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${detail}`);
  }
  const env = parsed.data;
  // Keep existing unit/e2e harnesses hermetic and preserve the legacy memory
  // contract unless a test explicitly opts into Ombre. Production defaults to
  // Ombre, while operators can still select either backend through .env.
  const explicitMemoryBackend = source.MEMORY_BACKEND?.trim();
  const memoryBackend = explicitMemoryBackend ? env.MEMORY_BACKEND : env.NODE_ENV === 'test' ? 'legacy' : env.MEMORY_BACKEND;
  const explicitMcpStartup = source.MCP_CONNECT_ON_START?.trim();
  const mcpConnectOnStart = explicitMcpStartup ? env.MCP_CONNECT_ON_START : env.NODE_ENV === 'test' ? false : env.MCP_CONNECT_ON_START;
  const dataDir = path.resolve(env.DATA_DIR);
  const configDir = path.resolve(env.CONFIG_DIR);
  const mediaDir = path.join(dataDir, 'media');
  return {
    ...env,
    MEMORY_BACKEND: memoryBackend,
    MCP_CONNECT_ON_START: mcpConnectOnStart,
    dataDir,
    configDir,
    dbDir: path.join(dataDir, 'database'),
    mediaDir,
    mediaDirs: {
      images: path.join(mediaDir, 'images'),
      audio: path.join(mediaDir, 'audio'),
      stickers: path.join(mediaDir, 'stickers'),
      files: path.join(mediaDir, 'files'),
      tmp: path.join(mediaDir, 'tmp'),
      // 派生的缩略图缓存：可随时删除重建，不属于任何一种媒体 kind。
      variants: path.join(mediaDir, 'variants')
    },
    backupDir: path.join(dataDir, 'backups'),
    logDir: path.join(dataDir, 'logs'),
    webDir: env.WEB_DIR ? path.resolve(env.WEB_DIR) : null
  };
}
