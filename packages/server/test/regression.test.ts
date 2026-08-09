/**
 * Regression tests for defects raised during the delivery audit.
 *
 * These tests guard externally observable behaviour and deployment safety. They
 * deliberately avoid accepting weaker implementations merely to make CI green.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createHarness, sendText, type Harness } from './helpers/harness.js';
import { ConfigStore } from '../src/config/store.js';
import { OpenAIChatProvider } from '../src/providers/chat/openai.js';
import { ChatModelSchema } from '../src/config/schema.js';

let h: Harness | undefined;
afterEach(async () => {
  if (!h) return;
  const current = h;
  h = undefined;
  await current.cleanup();
});

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/* ========================================================================== */
/* Defect 1: legacy environment keys migrate once into the single source     */
/* ========================================================================== */

describe('defect 1: legacy environment keys migrate once into models.json', () => {
  it('persists the migrated key when saving unrelated settings', () => {
    const configDir = makeTempDir('sooya-cfg-env-');
    const store = new ConfigStore({
      configDir,
      env: {
        SOOYA_CHAT_PROVIDER: 'openai-chat',
        SOOYA_CHAT_BASE_URL: 'https://api.example.com/v1',
        SOOYA_CHAT_MODEL: 'gpt-4o-mini',
        SOOYA_CHAT_API_KEY: 'sk-env-supplied-secret-000000000000'
      } as NodeJS.ProcessEnv
    });

    expect(store.getModels().chat.apiKey).toBe('sk-env-supplied-secret-000000000000');
    store.setModels({ chat: { temperature: 0.4 } });

    const onDiskText = fs.readFileSync(path.join(configDir, 'models.json'), 'utf8');
    const onDisk = JSON.parse(onDiskText);
    expect(onDisk.chat.apiKey).toBe('sk-env-supplied-secret-000000000000');
    expect(onDisk.storageVersion).toBe(2);
    expect(onDisk.chat.temperature).toBe(0.4);
    expect(store.getModels().chat.apiKey).toBe('sk-env-supplied-secret-000000000000');
  });

  it('keeps a key explicitly written through the admin configuration path', () => {
    const configDir = makeTempDir('sooya-cfg-explicit-');
    const store = new ConfigStore({ configDir, env: {} as NodeJS.ProcessEnv });
    store.setModels({
      chat: {
        provider: 'openai-chat',
        baseUrl: 'https://api.example.com/v1',
        model: 'm',
        apiKey: 'sk-explicit-file-key-1234567890'
      }
    });

    const onDisk = JSON.parse(fs.readFileSync(path.join(configDir, 'models.json'), 'utf8'));
    expect(onDisk.chat.apiKey).toBe('sk-explicit-file-key-1234567890');
  });

  it('preserves the legacy effective key after migration and ignores later env changes', () => {
    const configDir = makeTempDir('sooya-cfg-mixed-');
    fs.writeFileSync(
      path.join(configDir, 'models.json'),
      JSON.stringify({
        chat: {
          provider: 'openai-chat',
          baseUrl: 'https://api.example.com/v1',
          model: 'm',
          apiKey: 'sk-file-original-key-000000'
        }
      })
    );

    const store = new ConfigStore({
      configDir,
      env: { SOOYA_CHAT_API_KEY: 'sk-env-override-key-111111' } as NodeJS.ProcessEnv
    });
    expect(store.getModels().chat.apiKey).toBe('sk-env-override-key-111111');

    store.setModels({ chat: { temperature: 0.9 } });
    const onDisk = JSON.parse(fs.readFileSync(path.join(configDir, 'models.json'), 'utf8'));
    expect(onDisk.chat.apiKey).toBe('sk-env-override-key-111111');
    expect(onDisk.chat.temperature).toBe(0.9);

    const reloaded = new ConfigStore({
      configDir,
      env: { SOOYA_CHAT_API_KEY: 'sk-later-env-change-222222' } as NodeJS.ProcessEnv
    });
    expect(reloaded.getModels().chat.apiKey).toBe('sk-env-override-key-111111');
  });

  it('redacts configured keys from the admin response', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'tok-admin' } });
    const res = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/models',
      headers: { 'x-admin-token': 'tok-admin' }
    });
    expect(res.body).not.toContain('sk-test-key-000000');
    expect(res.json().models.chat.apiKeyConfigured).toBe(true);
  });
});

