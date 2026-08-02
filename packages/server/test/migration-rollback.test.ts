import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/index.js';
import { LATEST_VERSION, MIGRATIONS } from '../src/db/migrations.js';

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) { try { db.close(); } catch { /* already closed */ } } });
function memoryDb(): Database.Database { const db = new Database(':memory:'); open.push(db); return db; }

describe('database migrations and transactional rollback', () => {
  it('migrates a clean database to the latest schema without world tables', () => {
    const db = memoryDb();
    expect(migrate(db)).toBe(LATEST_VERSION);
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    expect(versions.map((row) => row.version)).toEqual(Array.from({ length: LATEST_VERSION }, (_, index) => index + 1));
    const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
    expect(names.has('world_entries')).toBe(false);
    expect(names.has('world_sources')).toBe(false);
    for (const required of ['push_subscriptions', 'audit_log', 'storage_samples', 'memories', 'life_state', 'life_log', 'media_text', 'messages_fts']) expect(names.has(required)).toBe(true);
  });

  it('migration 7 removes deprecated world data while preserving live data', () => {
    const db = memoryDb();
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 6)) {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, new Date().toISOString());
    }
    db.exec(`
      INSERT INTO world_entries(id, kind, subject, predicate, object, created_at, updated_at) VALUES ('w1','fact','u','p','o',datetime('now'),datetime('now'));
      INSERT INTO jobs(id, type, payload_json, status, attempts, created_at, updated_at, run_after) VALUES ('j1','world.extract','{}','pending',0,datetime('now'),datetime('now'),datetime('now'));
      INSERT INTO events(id, seq, type, payload_json, created_at) VALUES ('e1',1,'world.updated','{}',datetime('now'));
      INSERT INTO memories(id, kind, content, normalized, created_at, updated_at) VALUES ('m1','profile','保留','保留',datetime('now'),datetime('now'));
      INSERT INTO life_state(id, activity, kind, mood, started_at, ends_at, updated_at) VALUES (1,'工作','work','平静',datetime('now'),datetime('now'),datetime('now'));
    `);
    MIGRATIONS.find((item) => item.version === 7)!.up(db);
    expect(() => db.prepare('SELECT * FROM world_entries').all()).toThrow();
    expect((db.prepare("SELECT COUNT(*) c FROM jobs WHERE type LIKE 'world.%'").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM events WHERE type='world.updated'").get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM life_state').get() as { c: number }).c).toBe(1);
  });

  it('rolls back every statement in a failed migration and does not record its version', () => {
    const db = memoryDb();
    db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, 'initial_schema', datetime('now')), (2, 'error_log', datetime('now')), (3, 'fts_trigram_tokenizer', datetime('now')); CREATE TABLE media(id TEXT PRIMARY KEY, kind TEXT NOT NULL, origin TEXT NOT NULL);`);
    expect(() => migrate(db)).toThrow();
    expect((db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = ?').get(LATEST_VERSION) as { count: number }).count).toBe(0);
    const names = (db.prepare('PRAGMA table_info(media)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).not.toContain('deleted_at');
    expect(names).not.toContain('favorite');
    expect(names).not.toContain('tags_json');
  });

  it('migration 14 promotes batchId from meta_json to an indexed batch_id column', () => {
    const db = memoryDb();
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 13)) {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, new Date().toISOString());
    }
    db.prepare(
      `INSERT INTO messages(id, conversation_id, role, created_at, updated_at, seq, status, meta_json) VALUES
       ('a1', 'main', 'assistant', datetime('now'), datetime('now'), 1, 'sending', '{"batchId":"batch-1"}'),
       ('a2', 'main', 'assistant', datetime('now'), datetime('now'), 2, 'sending', '{}'),
       ('a3', 'main', 'assistant', datetime('now'), datetime('now'), 3, 'failed', '{"batchId":"batch-1"}')`
    ).run();
    // The old JSON-expression unique index must exist before migration 14.
    expect(
      (db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='idx_messages_one_active_reply_per_batch'").get() as { c: number }).c
    ).toBe(1);

    MIGRATIONS.find((item) => item.version === 14)!.up(db);

    expect((db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((row) => row.name)).toContain('batch_id');
    expect((db.prepare("SELECT batch_id FROM messages WHERE id = 'a1'").get() as { batch_id: string | null }).batch_id).toBe('batch-1');
    expect((db.prepare("SELECT batch_id FROM messages WHERE id = 'a2'").get() as { batch_id: string | null }).batch_id).toBeNull();
    expect((db.prepare("SELECT batch_id FROM messages WHERE id = 'a3'").get() as { batch_id: string | null }).batch_id).toBe('batch-1');

    const indexColumns = (db.prepare("PRAGMA index_info('idx_messages_batch')").all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexColumns).toEqual(['batch_id']);
    // Rebuilt unique index sits on the column, not the JSON expression.
    const unique = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_messages_one_active_reply_per_batch'").get() as { sql: string }).sql;
    expect(unique).toContain('batch_id');
    expect(unique).not.toContain('json_extract');
  });
});
