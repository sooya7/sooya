import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.E2E_PORT ?? 8790);
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 9912);

async function waitFor(url: string, timeoutMs = 30_000): Promise<void> {
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

export default async function globalSetup(): Promise<void> {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sooya-e2e-'));
  const configDir = path.join(dataRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  const base = `http://127.0.0.1:${MOCK_PORT}/v1`;
  fs.writeFileSync(
    path.join(configDir, 'models.json'),
    JSON.stringify(
      {
        chat: {
          provider: 'openai-chat',
          baseUrl: base,
          apiKey: 'sk-e2e-mock-key',
          model: 'mock-chat',
          supportsVision: true,
          supportsStreaming: true,
          maxRetries: 0,
          timeoutMs: 20000
        },
        embedding: { provider: 'openai-embeddings', baseUrl: base, apiKey: 'sk-e2e-mock-key', model: 'mock-embed', dimensions: 32 },
        image: { provider: 'openai-images', baseUrl: base, apiKey: 'sk-e2e-mock-key', model: 'mock-image', maxRetries: 0 },
        tts: { provider: 'openai-tts', baseUrl: base, apiKey: 'sk-e2e-mock-key', model: 'mock-tts', format: 'mp3', maxRetries: 0 }
      },
      null,
      2
    )
  );

  const mock: ChildProcess = spawn(process.execPath, [path.join(HERE, 'mock-model.mjs')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
    stdio: 'inherit'
  });

  const serverLogPath = path.join(dataRoot, 'server.log');
  const serverLogFd = fs.openSync(serverLogPath, 'w');
  const server: ChildProcess = spawn(process.execPath, [path.join(ROOT, 'packages/server/dist/main.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      LOG_LEVEL: 'warn',
      DATA_DIR: path.join(dataRoot, 'data'),
      CONFIG_DIR: configDir,
      WEB_DIR: path.join(ROOT, 'packages/web/dist'),
      ALLOW_PRIVATE_NETWORK_FETCH: 'true',
      WEB_CHAT_TOKEN: 'e2e-chat-token',
      ADMIN_API_TOKEN: 'e2e-admin-token',
      // The next-phase specs expect the e2e server to run with all next-phase
      // flags on (see next-phase.e2e.ts), proving the stable chat specs are
      // unaffected by them. Default-off behaviour is covered by the unit suites.
      WORLD_CONTEXT_ENABLED: 'true',
      LOCATION_MODEL_ENABLED: 'true',
      WEATHER_ENABLED: 'true',
      LIFE_ADMIN_UI_ENABLED: 'true',
      VOICE_PREFERENCES_UI_ENABLED: 'true',
      METRICS_DASHBOARD_ENABLED: 'true',
      VISIBLE_THOUGHTS_ENABLED: 'true',
      VISIBLE_INNER_MONOLOGUE_ENABLED: 'true',
      ENABLE_BACKGROUND_JOBS: 'true',
      BACKUP_INTERVAL_MS: '0'
    },
    // Server logs go to a file so the teardown can fail the run when an
    // unhandled rejection / uncaught exception appears — a green suite must
    // never silently swallow a process-level crash.
    stdio: ['ignore', serverLogFd, serverLogFd]
  });
  fs.closeSync(serverLogFd);

  await waitFor(`http://127.0.0.1:${MOCK_PORT}/__control`);
  await waitFor(`http://127.0.0.1:${PORT}/health/ready`);

  process.env.E2E_DATA_ROOT = dataRoot;
  fs.writeFileSync(
    path.join(os.tmpdir(), 'sooya-e2e-pids.json'),
    JSON.stringify({ mock: mock.pid, server: server.pid, dataRoot, serverLogPath })
  );
}