/* ========================================================================== */
/* Defect 2: first container start creates unwritable bind-mounted dirs        */
/* ========================================================================== */

describe('defect 2: container must not be blocked by host directory ownership', () => {
  const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');

  it('pins the container UID/GID so bind-mounted directories are writable', () => {
    expect(compose).toMatch(/^\s{4}user:\s*["']?\$\{SOOYA_UID:-1001\}:\$\{SOOYA_GID:-1001\}["']?\s*$/m);
  });

  it('documents UID/GID overrides for other hosts', () => {
    expect(compose).toMatch(/SOOYA_UID/);
    const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
    expect(envExample).toMatch(/SOOYA_UID=/);
    expect(envExample).toMatch(/SOOYA_GID=/);
  });

  it('ships an entrypoint that validates both writable mounts', () => {
    const entrypoint = path.join(REPO_ROOT, 'deploy', 'docker-entrypoint.sh');
    expect(fs.existsSync(entrypoint)).toBe(true);
    const body = fs.readFileSync(entrypoint, 'utf8');
    expect(body).toMatch(/DATA_DIR/);
    expect(body).toMatch(/CONFIG_DIR/);
    expect(body).toMatch(/SOOYA_UID/);
    expect(fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8')).toMatch(/docker-entrypoint\.sh/);
  });
});

/* ========================================================================== */
/* Defect 3: restoring an old database rewinds sequence counters              */
/* ========================================================================== */

describe('defect 3: restoring an older database must not rewind sequence numbers', () => {
  it('keeps message and event sequences monotonic across restore', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'tok-admin' }, chat: { script: [['备份时的回复']] } });

    await sendText(h.app, '备份前消息', 'r-1');
    const info = await h.app.services.backups.create('before');
    const msgSeqAtBackup = h.app.repos.messages.maxSeq();
    const evtSeqAtBackup = h.app.services.bus.lastSeq();

    h.setChatScript([['备份后回复1'], ['备份后回复2'], ['备份后回复3']]);
    for (let i = 0; i < 3; i++) await sendText(h.app, `备份后消息 ${i}`, `r-after-${i}`);
    const msgSeqBeforeRestore = h.app.repos.messages.maxSeq();
    const evtSeqBeforeRestore = h.app.services.bus.lastSeq();
    expect(msgSeqBeforeRestore).toBeGreaterThan(msgSeqAtBackup);
    expect(evtSeqBeforeRestore).toBeGreaterThan(evtSeqAtBackup);

    const res = await h.app.server.inject({
      method: 'POST',
      url: `/api/admin/backups/${info.name}/restore`,
      headers: { 'x-admin-token': 'tok-admin' }
    });
    expect(res.statusCode).toBe(200);

    const restored = h.app.repos.messages.page(50).messages;
    expect(JSON.stringify(restored)).toContain('备份时的回复');
    expect(JSON.stringify(restored)).not.toContain('备份后回复1');
    expect(h.app.services.bus.lastSeq()).toBeGreaterThanOrEqual(evtSeqBeforeRestore);

    const newEvent = h.app.services.bus.publish('system.notice', { notice: 'post restore' });
    expect(newEvent.seq).toBeGreaterThan(evtSeqBeforeRestore);

    h.setChatScript([['恢复之后的新回复']]);
    await sendText(h.app, '恢复后的新消息', 'r-post');
    expect(h.app.repos.messages.maxSeq()).toBeGreaterThan(msgSeqBeforeRestore);
  });

  it('orders connected clients to fully resynchronise after restore', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'tok-admin' }, chat: { script: [['x']] } });
    await sendText(h.app, 'seed', 'r2-1');
    const info = await h.app.services.backups.create('before');

    const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const off = h.app.services.bus.subscribe((event) => seen.push({ type: event.type, payload: event.payload }));
    await h.app.server.inject({
      method: 'POST',
      url: `/api/admin/backups/${info.name}/restore`,
      headers: { 'x-admin-token': 'tok-admin' }
    });
    off();

    const notice = seen.find((event) => event.type === 'system.notice');
    expect(notice).toBeTruthy();
    expect(notice!.payload.action).toBe('reload');
    expect(notice!.payload.reason).toBe('database-restored');
  });

  it('rebuilds counters from restored content when the snapshot is ahead', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'tok-admin' }, chat: { script: [['a']] } });
    await sendText(h.app, 'one', 'c-1');
    const info = await h.app.services.backups.create('snap');

    h.app.repos.messages.clearAll();
    h.app.repos.events.clear();
    h.app.db.prepare("UPDATE counters SET value = 0 WHERE name IN ('message_seq','event_seq')").run();

    await h.app.server.inject({
      method: 'POST',
      url: `/api/admin/backups/${info.name}/restore`,
      headers: { 'x-admin-token': 'tok-admin' }
    });

    const maxSeq = h.app.repos.messages.maxSeq();
    const counter = h.app.db.prepare("SELECT value FROM counters WHERE name = 'message_seq'").get() as { value: number };
    expect(counter.value).toBeGreaterThanOrEqual(maxSeq);
    h.setChatScript([['after']]);
    await expect(sendText(h.app, 'after restore', 'c-2')).resolves.toBeTruthy();
  });
});

