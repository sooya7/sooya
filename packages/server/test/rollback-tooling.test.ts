import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import Database from 'better-sqlite3';
import { MIGRATIONS, LATEST_VERSION } from '../src/db/migrations.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');

function runScript(script: string, dataDir: string, args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts', script), '--data-dir', dataDir, ...args],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout, stderr });
      }
    );
  });
}

/**
 * P0-5: rollback tooling — preflight reports post-v15 open states,
 * normalize converts them (after explicit confirmation), and the database is
 * left downgrade-safe.
 */
describe('rollback tooling (P0-5)', () => {
  it('preflight flags open states; normalize clears them; preflight then passes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sooya-rollback-'));
    const dbDir = path.join(dir, 'database');
    await fs.mkdir(dbDir, { recursive: true });
    const file = path.join(dbDir, 'sooya.db');
    const db = new Database(file);
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)');
    for (const m of MIGRATIONS) {
      db.transaction(() => { m.up(db as never); insert.run(m.version, m.name, new Date().toISOString()); })();
    }
    expect(LATEST_VERSION).toBe(29);
    db.exec(`
      INSERT INTO messages(id, conversation_id, role, created_at, updated_at, seq, status, client_msg_id, reply_to, error, meta_json)
        VALUES ('msg_rb_1','main','user','2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z',1,'sent',NULL,NULL,NULL,'{}');
      INSERT INTO reply_batches(id, conversation_id, status, trigger_message_id, assistant_message_id, opened_at, due_at, started_at, completed_at, last_error, attempts, lease_owner, lease_expires_at, meta_json, revision, last_message_at, generation_started_at, publish_started_at, visible_at, retry_count, interrupted_count, superseded_at, failure_code)
        VALUES
          ('rb_gen','main','generating','msg_rb_1',NULL,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:01.000Z',NULL,NULL,NULL,1,'dead','2026-08-01T00:00:00.000Z','{}',1,'2026-08-01T00:00:00.000Z',NULL,NULL,NULL,0,0,NULL,NULL),
          ('rb_pub','main','publishing','msg_rb_1',NULL,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:01.000Z',NULL,NULL,NULL,1,'dead','2026-08-01T00:00:00.000Z','{}',1,'2026-08-01T00:00:00.000Z',NULL,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z',0,0,NULL,NULL),
          ('rb_sup','main','superseded','msg_rb_1',NULL,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:01.000Z',NULL,NULL,NULL,1,'dead','2026-08-01T00:00:00.000Z','{}',1,'2026-08-01T00:00:00.000Z',NULL,NULL,NULL,0,0,'2026-08-01T00:00:00.000Z',NULL);
    `);
    db.close();

    try {
      // Preflight must fail with the open states listed.
      const pre = await runScript('rollback-preflight.mjs', dir);
      expect(pre.code).toBe(1);
      expect(pre.stdout).toContain('generating');
      expect(pre.stdout).toContain('superseded');
      expect(pre.stderr).toContain('open reply batches');

      // Normalize (--yes) converts them.
      const norm = await runScript('rollback-normalize.mjs', dir, ['--yes']);
      expect(norm.code).toBe(0);
      expect(norm.stdout).toContain('generating -> queued');
      expect(norm.stdout).toContain('publishing (visible) -> completed/partial');
      expect(norm.stdout).toContain('superseded -> cancelled');

      // Preflight now passes.
      const after = await runScript('rollback-preflight.mjs', dir);
      expect(after.code).toBe(0);

      const check = new Database(file, { readonly: true });
      try {
        const rows = check.prepare('SELECT id, status FROM reply_batches ORDER BY id').all() as Array<{ id: string; status: string }>;
        expect(rows).toEqual([
          { id: 'rb_gen', status: 'queued' },
          { id: 'rb_pub', status: 'completed' },
          { id: 'rb_sup', status: 'cancelled' }
        ]);
      } finally {
        check.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
