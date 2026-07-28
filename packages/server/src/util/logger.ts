import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

const SECRET_KEY_RE = /(api[-_]?key|apikey|authorization|token|secret|password|bearer)/i;

/** Recursively redact secret-looking values. Exported for tests. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return redactStringSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = typeof v === 'string' ? maskSecret(v) : '[redacted]';
      } else {
        out[k] = redactSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return '***';
  return `${secret.slice(0, 3)}***${secret.slice(-2)}`;
}

export function redactStringSecrets(input: string): string {
  return input
    .replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***')
    .replace(/("?(?:api[-_]?key|apiKey|token|secret)"?\s*[:=]\s*"?)([^",\s}]{4,})/gi, (_m, p1: string) => `${p1}***`);
}

export function createLogger(opts: { level: string; logDir?: string | null; pretty?: boolean }): Logger {
  const streams: pino.StreamEntry[] = [];
  if (opts.pretty) {
    streams.push({
      level: opts.level as pino.Level,
      stream: pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } })
    });
  } else {
    streams.push({ level: opts.level as pino.Level, stream: process.stdout });
  }
  if (opts.logDir) {
    fs.mkdirSync(opts.logDir, { recursive: true });
    streams.push({
      level: 'warn',
      stream: pino.destination({ dest: path.join(opts.logDir, 'error.log'), append: true, sync: false })
    });
    streams.push({
      level: opts.level as pino.Level,
      stream: pino.destination({ dest: path.join(opts.logDir, 'app.log'), append: true, sync: false })
    });
  }
  return pino(
    {
      level: opts.level === 'silent' ? 'silent' : 'trace',
      base: { app: 'sooya' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        log: (obj) => redactSecrets(obj) as Record<string, unknown>
      },
      redact: {
        paths: ['apiKey', 'api_key', 'headers.authorization', 'headers["x-sooya-token"]', 'headers["x-admin-token"]', '*.apiKey'],
        censor: '[redacted]'
      }
    },
    pino.multistream(streams, { levels: pino.levels.values })
  );
}