/* ========================================================================== */
/* Defect 4: initial message snapshot races the SSE starting point             */
/* ========================================================================== */

describe('defect 4: initial load must not lose events between snapshot and stream', () => {
  it('returns the event cursor with the same message page', async () => {
    h = await createHarness({ chat: { script: [['x']] } });
    await sendText(h.app, 'hello', 'sn-1');

    const body = (await h.app.server.inject({ method: 'GET', url: '/api/messages?limit=30' })).json();
    expect(typeof body.lastEventSeq).toBe('number');
    expect(body.lastEventSeq).toBe(h.app.services.bus.lastSeq());
    expect(body.lastMessageSeq).toBe(h.app.repos.messages.maxSeq());
  });

  it('seeds the web stream from the message snapshot response', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/web/src/lib/useChat.ts'), 'utf8');
    expect(src).not.toMatch(/setLastEventId\(\s*(conv\.lastEventSeq|boot\.conversation\.lastEventSeq)/);
    expect(src).toMatch(/setLastEventId\(\s*(page\.lastEventSeq|boot\.messages\.lastEventSeq)/);
  });

  it('replays an event emitted after the snapshot to a late subscriber', async () => {
    h = await createHarness({ chat: { script: [['reply']] } });
    const page = (await h.app.server.inject({ method: 'GET', url: '/api/messages?limit=30' })).json();
    const cursor = page.lastEventSeq as number;

    await sendText(h.app, '在快照之后发送', 'race-1');
    const replayed = h.app.services.bus.replay(cursor, 500);
    expect(replayed.length).toBeGreaterThan(0);
    expect(JSON.stringify(replayed)).toContain('在快照之后发送');
  });
});

/* ========================================================================== */
/* Defect 5: raw SQLite/WAL copies can produce inconsistent backups            */
/* ========================================================================== */

describe('defect 5: offline backups must use a WAL-consistent snapshot', () => {
  it('refuses unsafe live-file copies and verifies every database snapshot', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'deploy/backup.sh'), 'utf8');

    expect(script).toMatch(/\.backup/);
    expect(script).toMatch(/VACUUM INTO/);
    expect(script).toMatch(/better-sqlite3/);
    expect(script).toMatch(/no WAL-safe SQLite snapshot mechanism is available/);
    expect(script).toMatch(/refusing an unsafe live-file copy/);
    expect(script).not.toMatch(/for suffix in "" "-wal" "-shm"/);
    expect(script).toMatch(/verify_snapshot/);
    expect(script).toMatch(/integrity_check/);
  });

  it('produces a restorable snapshot while writes are in flight', async () => {
    const dir = makeTempDir('sooya-walcopy-');
    const dbFile = path.join(dir, 'sooya.db');
    const db = new Database(dbFile);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
    const insert = db.prepare('INSERT INTO t(v) VALUES (?)');
    for (let i = 0; i < 200; i++) insert.run(`row-${i}`);

    const snapshot = path.join(dir, 'snapshot.db');
    await db.backup(snapshot);
    for (let i = 200; i < 260; i++) insert.run(`row-${i}`);
    db.close();

    const probe = new Database(snapshot, { readonly: true, fileMustExist: true });
    const integrity = (probe.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]!.integrity_check;
    const count = (probe.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c;
    probe.close();

    expect(integrity).toBe('ok');
    expect(count).toBe(200);
  });

  it('keeps the backup helper syntactically valid', () => {
    expect(() => execFileSync('bash', ['-n', path.join(REPO_ROOT, 'deploy/backup.sh')])).not.toThrow();
  });
});

