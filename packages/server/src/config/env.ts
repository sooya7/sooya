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

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: intish(8788),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATA_DIR: z.string().default('./data'),
  CONFIG_DIR: z.string().default('./config'),
  WEB_DIR: z.string().optional(),

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

  BACKUP_INTERVAL_MS: intish(6 * 60 * 60 * 1000),
  BACKUP_KEEP: intish(7),
  BACKUP_ON_START: boolish(false),

  CONTEXT_RECENT_MESSAGES: intish(24),
  CONTEXT_MEMORY_LIMIT: intish(8),
  SUMMARY_TRIGGER_MESSAGES: intish(40),
  SUMMARY_CHUNK_MESSAGES: intish(30),

  ENABLE_BACKGROUND_JOBS: boolish(true),
  DISABLE_MEMORY_PIPELINE: boolish(false)
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface AppEnv extends RawEnv {
  dataDir: string;
  configDir: string;
  dbDir: string;
  mediaDir: string;
  mediaDirs: { images: string; audio: string; stickers: string; files: string; tmp: string };
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
      tmp: path.join(mediaDir, 'tmp')
    },
    backupDir: path.join(dataDir, 'backups'),
    logDir: path.join(dataDir, 'logs'),
    webDir: env.WEB_DIR ? path.resolve(env.WEB_DIR) : null
  };
}
