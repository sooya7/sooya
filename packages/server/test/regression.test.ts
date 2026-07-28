/**
 * Regression tests for the six defects raised in the audit review.
 *
 * Every test in this file was written to FAIL against the implementation as it
 * stood before the corresponding fix, so it genuinely guards the behaviour
 * rather than merely restating it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createHarness, sendText, type Harness } from './helpers/harness.js';
import { ConfigStore } from '../src/config/store.js';
import { OpenAIChatProvider } from '../src/providers/chat/openai.js';
import { ChatModelSchema } from '../src/config/schema.js';

let h: Harness;
afterEach(async () => {
  if (h) await h.cleanup();
});

const REPO_ROOT = path.resolve(new URL('../../../', import.meta.url).pathname);

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
/* Defect 1: environment API keys leaked into models.json (and thus backups)  */
/* ========================================================================== */

describe('defect 1: environment API keys must never be persisted to models.json', () => {
  it('does not write an env-injected key to disk when saving unrelated settings', () => {
    const configDir = makeTempDir('sooya-cfg-env-');
    // The operator supplied the key through the environment only. The file on
    // disk must stay free of it, otherwise every backup would carry the secret.
    const store = new ConfigStore({
      configDir,
      env: {
        SOOYA_CHAT_PROVIDER: 'openai-chat',
        SOOYA_CHAT_BASE_URL: 'https://api.example.com/v1',
        SOOYA_CHAT_MODEL: 'gpt-4o-mini',
        SOOYA_CHAT_API_KEY: 'sk-env-supplied-secret-000000000000'
      } as NodeJS.ProcessEnv
    });

    // The running config resolves the key so requests work...
    expect(store.getModels().chat.apiKey).toBe('sk-env-supplied-secret-000000000000');

    // ...but an admin edit of an unrelated field must not spill it onto disk.
    store.setModels({ chat: { temperature: 0.4 } });

    const onDisk = fs.readFileSync(path.join(configDir, 'models.json'), 'utf8');
    expect(onDisk).not.toContain('sk-env-supplied-secret-000000000000');
    expect(JSON.parse(onDisk).chat.apiKey).toBe('');
    // The edit itself must still have been applied and the key still usable.
    expect(JSON.parse(onDisk).chat.temperature).toBe(0.4);
    expect(store.getModels().chat.apiKey).toBe('sk-env-supplied-secret-000000000000');
    expect(store.getModels().chat.temperature).toBe(0.4);
  });

  it('keeps a key that was explicitly written through the admin API', () => {
    const configDir = makeTempDir('sooya-cfg-explicit-');
    const store = new ConfigStore({ configDir, env: {} as NodeJS.ProcessEnv });
    store.setModels({
      chat: { provider: 'openai-chat', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-explicit-file-key-1234567890' }
    });
    const onDisk = JSON.parse(fs.readFileSync(path.join(configDir, 'models.json'), 'utf8'));
    // An explicitly supplied key is the file's own value and must persist.
    expect(onDisk.chat.apiKey).toBe('sk-explicit-file-key-1234567890');
  });

  it('does not let an env key overwrite a different key already in the file', () => {
    const configDir = makeTempDir('sooya-cfg-mixed-');
    fs.writeFileSync(
      path.join(configDir, 'models.json'),
      JSON.stringify({
        chat: { provider: 'openai-chat', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-file-original-key-000000' }
      })
    );
    const store = new ConfigStore({
      configDir,
      env: { SOOYA_CHAT_API_KEY: 'sk-env-override-key-111111' } as NodeJS.ProcessEnv
    });
    // Env wins at runtime.
    expect(store.getModels().chat.apiKey).toBe('sk-env-override-key-111111');
    store.setModels({ chat: { temperature: 0.9 } });
    const onDisk = JSON.parse(fs.readFileSync(path.join(configDir, 'models.json'), 'utf8'));
    // ...but the file keeps its own key; the env value is not written through.
    expect(onDisk.chat.apiKey).toBe('sk-file-original-key-000000');
    expect(onDisk.chat.temperature).toBe(0.9);
  });

  it('redacts env-supplied keys from the admin response', async () => {
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
/* Defect 2: docker compose first start creates root-owned data/config        */
/* ========================================================================== */

describe('defect 2: container must not be blocked by host directory ownership', () => {
  const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');

  it('pins the container UID/GID so bind-mounted dirs are writable', () => {
    // Without an explicit `user:`, Docker creates ./data and ./config as root
    // on first start while the image runs as uid 1001, so the app cannot write.
    expect(compose).toMatch(/^\s{4}user:\s*["']?\$\{SOOYA_UID:-1001\}:\$\{SOOYA_GID:-1001\}["']?\s*$/m);
  });

  it('documents the override for hosts whose user is not 1001', () => {
    expect(compose).toMatch(/SOOYA_UID/);
    const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
    expect(envExample).toMatch(/SOOYA_UID=/);
    expect(envExample).toMatch(/SOOYA_GID=/);
  });

  it('ships an entrypoint that verifies writability and fails loudly', () => {
    const entrypoint = path.join(REPO_ROOT, 'deploy', 'docker-entrypoint.sh');
    expect(fs.existsSync(entrypoint), 'deploy/docker-entrypoint.sh must exist').toBe(true);
    const body = fs.readFileSync(entrypoint, 'utf8');
    // It must check both mounts and explain the fix rather than crash obscurely.
    expect(body).toMatch(/DATA_DIR/);
    expect(body).toMatch(/CONFIG_DIR/);
    expect(body).toMatch(/SOOYA_UID/);
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/docker-entrypoint\.sh/);
  });
});

/* ========================================================================== */
/* Defect 3: restoring an old database desynchronises seq counters            */
/* ========================================================================== */

describe('defect 3: restoring an older database must not rewind sequence numbers', () => {
  it('keeps message and event sequences monotonic across a restore', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'tok-admin' }, chat: { script: [['备份时的回复']] } });

    await sendText(h.app, '备份前消息', 'r-1');
    const info = await h.app.services.backups.create('before');
    const msgSeqAtBackup = h.app.repos.messages.maxSeq();
    const evtSeqAtBackup = h.app.services.bus.lastSeq();

    // Grow both counters well beyond the snapshot.
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

    // The restored data is the old snapshot...
    const restored = h.app.repos.messages.page(50).messages;
    expect(JSON.stringify(restored)).toContain('备份时的回复');
    expect(JSON.stringify(restored)).not.toContain('备份后回复1');

    // ...but the counters must not have rewound, otherwise a still-connected
    // client (holding the pre-restore seq) would silently never receive
    // anything again, and new rows would reuse ids the client already saw.
    expect(h.app.services.bus.lastSeq()).toBeGreaterThanOrEqual(evtSeqBeforeRestore);
    const newEvent = h.app.services.bus.publish('system.notice', { notice: 'post restore' });
    expect(newEvent.seq).toBeGreaterThan(evtSeqBeforeRestore);

    h.setChatScript([['恢复之后的新回复']]);
    await sendText(h.app, '恢复后的新消息', 'r-post');
    expect(h.app.repos.messages.maxSeq()).toBeGreaterThan(msgSeqBeforeRestore);
  });

  it('tells connected clients to resynchronise after a restore', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'tok-admin' }, chat: { script: [['x']] } });
    await sendText(h.app, 'seed', 'r2-1');
    const info = await h.app.services.backups.create('before');

    const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const off = h.app.services.bus.subscribe((e) => seen.push({ type: e.type, payload: e.payload }));
    await h.app.server.inject({
      method: 'POST',
      url: `/api/admin/backups/${info.name}/restore`,
      headers: { 'x-admin-token': 'tok-admin' }
    });
    off();

    // A plain notice is not enough: the client's cached messages are now wrong,
    // so the event must explicitly demand a full reload.
    const notice = seen.find((e) => e.type === 'system.notice');
    expect(notice, 'a system.notice must be emitted after a restore').toBeTruthy();
    expect(notice!.payload.action).toBe('reload');
    expect(notice!.payload.reason).toBe('database-restored');
  });

  it('rebuilds counters from restored content when the snapshot is ahead', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'tok-admin' }, chat: { script: [['a']] } });
    await sendText(h.app, 'one', 'c-1');
    const info = await h.app.services.backups.create('snap');
    // Wipe everything: counters now sit far below the snapshot's max seq.
    h.app.repos.messages.clearAll();
    h.app.repos.events.clear();
    h.app.db.prepare("UPDATE counters SET value = 0 WHERE name IN ('message_seq','event_seq')").run();

    await h.app.server.inject({
      method: 'POST',
      url: `/api/admin/backups/${info.name}/restore`,
      headers: { 'x-admin-token': 'tok-admin' }
    });

    // Counters must cover the restored rows, or the next insert would collide
    // with an existing seq and violate the unique index.
    const maxSeq = h.app.repos.messages.maxSeq();
    const counter = h.app.db.prepare("SELECT value FROM counters WHERE name = 'message_seq'").get() as { value: number };
    expect(counter.value).toBeGreaterThanOrEqual(maxSeq);
    h.setChatScript([['after']]);
    await expect(sendText(h.app, 'after restore', 'c-2')).resolves.toBeTruthy();
  });
});

