import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import pino from 'pino';
import { createHarness, sendText, ASSETS_DIR, type Harness } from './helpers/harness.js';
import { buildApp } from '../src/app.js';
import { openDatabase, checkIntegrity, migrate, classifyDbError, classifyIntegrityFailure } from '../src/db/index.js';
import { MIGRATIONS, LATEST_VERSION } from '../src/db/migrations.js';

/**
 * Temp directories created by these tests are tracked and removed at the end of
 * the file, so repeated runs do not slowly fill /tmp with abandoned databases.
 */
const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

let h: Harness;
afterEach(async () => {
  if (h) await h.cleanup();
});

describe('database migrations', () => {
  it('applies every migration and is idempotent', () => {
    const dir = makeTempDir('sooya-mig-');
    const file = path.join(dir, 'a.db');
    const { db } = openDatabase({ file });
    const applied = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{
      version: number;
    }>;
    expect(applied.map((a) => a.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(migrate(db)).toBe(LATEST_VERSION);
    expect((db.prepare('SELECT COUNT(*) c FROM schema_migrations').get() as { c: number }).c).toBe(MIGRATIONS.length);
    db.close();
  });

  it('creates every required table with WAL and foreign keys', () => {
    const dir = makeTempDir('sooya-tables-');
    const { db } = openDatabase({ file: path.join(dir, 'b.db') });
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map(
        (r) => r.name
      )
    );
    for (const required of [
      'messages',
      'message_parts',
      'media',
      'memories',
      'memory_sources',
      'summaries',
      'jobs',
      'settings',
      'schema_migrations'
    ]) {
      expect(tables.has(required), required).toBe(true);
    }
    expect((db.pragma('journal_mode') as Array<{ journal_mode: string }>)[0]!.journal_mode).toBe('wal');
    expect((db.pragma('foreign_keys') as Array<{ foreign_keys: number }>)[0]!.foreign_keys).toBe(1);
    db.close();
  });

  it('cascades part deletion with the parent message', async () => {
    h = await createHarness({ chat: { script: [['ok']] } });
    const { body } = await sendText(h.app, '你好');
    const before = (h.app.db.prepare('SELECT COUNT(*) c FROM message_parts').get() as { c: number }).c;
    expect(before).toBeGreaterThan(0);
    h.app.db.prepare('DELETE FROM messages WHERE id = ?').run(body.reply.id);
    const after = (h.app.db.prepare('SELECT COUNT(*) c FROM message_parts WHERE message_id = ?').get(body.reply.id) as {
      c: number;
    }).c;
    expect(after).toBe(0);
  });
});

describe('database corruption recovery', () => {
  it('detects corruption, quarantines the file and restores from a valid backup', async () => {
    const dir = makeTempDir('sooya-corrupt-');
    const dbFile = path.join(dir, 'sooya.db');
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    // Create a healthy database with content, and a backup of it.
    const { db } = openDatabase({ file: dbFile });
    db.prepare(
      "INSERT INTO messages(id, conversation_id, role, created_at, updated_at, seq, status, meta_json) VALUES ('m1','main','user',?,?,1,'sent','{}')"
    ).run(new Date().toISOString(), new Date().toISOString());
    await db.backup(path.join(backupDir, 'good.db'));
    db.close();

    // Corrupt the live database.
    const handle = fs.openSync(dbFile, 'r+');
    fs.writeSync(handle, Buffer.alloc(4096, 0x41), 0, 4096, 8192);
    fs.closeSync(handle);
    fs.rmSync(`${dbFile}-wal`, { force: true });
    fs.rmSync(`${dbFile}-shm`, { force: true });

    const recovered = openDatabase({ file: dbFile, backupDir });
    expect(recovered.recovered).toBe(true);
    expect(recovered.recoveredFrom).toBe('backup');
    expect(checkIntegrity(recovered.db)).toBeNull();
    const row = recovered.db.prepare("SELECT id FROM messages WHERE id = 'm1'").get() as { id: string } | undefined;
    expect(row?.id).toBe('m1');
    recovered.db.close();

    // The corrupt file must be preserved for forensics, not silently deleted.
    const quarantined = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(quarantined.length).toBeGreaterThan(0);
  });

  /*
   * Everything below encodes the production incident of 2026-07-31: a missing
   * `better_sqlite3.node` was classified as "database corrupt", the live file was
   * renamed away, no backup could be opened (same missing module), and the code
   * created an EMPTY database and kept serving it. Refusing to start beats
   * serving nothing, so these tests assert refusal plus an untouched file.
   */
  it('refuses to start — and touches nothing — when it cannot even open the file', () => {
    const dir = makeTempDir('sooya-cantopen-');
    // A directory where the database should be: sqlite reports SQLITE_CANTOPEN,
    // which stands in for the real cause (missing native module, EACCES, ENOSPC).
    const dbFile = path.join(dir, 'sooya.db');
    fs.mkdirSync(dbFile);
    fs.writeFileSync(path.join(dbFile, 'sentinel'), 'still here');

    expect(() => openDatabase({ file: dbFile, backupDir: path.join(dir, 'backups') })).toThrow(
      /could not be opened/i
    );
    // Not quarantined, not deleted, not replaced.
    expect(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toHaveLength(0);
    expect(fs.readFileSync(path.join(dbFile, 'sentinel'), 'utf8')).toBe('still here');
  });

  it('classifies a missing native module as unusable, never as corruption', () => {
    expect(classifyDbError(new Error('Could not locate the bindings file. Tried: …'))).toBe('unusable');
    expect(classifyDbError(Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' }))).toBe(
      'unusable'
    );
    expect(classifyDbError(Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }))).toBe('unusable');
    expect(classifyDbError(Object.assign(new Error('malformed'), { code: 'SQLITE_CORRUPT' }))).toBe('corrupt');
    expect(classifyDbError(new Error('file is not a database'))).toBe('corrupt');
    expect(classifyIntegrityFailure('integrity_check: page 3 is never used')).toBe('corrupt');
    expect(classifyIntegrityFailure('foreign_key_check: 2 violation(s)')).toBe('inconsistent');
  });

  it('refuses to replace a corrupt database when there is no usable backup', () => {
    const dir = makeTempDir('sooya-corrupt2-');
    const dbFile = path.join(dir, 'sooya.db');
    const garbage = Buffer.from('this is definitely not a sqlite database file, at all');
    fs.writeFileSync(dbFile, garbage);

    expect(() => openDatabase({ file: dbFile, backupDir: path.join(dir, 'backups') })).toThrow(
      /no restorable backup/i
    );
    // The original bytes are still exactly where they were: recoverable by hand.
    expect(fs.readFileSync(dbFile)).toEqual(garbage);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toHaveLength(0);
  });

  it('refuses when the only backup is unusable, instead of starting empty', () => {
    const dir = makeTempDir('sooya-corrupt3-');
    const dbFile = path.join(dir, 'sooya.db');
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'bad.db'), Buffer.from('garbage backup'));
    const live = Buffer.from('garbage live db');
    fs.writeFileSync(dbFile, live);

    expect(() => openDatabase({ file: dbFile, backupDir })).toThrow(/no restorable backup/i);
    expect(fs.readFileSync(dbFile)).toEqual(live);
  });

  it('serves a database with foreign key violations as-is rather than replacing it', () => {
    const dir = makeTempDir('sooya-fk-');
    const dbFile = path.join(dir, 'sooya.db');
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    const { db } = openDatabase({ file: dbFile });
    db.prepare(
      "INSERT INTO messages(id, conversation_id, role, created_at, updated_at, seq, status, meta_json) VALUES ('keep','main','user',?,?,1,'sent','{}')"
    ).run(new Date().toISOString(), new Date().toISOString());
    db.pragma('foreign_keys = OFF');
    // A part pointing at a message that does not exist: an inconsistency, not corruption.
    db.prepare(
      "INSERT INTO message_parts(id, message_id, idx, type, text, status) VALUES ('orphan','ghost',0,'text','hi','sent')"
    ).run();
    db.close();

    const logs: Array<{ level: string; msg: string }> = [];
    const opened = openDatabase({ file: dbFile, backupDir, onLog: (level, msg) => logs.push({ level, msg }) });
    expect(opened.recovered).toBe(false);
    expect(opened.inconsistent).toMatch(/foreign_key_check/);
    expect(logs.some((l) => l.level === 'error' && /NOT replacing it/.test(l.msg))).toBe(true);
    expect((opened.db.prepare("SELECT id FROM messages WHERE id = 'keep'").get() as { id: string }).id).toBe('keep');
    opened.db.close();
    expect(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toHaveLength(0);
  });
});

