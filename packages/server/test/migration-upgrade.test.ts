import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/index.js';
import { MIGRATIONS, LATEST_VERSION } from '../src/db/migrations.js';

/**
 * P1-2: real v14 → latest database migration. The fixture is built by running
 * the actual migration 1-14 objects (the same code production runs) plus
 * legacy-shaped rows: a 'running' reply batch (pre-v15 status), batch
 * membership, a message, settings and a proactive attempt.
 */
async function makeV14Fixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sooya-v14-'));
  const file = path.join(dir, 'sooya.db');
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS.slice(0, 14)) {
    db.transaction(() => {
      migration.up(db as never);
      insert.run(migration.version, migration.name, new Date().toISOString());
    })();
  }
  // Legacy fixture rows (v14 shapes).
  db.exec(`
    INSERT INTO messages(id, conversation_id, role, created_at, updated_at, seq, status, client_msg_id, reply_to, error, meta_json)
      VALUES ('msg_v14_1', 'main', 'user', '2026-07-31T09:00:00.000Z', '2026-07-31T09:00:00.000Z', 1, 'sent', 'v14-client', NULL, NULL, '{}');
    INSERT INTO reply_batches(id, conversation_id, status, trigger_message_id, assistant_message_id, opened_at, due_at, started_at, completed_at, last_error, attempts, lease_owner, lease_expires_at, meta_json)
      VALUES ('rb_v14_running', 'main', 'running', 'msg_v14_1', NULL, '2026-07-31T09:00:00.000Z', '2026-07-31T09:00:01.000Z', NULL, NULL, NULL, 1, 'dead-worker', '2026-07-31T08:59:00.000Z', '{}');
    INSERT INTO reply_batch_messages(batch_id, message_id, position, created_at)
      VALUES ('rb_v14_running', 'msg_v14_1', 0, '2026-07-31T09:00:00.000Z');
    INSERT INTO settings(key, value_json, updated_at) VALUES ('persona.name', '"旧版人设"', '2026-07-31T09:00:00.000Z');
    INSERT INTO life_state(id, activity, kind, mood, started_at, ends_at, updated_at, meta_json)
      VALUES (1, '睡午觉', 'rest', '困', '2026-07-31T12:00:00.000Z', '2026-07-31T13:00:00.000Z', '2026-07-31T12:00:00.000Z', '{}');
    INSERT INTO life_log(id, activity, kind, mood, started_at, ended_at, shared, created_at)
      VALUES ('life_v14_1', '吃早饭', 'meal', '满足', '2026-07-31T08:00:00.000Z', '2026-07-31T08:30:00.000Z', 0, '2026-07-31T08:30:00.000Z');
    INSERT INTO proactive_attempts(id, candidate_id, candidate_kind, candidate_activity, status, blocked_reason, requested_mode, final_mode, fallback_reason, message_id, send_success, user_response_message_id, user_responded_at, detail_json, created_at, updated_at)
      VALUES ('pa_v14_1', 'cand_v14', 'play', '练琴', 'blocked', 'nothing_worth_saying', 'text', NULL, NULL, NULL, 0, NULL, NULL, '{}', '2026-07-31T09:00:00.000Z', '2026-07-31T09:00:00.000Z');
  `);
  db.close();
  return dir;
}

describe('v14 → latest migration upgrade (P1-2)', () => {
  it('migrates a v14 database to the latest version and preserves data', async () => {
    const dir = await makeV14Fixture();
    try {
      const opened = openDatabase({ file: path.join(dir, 'sooya.db'), backupDir: path.join(dir, 'backup'), onLog: () => {} });
      try {
        const version = (opened.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
        expect(version).toBe(LATEST_VERSION);

        // Data preserved across the rebuilds.
        const msg = opened.db.prepare("SELECT * FROM messages WHERE id = 'msg_v14_1'").get() as { role: string; seq: number };
        expect(msg.role).toBe('user');
        expect(msg.seq).toBe(1);
        const setting = opened.db.prepare("SELECT value_json FROM settings WHERE key = 'persona.name'").get() as { value_json: string };
        expect(setting.value_json).toBe('"旧版人设"');
        const life = opened.db.prepare('SELECT activity FROM life_state WHERE id = 1').get() as { activity: string };
        expect(life.activity).toBe('睡午觉');
        const attempt = opened.db.prepare("SELECT * FROM proactive_attempts WHERE id = 'pa_v14_1'").get() as { status: string };
        expect(attempt.status).toBe('blocked');

        // The legacy 'running' row is normalized to 'generating' by v15.
        const batch = opened.db.prepare("SELECT * FROM reply_batches WHERE id = 'rb_v14_running'").get() as { status: string; revision: number };
        expect(batch.status).toBe('generating');
        expect(batch.revision).toBe(1);

        // Batch membership order preserved.
        const membership = opened.db.prepare(
          "SELECT position FROM reply_batch_messages WHERE batch_id = 'rb_v14_running' ORDER BY position"
        ).all() as Array<{ position: number }>;
        expect(membership.map((r) => r.position)).toEqual([0]);

        // Foreign keys stay intact.
        expect(opened.db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        opened.db.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('a failing migration transaction rolls back completely', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sooya-rollback-'));
    const file = path.join(dir, 'sooya.db');
    const db = new Database(file);
    try {
      const tx = db.transaction(() => {
        db.exec('CREATE TABLE broken_test (id INTEGER)');
        db.exec('THIS IS NOT SQL');
      });
      expect(() => tx()).toThrow();
      // The CREATE TABLE rolled back with the transaction.
      const table = db.prepare("SELECT name FROM sqlite_master WHERE name = 'broken_test'").get();
      expect(table).toBeUndefined();
    } finally {
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