/* ========================================================================== */
/* Defect 6: maxRetries had no effect on streaming chat requests              */
/* ========================================================================== */

describe('defect 6: streaming chat must honour maxRetries', () => {
  function providerWith(maxRetries: number, fetchImpl: typeof fetch) {
    const cfg = ChatModelSchema.parse({
      provider: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-unit-test-key-000000',
      model: 'm',
      supportsStreaming: true,
      maxRetries,
      timeoutMs: 5000
    });
    return new OpenAIChatProvider(cfg, { allowPrivateNetwork: true, fetchImpl });
  }

  function sse(text: string): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
  }

  it('retries retryable failures and eventually succeeds', async () => {
    let attempts = 0;
    const provider = providerWith(2, async () => {
      attempts++;
      if (attempts < 3) return new Response('upstream overloaded', { status: 503 });
      return sse('终于成功了');
    });

    const chunks: string[] = [];
    const result = await provider.stream(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      (chunk) => chunks.push(chunk.delta)
    );

    expect(attempts).toBe(3);
    expect(result.text).toBe('终于成功了');
    expect(chunks.join('')).toBe('终于成功了');
  });

  it('gives up after maxRetries', async () => {
    let attempts = 0;
    const provider = providerWith(1, async () => {
      attempts++;
      return new Response('still down', { status: 503 });
    });

    await expect(
      provider.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, () => undefined)
    ).rejects.toThrow(/503/);
    expect(attempts).toBe(2);
  });

  it('does not retry after tokens have reached the caller', async () => {
    let attempts = 0;
    const encoder = new TextEncoder();
    const provider = providerWith(3, async () => {
      attempts++;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!this._sent) {
              (this as { _sent?: boolean })._sent = true;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '前半段' } }] })}\n\n`)
              );
              return;
            }
            controller.error(new Error('connection reset mid-stream'));
          }
        } as UnderlyingDefaultSource<Uint8Array> & { _sent?: boolean }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    });

    const chunks: string[] = [];
    await expect(
      provider.stream(
        { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
        (chunk) => chunks.push(chunk.delta)
      )
    ).rejects.toThrow();

    expect(attempts).toBe(1);
    expect(chunks.join('')).toBe('前半段');
  });

  it('does not retry a non-retryable status', async () => {
    let attempts = 0;
    const provider = providerWith(3, async () => {
      attempts++;
      return new Response('bad request', { status: 400 });
    });

    await expect(
      provider.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, () => undefined)
    ).rejects.toThrow(/400/);
    expect(attempts).toBe(1);
  });
});

/* ========================================================================== */
/* Defect 7: the documented E2E command could not start                       */
/* ========================================================================== */

describe('defect 7: the documented e2e command must actually run', () => {
  const cfgPath = path.join(REPO_ROOT, 'e2e/playwright.config.ts');
  const cfg = fs.readFileSync(cfgPath, 'utf8');

  it('anchors testDir and global hooks to the config file', () => {
    expect(cfg).not.toMatch(/globalSetup:\s*'\.\/global-setup\.ts'/);
    expect(cfg).not.toMatch(/globalTeardown:\s*'\.\/global-teardown\.ts'/);
    expect(cfg).toMatch(/globalSetup:\s*path\.join\(HERE/);
    expect(cfg).toMatch(/globalTeardown:\s*path\.join\(HERE/);
    expect(cfg).toMatch(/testDir:\s*HERE/);
  });

  it('avoids import.meta in the CommonJS-loaded Playwright config', () => {
    const code = cfg
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
      .join('\n');
    expect(code).not.toMatch(/import\.meta/);
    expect(code).toMatch(/const HERE = __dirname/);
  });

  it('exposes the command and all referenced setup files', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:e2e']).toBeTruthy();
    expect(fs.existsSync(path.join(REPO_ROOT, 'e2e/global-setup.ts'))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'e2e/global-teardown.ts'))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'playwright.config.ts'))).toBe(true);
  });
});

/* ========================================================================== */
/* Documentation accuracy                                                     */
/* ========================================================================== */

describe('documentation accuracy', () => {
  it('states that fake API keys exist in test fixtures', async () => {
    const report = await fsp.readFile(path.join(REPO_ROOT, 'docs/TEST-REPORT.md'), 'utf8');
    expect(report).toMatch(/夹具|fixture/);
    expect(report).toMatch(/sk-test-key|sk-e2e-mock-key|sk-unit-test-key/);
  });

  it('matches package sizes when release artefacts are present', async () => {
    const releaseDir = path.join(REPO_ROOT, 'release');
    if (!fs.existsSync(path.join(releaseDir, 'sooya-1.0.0.tar.gz'))) return;

    const report = await fsp.readFile(path.join(REPO_ROOT, 'docs/TEST-REPORT.md'), 'utf8');
    const tarKb = (await fsp.stat(path.join(releaseDir, 'sooya-1.0.0.tar.gz'))).size / 1024;
    const zipKb = (await fsp.stat(path.join(releaseDir, 'sooya-1.0.0.zip'))).size / 1024;
    const tarMatch = /sooya-1\.0\.0\.tar\.gz\s+([\d.]+)\s*KB/.exec(report);
    const zipMatch = /sooya-1\.0\.0\.zip\s+([\d.]+)\s*KB/.exec(report);
    expect(tarMatch).toBeTruthy();
    expect(zipMatch).toBeTruthy();
    expect(Math.abs(Number(tarMatch![1]) - tarKb)).toBeLessThan(15);
    expect(Math.abs(Number(zipMatch![1]) - zipKb)).toBeLessThan(15);
  });

  it('mentions the regression suite in the reported test inventory', async () => {
    const report = await fsp.readFile(path.join(REPO_ROOT, 'docs/TEST-REPORT.md'), 'utf8');
    expect(report).toMatch(/regression\.test\.ts/);
  });
});

/* ========================================================================== */
/* Defect 7: non-streaming models retried twice over, (maxRetries + 1)^2 calls */
/* ========================================================================== */

/**
 * `stream()` wraps `streamOnce` in a retry ladder, and `streamOnce` delegates to
 * `complete()` when the model cannot stream -- but `complete()` runs a ladder of its
 * own. The two multiplied: with maxRetries = 2 a failing request was sent 9 times
 * instead of 3, burning three times the tokens and tripling the stall before the
 * failure surfaced. `supportsStreaming: false` is a normal setting for
 * OpenAI-compatible gateways, so this hit real users of those gateways.
 */
describe('defect 7: a non-streaming model must not stack two retry ladders', () => {
  function nonStreamingProvider(maxRetries: number, fetchImpl: typeof fetch) {
    const cfg = ChatModelSchema.parse({
      provider: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-unit-test-key-000000',
      model: 'm',
      supportsStreaming: false,
      maxRetries,
      timeoutMs: 5000
    });
    return new OpenAIChatProvider(cfg, { allowPrivateNetwork: true, fetchImpl });
  }

  function jsonReply(text: string): Response {
    return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }

  it('sends exactly maxRetries + 1 requests when every attempt fails', async () => {
    let calls = 0;
    const provider = nonStreamingProvider(2, async () => {
      calls++;
      return new Response('upstream overloaded', { status: 503 });
    });

    await expect(
      provider.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, () => undefined)
    ).rejects.toThrow(/503/);

    // 3, not 9: one ladder, not two multiplied.
    expect(calls).toBe(3);
  });

  it('still retries a non-streaming model until it succeeds, emitting the text once', async () => {
    let calls = 0;
    const provider = nonStreamingProvider(2, async () => {
      calls++;
      if (calls < 3) return new Response('upstream overloaded', { status: 503 });
      return jsonReply('终于成功了');
    });

    const chunks: string[] = [];
    const result = await provider.stream(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      (chunk) => chunks.push(chunk.delta)
    );

    expect(calls).toBe(3);
    expect(result.text).toBe('终于成功了');
    expect(chunks.join('')).toBe('终于成功了');
  });

  it('sends one request when retries are disabled', async () => {
    let calls = 0;
    const provider = nonStreamingProvider(0, async () => {
      calls++;
      return new Response('down', { status: 503 });
    });

    await expect(
      provider.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, () => undefined)
    ).rejects.toThrow(/503/);
    expect(calls).toBe(1);
  });
});