describe('backup and restore', () => {
  it('creates a verified backup with a checksum and manifest', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'tok-admin' }, chat: { script: [['备份前的消息']] } });
    await sendText(h.app, '你好');
    const res = await h.app.server.inject({
      method: 'POST',
      url: '/api/admin/backups',
      headers: { 'x-admin-token': 'tok-admin' }
    });
    expect(res.statusCode).toBe(200);
    const backup = res.json().backup;
    expect(backup.verified).toBe(true);
    expect(backup.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(backup.path)).toBe(true);
    expect(fs.existsSync(`${backup.path}.sha256`)).toBe(true);
    expect(fs.existsSync(`${backup.path}.json`)).toBe(true);

    const verify = await h.app.server.inject({
      method: 'POST',
      url: `/api/admin/backups/${backup.name}/verify`,
      headers: { 'x-admin-token': 'tok-admin' }
    });
    expect(verify.json().ok).toBe(true);
  });

  it('detects a tampered backup', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'tok-admin' } });
    const info = await h.app.services.backups.create('test');
    await fsp.appendFile(info.path, 'tampered');
    const check = await h.app.services.backups.verify(info.name);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('checksum');
  });

  it('restores data from a backup and keeps the pre-restore file', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'tok-admin' }, chat: { script: [['备份时存在的回复']] } });
    await sendText(h.app, '第一条消息', 'b1');
    const info = await h.app.services.backups.create('before');
    const countAtBackup = h.app.repos.messages.count();

    h.setChatScript([['备份之后的回复']]);
    await sendText(h.app, '第二条消息', 'b2');
    expect(h.app.repos.messages.count()).toBe(countAtBackup + 2);

    const res = await h.app.server.inject({
      method: 'POST',
      url: `/api/admin/backups/${info.name}/restore`,
      headers: { 'x-admin-token': 'tok-admin' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().preservedAs).toBeTruthy();
    expect(fs.existsSync(res.json().preservedAs)).toBe(true);

    const after = await h.app.server.inject({ method: 'GET', url: '/api/messages?limit=50' });
    const messages = after.json().messages;
    expect(messages).toHaveLength(countAtBackup);
    expect(JSON.stringify(messages)).toContain('备份时存在的回复');
    expect(JSON.stringify(messages)).not.toContain('备份之后的回复');
  });

  it('refuses to restore an invalid backup', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'tok-admin' } });
    const info = await h.app.services.backups.create('x');
    await fsp.writeFile(info.path, 'not a database');
    await expect(h.app.services.backups.restore(info.name)).rejects.toThrow(/refusing/);
  });

  it('applies the retention policy', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'tok-admin', BACKUP_KEEP: '2' } });
    for (let i = 0; i < 4; i++) {
      await h.app.services.backups.create(`r${i}`);
      await new Promise((r) => setTimeout(r, 1100)); // filenames are second-resolution
    }
    const list = await h.app.services.backups.list();
    expect(list.length).toBe(2);
  }, 30_000);
});

