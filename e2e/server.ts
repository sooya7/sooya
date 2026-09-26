import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How the e2e SOOYA server is started. Shared by global-setup (first start) and
 * by specs that need a real restart (helpers.restartServer), so both use the
 * exact same environment and the restarted process keeps the same data.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const PORT = Number(process.env.E2E_PORT ?? 8790);
export const MOCK_PORT = Number(process.env.MOCK_PORT ?? 9912);
export const ADMIN_TOKEN = 'e2e-admin-token';
export const PID_FILE = path.join(os.tmpdir(), 'sooya-e2e-pids.json');

export interface E2eRuntime {
  mock?: number;
  server?: number;
  dataRoot: string;
  configDir: string;
  serverLogPath: string;
}

export function readRuntime(): E2eRuntime {
  return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')) as E2eRuntime;
}

export function writeRuntime(runtime: E2eRuntime): void {
  fs.writeFileSync(PID_FILE, JSON.stringify(runtime));
}

function serverEnv(dataRoot: string, configDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(PORT),
    LOG_LEVEL: 'warn',
    DATA_DIR: path.join(dataRoot, 'data'),
    CONFIG_DIR: configDir,
    WEB_DIR: path.join(ROOT, 'packages/web/dist'),
    ALLOW_PRIVATE_NETWORK_FETCH: 'true',
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    // E2E runs SOOYA in isolation; the production default is Ombre, but no
    // external memory service is part of this test fixture.
    MEMORY_BACKEND: 'legacy',
    MCP_CONNECT_ON_START: 'false',
    // The specs drive the admin console (QQ 单通道后 Web 只保留管理后台)，
    // so the server runs with the next-phase flags on. Default-off behaviour
    // is covered by unit tests.
    WORLD_CONTEXT_ENABLED: 'true',
    LOCATION_MODEL_ENABLED: 'true',
    WEATHER_ENABLED: 'true',
    // open-meteo is replaced by mock-model.mjs: no internet, and each city
    // gets its own recognisable weather.
    WEATHER_PROVIDER: 'open-meteo',
    WEATHER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    WEATHER_GEOCODING_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    LIFE_ADMIN_UI_ENABLED: 'true',
    VOICE_PREFERENCES_UI_ENABLED: 'true',
    METRICS_DASHBOARD_ENABLED: 'true',
    VISIBLE_THOUGHTS_ENABLED: 'true',
    VISIBLE_INNER_MONOLOGUE_ENABLED: 'true',
    ENABLE_BACKGROUND_JOBS: 'true',
    BACKUP_INTERVAL_MS: '0'
  };
}

/**
 * Start the server process. Logs are appended to one file so the teardown can
 * fail the run when an unhandled rejection / uncaught exception appears in any
 * of the server lifetimes — a green suite must never swallow a process crash.
 *
 * `detached` is used for restarts from inside a Playwright worker: the new
 * server must outlive the worker and is killed by the global teardown instead.
 */
export function spawnServer(runtime: Pick<E2eRuntime, 'dataRoot' | 'configDir' | 'serverLogPath'>, detached = false): number {
  const logFd = fs.openSync(runtime.serverLogPath, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'packages/server/dist/main.js')], {
    env: serverEnv(runtime.dataRoot, runtime.configDir),
    stdio: ['ignore', logFd, logFd],
    detached,
    windowsHide: true
  });
  fs.closeSync(logFd);
  if (detached) child.unref();
  if (!child.pid) throw new Error('failed to spawn the e2e server');
  return child.pid;
}

export async function waitFor(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

export async function waitUntilDown(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${url} did not stop`);
}

export function killQuietly(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}