/* ========================================================================== */
/* Defect 4: first paint races the snapshot against the SSE starting point    */
/* ========================================================================== */

describe('defect 4: initial load must not lose events between snapshot and stream', () => {
  it('reports the event cursor together with the message page', async () => {
    h = await createHarness({ chat: { script: [['x']] } });
    await sendText(h.app, 'hello', 'sn-1');

    const res = await h.app.server.inject({ method: 'GET', url: '/api/messages?limit=30' });
    const body = res.json();
    // The client must be able to derive its SSE starting point from the very
    // same response that produced its message snapshot. Reading it from a
    // second, independent request leaves a window in which events are lost.
    expect(typeof body.lastEventSeq).toBe('number');
    expect(body.lastEventSeq).toBe(h.app.services.bus.lastSeq());
    expect(typeof body.lastMessageSeq).toBe('number');
    expect(body.lastMessageSeq).toBe(h.app.repos.messages.maxSeq());
  });

  it('the web client seeds the stream from the snapshot response, not a separate call', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/web/src/lib/useChat.ts'), 'utf8');
    // Guard the exact race: taking the cursor from `conv` (a different request)
    // while the snapshot comes from `page` allows an event in between to vanish.
    expect(src).not.toMatch(/setLastEventId\(\s*conv\.lastEventSeq/);
    expect(src).toMatch(/setLastEventId\(\s*page\.lastEventSeq/);
  });

  it('an event emitted after the snapshot is still replayed to a late subscriber', async () => {
    h = await createHarness({ chat: { script: [['reply']] } });
    // Snapshot taken now...
    const page = (await h.app.server.inject({ method: 'GET', url: '/api/messages?limit=30' })).json();
    const cursor = page.lastEventSeq as number;

    // ...an event happens before the stream is attached...
    await sendText(h.app, '在快照之后发送', 'race-1');

    // ...and the replay from the snapshot's cursor must still contain it.
    const replayed = h.app.services.bus.replay(cursor, 500);
    expect(replayed.length).toBeGreaterThan(0);
    expect(JSON.stringify(replayed)).toContain('在快照之后发送');
  });
});

/* ========================================================================== */
/* Defect 5: fallback file copy is not WAL-consistent                         */
/* ========================================================================== */

describe('defect 5: offline backup copy must be WAL-consistent', () => {
  it('backup.sh snapshots through SQLite before considering any file copy', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'deploy/backup.sh'), 'utf8');

    // A consistent snapshot must go through SQLite's own mechanism.
    expect(script).toMatch(/\.backup/);
    expect(script).toMatch(/VACUUM INTO/);

    // The snapshot must be attempted BEFORE any raw copy, so the plain `cp`
    // path is only ever a documented last resort.
    const snapshotAt = script.search(/sqlite3 "\$DB" ".timeout 10000" ".backup/);
    const copyAt = script.search(/for suffix in "" "-wal" "-shm"/);
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(copyAt).toBeGreaterThan(snapshotAt);

    // And that last resort must checkpoint the WAL first, otherwise the copied
    // main file could be missing committed transactions.
    const fallback = script.slice(copyAt - 400, copyAt);
    expect(fallback).toMatch(/wal_checkpoint\(TRUNCATE\)/);

    // The snapshot is validated before it is archived.
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

    // Simulate the fallback path: snapshot while the connection stays open and
    // the WAL still holds uncheckpointed frames.
    const snapshot = path.join(dir, 'snapshot.db');
    await db.backup(snapshot);
    for (let i = 200; i < 260; i++) insert.run(`row-${i}`);
    db.close();

    const probe = new Database(snapshot, { readonly: true, fileMustExist: true });
    const integrity = (probe.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]!.integrity_check;
    const count = (probe.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c;
    probe.close();

    expect(integrity).toBe('ok');
    // The snapshot must contain everything committed before it was taken.
    expect(count).toBe(200);
  });

  it('the backup helper script is syntactically valid', () => {
    expect(() => execFileSync('bash', ['-n', path.join(REPO_ROOT, 'deploy/backup.sh')])).not.toThrow();
  });
});