describe('crash recovery', () => {
  it('requeues jobs that were running when the process died', async () => {
    h = await createHarness();
    const job = h.app.repos.jobs.enqueue('memory.extract', { userMessageId: 'x' });
    h.app.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(job.id);
    expect(h.app.repos.jobs.recoverStuck()).toBe(1);
    const after = h.app.repos.jobs.list(10).find((j) => j.id === job.id)!;
    expect(after.status).toBe('pending');
  });

  it('marks interrupted assistant messages as failed on restart', async () => {
    const dir = makeTempDir('sooya-restart-');
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: path.join(dir, 'data'),
      CONFIG_DIR: path.join(dir, 'config'),
      ENABLE_BACKGROUND_JOBS: 'false'
    };
    const first = await buildApp({ env, logger: pino({ level: 'silent' }), assetsDir: ASSETS_DIR, startWorkers: false });
    first.repos.messages.create({ role: 'assistant', status: 'sending', parts: [{ type: 'text', text: '被中断的回复' }] });
    await first.close();

    const second = await buildApp({ env, logger: pino({ level: 'silent' }), assetsDir: ASSETS_DIR, startWorkers: false });
    const messages = second.repos.messages.page(10).messages;
    expect(messages[0]!.status).toBe('failed');
    expect(messages[0]!.error).toContain('interrupted');
    // The text is still there — the user sees what was produced.
    expect(messages[0]!.content[0]!.text).toBe('被中断的回复');
    await second.close();
  });

  it('marks interrupted media parts as failed on restart so the UI stops spinning', async () => {
    const dir = makeTempDir('sooya-restart-parts-');
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: path.join(dir, 'data'),
      CONFIG_DIR: path.join(dir, 'config'),
      ENABLE_BACKGROUND_JOBS: 'false'
    };
    const first = await buildApp({ env, logger: pino({ level: 'silent' }), assetsDir: ASSETS_DIR, startWorkers: false });
    // A reply killed mid-generation: shell still 'sending', image part still 'pending'.
    const { message } = first.repos.messages.create({
      role: 'assistant',
      status: 'sending',
      parts: [{ type: 'image', status: 'pending', meta: { prompt: '被中断的自拍', selfie: true } }]
    });
    await first.close();

    const second = await buildApp({ env, logger: pino({ level: 'silent' }), assetsDir: ASSETS_DIR, startWorkers: false });
    const after = second.repos.messages.page(10).messages.find((m) => m.id === message.id)!;
    expect(after.status).toBe('failed');
    expect(after.content[0]!.status).toBe('failed');
    expect(after.content[0]!.error).toContain('interrupted');
    await second.close();
  });

  it('media files and messages survive a full restart', async () => {
    const dir = makeTempDir('sooya-persist-');
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: path.join(dir, 'data'),
      CONFIG_DIR: path.join(dir, 'config'),
      ENABLE_BACKGROUND_JOBS: 'false',
      ADMIN_API_TOKEN: 'persist-admin-token'
    };
    const first = await buildApp({ env, logger: pino({ level: 'silent' }), assetsDir: ASSETS_DIR, startWorkers: false });
    const sticker = first.services.stickerLibrary.available()[0]!;
    const stickerCountBefore = first.services.stickerLibrary.all().length;
    const created = first.repos.messages.create({
      role: 'assistant',
      parts: [
        { type: 'text', text: '重启前的消息' },
        { type: 'sticker', mediaId: sticker.mediaId }
      ]
    }).message;
    await first.close();

    const second = await buildApp({ env, logger: pino({ level: 'silent' }), assetsDir: ASSETS_DIR, startWorkers: false });
    const restored = second.repos.messages.get(created.id)!;
    expect(restored.content).toHaveLength(2);
    expect(restored.content[1]!.media!.url).toBe(`/api/media/${sticker.mediaId}`);
    const res = await second.server.inject({ method: 'GET', url: `/api/media/${sticker.mediaId}`, headers: { 'x-admin-token': 'persist-admin-token' } });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBeGreaterThan(100);
    // Stickers are not re-imported into duplicates on the second boot.
    expect(second.services.stickerLibrary.all().length).toBe(stickerCountBefore);
    await second.close();
  });
});

