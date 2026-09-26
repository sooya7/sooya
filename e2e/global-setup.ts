import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { MOCK_PORT, PORT, spawnServer, waitFor, writeRuntime } from './server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
        // Keep structured director decisions on a separate mock model so they
        // never consume the reply script used by the chat specs.
        director: {
          provider: 'openai-chat',
          baseUrl: base,
          apiKey: 'sk-e2e-mock-key',
          model: 'mock-director',
          supportsVision: true,
          supportsStreaming: false,
          maxRetries: 0,
          timeoutMs: 5000
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
  fs.writeFileSync(serverLogPath, '');
  const runtime = { dataRoot, configDir, serverLogPath };
  const server = spawnServer(runtime);

  await waitFor(`http://127.0.0.1:${MOCK_PORT}/__control`);
  await waitFor(`http://127.0.0.1:${PORT}/health/ready`);

  process.env.E2E_DATA_ROOT = dataRoot;
  writeRuntime({ ...runtime, mock: mock.pid, server });
}
