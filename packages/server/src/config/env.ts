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
  /* 参考图目录；不设置时回退到 assets/references。生产建议指向持久化目录，
   * 这样管理面板上传的参考图不会被代码升级覆盖。 */
  SOOYA_REFERENCES_DIR: z.string().optional(),

  WEB_CHAT_TOKEN: z.string().optional(),
  ADMIN_API_TOKEN: z.string().optional(),
  CORS_ALLOWED_ORIGINS: originList,
  // VAPID `sub`: who operates this push sender. Apple validates it and answers 403
  // to anything malformed, which is how iOS delivery silently died on the hardcoded
  // `mailto:admin@localhost`. Must be an https URL or a mailto with a real domain.
  SOOYA_PUSH_SUBJECT: z.string().optional(),

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
  /* Unprompted messages are off until the user turns them on. */
  ENABLE_LIFE_REACH_OUT: boolish(false),
  // Next phase: world context / admin / thoughts (all off by default;
  // off must behave exactly like the stable release).
  WORLD_CONTEXT_ENABLED: boolish(false),
  LOCATION_MODEL_ENABLED: boolish(false),
  WEATHER_ENABLED: boolish(false),
  LIFE_ADMIN_UI_ENABLED: boolish(false),
  VOICE_PREFERENCES_UI_ENABLED: boolish(false),
  METRICS_DASHBOARD_ENABLED: boolish(false),
  /* Weather production provider (next phase): unconfigured -> no-op provider,
     weather=unknown, life/chat unaffected. */
  WEATHER_PROVIDER: z.string().default(''),
  WEATHER_BASE_URL: z.string().default(''),
  WEATHER_API_KEY: z.string().default(''),
  WEATHER_TIMEOUT_MS: intish(5000),

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
  const dataDir = path.resolve(env.DATA_DIR);
  const configDir = path.resolve(env.CONFIG_DIR);
  const mediaDir = path.join(dataDir, 'media');
  return {
    ...env,
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