describe('job worker', () => {
  it('retries a failing job and eventually marks it failed', async () => {
    h = await createHarness();
    let attempts = 0;
    h.app.services.worker.register('flaky', async () => {
      attempts++;
      throw new Error('always fails');
    });
    h.app.repos.jobs.enqueue('flaky', {}, { maxAttempts: 2 });
    for (let i = 0; i < 5; i++) {
      await h.app.services.worker.drain();
      h.app.db.prepare("UPDATE jobs SET run_after = NULL WHERE status = 'pending'").run();
    }
    expect(attempts).toBe(2);
    const job = h.app.repos.jobs.list(5)[0]!;
    expect(job.status).toBe('failed');
    expect(job.last_error).toContain('always fails');
  });

  it('a job without a handler does not crash the worker', async () => {
    h = await createHarness();
    expect(() => h.app.repos.jobs.enqueue('nonexistent.type', {}, { maxAttempts: 1 })).toThrow(/unknown job type/);
  });
});

describe('graceful shutdown', () => {
  it('closes cleanly with pending work', async () => {
    const dir = makeTempDir('sooya-shutdown-');
    const app = await buildApp({
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATA_DIR: path.join(dir, 'data'),
        CONFIG_DIR: path.join(dir, 'config'),
        ENABLE_BACKGROUND_JOBS: 'true'
      },
      logger: pino({ level: 'silent' }),
      assetsDir: ASSETS_DIR
    });
    app.repos.jobs.enqueue('maintenance', {});
    await app.close();
    // Reopening must succeed -> the database was left in a clean state.
    const probe = new Database(path.join(dir, 'data', 'database', 'sooya.db'), { readonly: true });
    expect(checkIntegrity(probe)).toBeNull();
    probe.close();
  });
});

