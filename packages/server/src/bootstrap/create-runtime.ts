import path from 'node:path';
import type { Logger } from 'pino';
import { loadEnv, type AppEnv } from '../config/env.js';
import { ConfigStore } from '../config/store.js';
import { closeDatabase, openDatabase } from '../db/index.js';
import { DbHandle } from '../db/handle.js';
import { createLogger } from '../util/logger.js';
import { createProxyFetch } from '../util/proxyFetch.js';
import { ensureDirSync } from '../util/fsx.js';

export interface RuntimeBootstrapOptions {
  env?: Partial<NodeJS.ProcessEnv>;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export interface RuntimeBootstrap {
  env: AppEnv;
  logger: Logger;
  directFetchImpl: typeof fetch;
  fetchImpl: typeof fetch;
  dbFile: string;
  dbHandle: DbHandle;
  opened: ReturnType<typeof openDatabase>;
  config: ConfigStore;
}

export function createRuntime(opts: RuntimeBootstrapOptions = {}): RuntimeBootstrap {
  const env = loadEnv({ ...process.env, ...opts.env } as NodeJS.ProcessEnv);
  const logger = opts.logger ?? createLogger({ level: env.LOG_LEVEL, logDir: env.NODE_ENV === 'test' ? null : env.logDir, pretty: env.NODE_ENV === 'development' });
  const directFetchImpl = opts.fetchImpl ?? fetch;
  // The proxy transport needs the same body ceiling as safeFetch; without it a
  // hostile upstream is bounded only by available memory.
  const fetchImpl = env.SOOYA_HTTP_PROXY
    ? createProxyFetch(env.SOOYA_HTTP_PROXY, { maxResponseBytes: env.MAX_REMOTE_FETCH_BYTES })
    : directFetchImpl;
  for (const dir of [env.dataDir, env.dbDir, env.mediaDir, env.backupDir, env.logDir, ...Object.values(env.mediaDirs)]) ensureDirSync(dir);
  const dbFile = path.join(env.dbDir, 'sooya.db');
  const opened = openDatabase({ file: dbFile, backupDir: env.backupDir, onLog: (level, msg, extra) => logger[level]({ ...extra }, msg) });
  const dbHandle = new DbHandle(opened.db);
  const config = new ConfigStore({
    configDir: env.configDir,
    env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
    onLog: (level, msg, extra) => logger[level]({ ...extra }, msg)
  });
  return { env, logger, directFetchImpl, fetchImpl, dbFile, dbHandle, opened, config };
}

export function closeRuntime(runtime: RuntimeBootstrap): void {
  if (runtime.dbHandle.open) closeDatabase(runtime.dbHandle.raw);
}
