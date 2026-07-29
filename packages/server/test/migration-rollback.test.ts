import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/index.js';
import { LATEST_VERSION, MIGRATIONS } from '../src/db/migrations.js';

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
});

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  open.push(db);
  return db;
}

describe('database migrations and transactional rollback', () => {
  it('migrates a clean database to the latest schema with 1-9 feature tables', () => {
    const db = memoryDb();
    expect(migrate(db)).toBe(LATEST_VERSION);
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    expect(versions.map((row) => row.version)).toEqual(Array.from({ length: LATEST_VERSION }, (_, index) => index + 1));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((row) => row.name));
    for (const required of ['push_subscriptions', 'world_entries', 'world_sources', 'audit_log', 'storage_samples']) expect(names.has(required)).toBe(true);
    const mediaColumns = db.prepare('PRAGMA table_info(media)').all() as Array<{ name: string }>;
    expect(mediaColumns.map((row) => row.name)).toEqual(expect.arrayContaining(['deleted_at', 'favorite', 'tags_json']));
  });

  it('rolls back every statement in a failed migration and does not record its version', () => {
    const db = memoryDb();
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, name, applied_at) VALUES
        (1, 'initial_schema', datetime('now')), (2, 'error_log', datetime('now')), (3, 'fts_trigram_tokenizer', datetime('now'));
      CREATE TABLE media(id TEXT PRIMARY KEY, kind TEXT NOT NULL, origin TEXT NOT NULL);
    `);

    expect(() => migrate(db)).toThrow();
    const latest = db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version = ?').get(LATEST_VERSION) as { count: number };
    expect(latest.count).toBe(0);
    const mediaColumns = db.prepare('PRAGMA table_info(media)').all() as Array<{ name: string }>;
    const names = mediaColumns.map((row) => row.name);
    expect(names).not.toContain('deleted_at');
    expect(names).not.toContain('favorite');
    expect(names).not.toContain('tags_json');
  });

  it('backfills stable world keys and resolves pre-existing active Unicode duplicates', () => {
    const db = memoryDb();
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 4)) {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version, migration.name, new Date().toISOString()
      );
    }
    const insert = db.prepare(`
      INSERT INTO world_entries(
        id, kind, subject, predicate, object, confidence, authority,
        active, conflict_of, created_at, updated_at
      ) VALUES (?, 'fact', ?, ?, 'same', ?, ?, 1, NULL, ?, ?)
    `);
    insert.run('older', 'Straße角色', 'IST伙伴', 0.7, 'model', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    insert.run('winner', 'STRAẞE角色', 'ist伙伴', 0.9, 'user', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

    expect(migrate(db)).toBe(LATEST_VERSION);
    const rows = db.prepare('SELECT id, subject_key, predicate_key, active, conflict_of FROM world_entries ORDER BY id').all() as Array<{
      id: string; subject_key: string; predicate_key: string; active: number; conflict_of: string | null;
    }>;
    expect(rows).toEqual([
      { id: 'older', subject_key: 'straße角色', predicate_key: 'ist伙伴', active: 0, conflict_of: 'winner' },
      { id: 'winner', subject_key: 'straße角色', predicate_key: 'ist伙伴', active: 1, conflict_of: null }
    ]);
    expect(() => db.prepare(`
      INSERT INTO world_entries(
        id, kind, subject, subject_key, predicate, predicate_key, object,
        confidence, authority, active, conflict_of, created_at, updated_at
      ) VALUES ('duplicate', 'fact', 'x', 'straße角色', 'y', 'ist伙伴', 'z', 1, 'admin', 1, NULL, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString())).toThrow();
  });
});