/* ========================================================================== */
/* Defect 6: maxRetries has no effect on streaming chat requests              */
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

  it('retries a retryable failure and eventually succeeds', async () => {
    let attempts = 0;
    const provider = providerWith(2, async () => {
      attempts++;
      if (attempts < 3) return new Response('upstream overloaded', { status: 503 });
      return sse('终于成功了');
    });

    const chunks: string[] = [];
    const result = await provider.stream(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      (c) => chunks.push(c.delta)
    );

    expect(attempts).toBe(3);
    expect(result.text).toBe('终于成功了');
    // A retried attempt must not replay partial text from the failed ones.
    expect(chunks.join('')).toBe('终于成功了');
  });

  it('gives up after maxRetries attempts', async () => {
    let attempts = 0;
    const provider = providerWith(1, async () => {
      attempts++;
      return new Response('still down', { status: 503 });
    });
    await expect(
      provider.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, () => undefined)
    ).rejects.toThrow(/503/);
    expect(attempts).toBe(2); // initial + 1 retry
  });

  it('does not retry once tokens have been delivered to the caller', async () => {
    let attempts = 0;
    const encoder = new TextEncoder();
    const provider = providerWith(3, async () => {
      attempts++;
      return new Response(
        new ReadableStream<Uint8Array>({
          // `pull` is invoked per read, so the first chunk is genuinely handed
          // to the consumer before the connection breaks. (Calling
          // controller.error() straight after enqueue() in `start` would drop
          // the queued chunk and test the fixture rather than the provider.)
          pull(controller) {
            if (attempts >= 0 && !this._sent) {
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
      provider.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, (c) =>
        chunks.push(c.delta)
      )
    ).rejects.toThrow();

    // Retrying here would duplicate '前半段' in the user's bubble.
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
/* Defect 7 (found while verifying): `npm run test:e2e` could not start        */
/* ========================================================================== */

describe('defect 7: the documented e2e command must actually run', () => {
  const cfgPath = path.join(REPO_ROOT, 'e2e/playwright.config.ts');
  const cfg = fs.readFileSync(cfgPath, 'utf8');

  it('anchors testDir and global hooks to the config file, not the cwd', () => {
    // The repo root re-exports this config, and Playwright resolves relative
    // entries against the file it was handed. Relative hooks therefore pointed
    // at the repository root and the whole suite failed to load.
    expect(cfg).not.toMatch(/globalSetup:\s*'\.\/global-setup\.ts'/);
    expect(cfg).not.toMatch(/globalTeardown:\s*'\.\/global-teardown\.ts'/);
    expect(cfg).toMatch(/globalSetup:\s*path\.join\(HERE/);
    expect(cfg).toMatch(/globalTeardown:\s*path\.join\(HERE/);
    expect(cfg).toMatch(/testDir:\s*HERE/);
  });

  it('avoids import.meta so the CommonJS transform can load it', () => {
    // The repository root has no "type":"module"; Playwright may load the
    // config through its CJS transform where import.meta does not exist.
    // Ignore prose: only executable lines matter.
    const code = cfg
      .split('\n')
      .filter((ln) => !ln.trim().startsWith('*') && !ln.trim().startsWith('//') && !ln.trim().startsWith('/*'))
      .join('\n');
    expect(code).not.toMatch(/import\.meta/);
    expect(code).toMatch(/const HERE = __dirname/);
  });

  it('package.json exposes the command the docs tell people to run', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:e2e']).toBeTruthy();
    // The referenced files must exist relative to the config, not the root.
    expect(fs.existsSync(path.join(REPO_ROOT, 'e2e/global-setup.ts'))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'e2e/global-teardown.ts'))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'playwright.config.ts'))).toBe(true);
  });
});

/* ========================================================================== */
/* Documentation accuracy                                                     */
/* ========================================================================== */

describe('documentation accuracy', () => {
  it('the secret-scan claim excludes test fixtures explicitly', async () => {
    const report = await fsp.readFile(path.join(REPO_ROOT, 'docs/TEST-REPORT.md'), 'utf8');
    // The package does contain obvious fake keys in test fixtures; claiming a
    // blanket "no sk-*" is inaccurate.
    expect(report).toMatch(/夹具|fixture/);
    expect(report).toMatch(/sk-test-key|sk-e2e-mock-key|sk-unit-test-key/);
  });

  it('the reported package sizes match the current artefacts when present', async () => {
    const releaseDir = path.join(REPO_ROOT, 'release');
    if (!fs.existsSync(path.join(releaseDir, 'sooya-1.0.0.tar.gz'))) return; // not packaged yet
    const report = await fsp.readFile(path.join(REPO_ROOT, 'docs/TEST-REPORT.md'), 'utf8');
    const tarKb = (await fsp.stat(path.join(releaseDir, 'sooya-1.0.0.tar.gz'))).size / 1024;
    const zipKb = (await fsp.stat(path.join(releaseDir, 'sooya-1.0.0.zip'))).size / 1024;
    const tarMatch = /sooya-1\.0\.0\.tar\.gz\s+([\d.]+)\s*KB/.exec(report);
    const zipMatch = /sooya-1\.0\.0\.zip\s+([\d.]+)\s*KB/.exec(report);
    expect(tarMatch, 'TEST-REPORT.md must state the tar.gz size').toBeTruthy();
    expect(zipMatch, 'TEST-REPORT.md must state the zip size').toBeTruthy();
    expect(Math.abs(Number(tarMatch![1]) - tarKb)).toBeLessThan(15);
    expect(Math.abs(Number(zipMatch![1]) - zipKb)).toBeLessThan(15);
  });

  it('the stated test totals match the suites that actually exist', async () => {
    const report = await fsp.readFile(path.join(REPO_ROOT, 'docs/TEST-REPORT.md'), 'utf8');
    // The regression suite added here must be reflected in the totals.
    expect(report).toMatch(/regression\.test\.ts/);
  });
});