describe('media integrity', () => {
  it('does not store media bytes inside the database', async () => {
    h = await createHarness();
    const stats = h.app.db
      .prepare("SELECT SUM(LENGTH(COALESCE(rel_path,''))) total, SUM(bytes) filebytes FROM media")
      .get() as { total: number; filebytes: number };
    expect(stats.filebytes).toBeGreaterThan(0);
    // The DB stores only paths/metadata; binary payload columns must not exist.
    const cols = (h.app.db.prepare('PRAGMA table_info(media)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain('data');
    expect(cols).not.toContain('base64');
  });

  it('garbage-collects uploads that were never attached to a message', async () => {
    h = await createHarness();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const form = new FormData();
    form.set('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'orphan.png');
    const orphanId = (await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form })).json().media[0].id;
    const orphanPath = h.app.services.mediaStore.absolutePath(h.app.repos.media.get(orphanId)!);
    expect(fs.existsSync(orphanPath)).toBe(true);

    // A fresh draft must survive: the user may still be composing.
    expect(await h.app.services.mediaStore.collectOrphans()).not.toContain(orphanId);
    expect(h.app.repos.media.get(orphanId)).toBeTruthy();

    // Once it is old enough it is collected, file and row together.
    const removed = await h.app.services.mediaStore.collectOrphans(0);
    expect(removed).toContain(orphanId);
    expect(h.app.repos.media.get(orphanId)).toBeUndefined();
    expect(fs.existsSync(orphanPath)).toBe(false);
  });

  it('never garbage-collects media that a message or the sticker library uses', async () => {
    h = await createHarness({ chat: { script: [['收到']] } });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const form = new FormData();
    form.set('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'kept.png');
    const keptId = (await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form })).json().media[0].id;
    await h.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: { clientMsgId: 'keep-1', content: [{ type: 'image', mediaId: keptId }] }
    });

    const stickerBefore = h.app.services.stickerLibrary.count();
    const removed = await h.app.services.mediaStore.collectOrphans(0);
    expect(removed).not.toContain(keptId);
    expect(h.app.repos.media.get(keptId)).toBeTruthy();
    expect(h.app.services.stickerLibrary.count()).toBe(stickerBefore);
  });

  it('never garbage-collects persona avatar uploads', async () => {
    h = await createHarness();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const store = h.app.services.mediaStore;

    // Uploads tagged meta:{avatar:slot} are excluded by the query itself.
    const tagged = await store.save({ kind: 'image', origin: 'upload', data: png, declaredMime: 'image/png', filename: 'avatar.png', meta: { avatar: 'user' } });
    const taggedPath = store.absolutePath(h.app.repos.media.get(tagged.id)!);
    expect(await store.collectOrphans(0)).not.toContain(tagged.id);
    expect(h.app.repos.media.get(tagged.id)).toBeTruthy();
    expect(fs.existsSync(taggedPath)).toBe(true);

    // Anything the persona points at is protected via the caller-supplied set,
    // even without the avatar meta tag (e.g. older rows).
    const plain = await store.save({ kind: 'image', origin: 'upload', data: png, declaredMime: 'image/png', filename: 'plain.png' });
    h.app.config.setPersona({ userAvatar: `/api/media/${plain.id}` });
    expect(await store.collectOrphans(0, h.app.services.storage.avatarMediaIds())).not.toContain(plain.id);
    expect(h.app.repos.media.get(plain.id)).toBeTruthy();

    // Once the persona no longer references it and no meta tag exists, it is collectable again.
    h.app.config.setPersona({ userAvatar: '/avatars/user.svg' });
    expect(await store.collectOrphans(0, h.app.services.storage.avatarMediaIds())).toContain(plain.id);
  });

  it('reconciles media rows whose files vanished', async () => {
    h = await createHarness();
    const sticker = h.app.services.stickerLibrary.available()[0]!;
    const media = h.app.repos.media.get(sticker.mediaId)!;
    await fsp.rm(h.app.services.mediaStore.absolutePath(media), { force: true });
    const missing = await h.app.services.mediaStore.reconcile();
    expect(missing).toContain(media.id);
    const res = await h.app.server.inject({ method: 'GET', url: `/api/media/${media.id}` });
    expect(res.statusCode).toBe(404);
  });
});
