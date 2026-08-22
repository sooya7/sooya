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

/**
 * v39 fixture with the exact rows migration 40 must be careful about: legacy
 * pov/selfie Moments, one referenced media row, and a proactive attempt whose
 * moment_id points at a Moment across the table rebuild.
 */
async function makeV39MomentsFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sooya-v39-moments-'));
  const file = path.join(dir, 'sooya.db');
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS.slice(0, 39)) {
    db.transaction(() => {
      migration.up(db as never);
      insert.run(migration.version, migration.name, new Date().toISOString());
    })();
  }
  db.exec(`
    INSERT INTO media(id, kind, rel_path, mime, bytes, sha256, origin, created_at)
      VALUES ('media_v39_cat', 'image', 'moments/cat.png', 'image/png', 1, 'sha-cat', 'generated', '2026-08-01T10:00:00.000Z');
    INSERT INTO moments(id, candidate_id, text, image_media_id, image_kind, activity, created_at)
      VALUES
        ('moment_v39_pov', 'cand_v39_pov', '路边的猫盯着我看了好久。', 'media_v39_cat', 'pov', '去公园看猫', '2026-08-01T10:00:00.000Z'),
        ('moment_v39_selfie', 'cand_v39_selfie', '江边的风吹得很舒服。', 'media_v39_cat', 'selfie', '在江边散步', '2026-08-01T12:00:00.000Z');
    INSERT INTO proactive_attempts(id, candidate_id, candidate_kind, candidate_activity, status, requested_mode, final_mode, send_success, moment_id, detail_json, created_at, updated_at)
      VALUES ('pa_v39_moment', 'cand_v39_pov', 'out', '去公园看猫', 'sent', 'image', 'image', 1, 'moment_v39_pov', '{}', '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z');
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

  it('migration 40 extends moments.image_kind to lifestyle while preserving legacy rows and FK references', async () => {
    const dir = await makeV39MomentsFixture();
    try {
      const opened = openDatabase({ file: path.join(dir, 'sooya.db'), backupDir: path.join(dir, 'backup'), onLog: () => {} });
      try {
        expect((opened.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(LATEST_VERSION);
        expect(LATEST_VERSION).toBeGreaterThanOrEqual(40);

        // Legacy pov rows stay readable (legacy-read-only, never deleted).
        expect((opened.db.prepare("SELECT image_kind FROM moments WHERE id = 'moment_v39_pov'").get() as { image_kind: string }).image_kind).toBe('pov');
        expect((opened.db.prepare("SELECT image_kind FROM moments WHERE id = 'moment_v39_selfie'").get() as { image_kind: string }).image_kind).toBe('selfie');

        // The rebuilt table still accepts lifestyle and still rejects unknown kinds.
        opened.db.prepare(`
          INSERT INTO moments(id, candidate_id, text, image_kind, activity, created_at)
            VALUES ('moment_v40_lifestyle', 'cand_v40_lifestyle', '蹲下来摸猫的时候它没有跑开。', 'lifestyle', '去公园看猫', '2026-08-01T14:00:00.000Z')
        `).run();
        expect(() => opened.db.prepare(`
          INSERT INTO moments(id, candidate_id, text, image_kind, activity, created_at)
            VALUES ('moment_v40_bad', 'cand_v40_bad', '...', 'scenery', '去公园看猫', '2026-08-01T15:00:00.000Z')
        `).run()).toThrow(/CHECK/i);

        // proactive_attempts.moment_id keeps pointing at the surviving Moment.
        const attempt = opened.db.prepare(`
          SELECT a.moment_id, m.id AS moment_id_resolved
          FROM proactive_attempts a JOIN moments m ON m.id = a.moment_id
          WHERE a.id = 'pa_v39_moment'
        `).get() as { moment_id: string; moment_id_resolved: string };
        expect(attempt.moment_id).toBe('moment_v39_pov');
        expect(attempt.moment_id_resolved).toBe('moment_v39_pov');

        // The recreated index exists and the rebuild left no FK violations.
        expect(opened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_moments_created'").get()).toBeTruthy();
        expect(opened.db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        opened.db.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each([18, 23, 28])('migrates a v%s fixture to latest and drops the closed systems', async (from) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `sooya-upgrade-${from}-`));
    const dbDir = path.join(dir, 'database');
    await fs.mkdir(dbDir, { recursive: true });
    const file = path.join(dbDir, 'sooya.db');
    const db = new Database(file);
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)');
    for (const migration of MIGRATIONS.slice(0, from)) {
      db.transaction(() => {
        migration.up(db as never);
        insert.run(migration.version, migration.name, new Date().toISOString());
      })();
    }
    // Seed rows that must survive (or be dropped) across the v29 cleanup.
    db.exec(`
      INSERT INTO messages(id, conversation_id, role, created_at, updated_at, seq, status, client_msg_id, reply_to, error, meta_json)
        VALUES ('msg_up_1', 'main', 'user', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 1, 'sent', NULL, NULL, NULL, '{}');
    `);
    // v19+ fixtures: seed REAL legacy location data (no key, no city_id,
    // state on an inactive location, travel to an inactive location).
    const hasLocations = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'life_locations'").get();
    if (hasLocations) {
      // v23's life_locations predates the v25 key/city_id columns; insert
      // with the shape the fixture actually has.
      const hasKey = Boolean(db.prepare("PRAGMA table_info(life_locations)").all().find((c) => (c as { name: string }).name === 'key'));
      if (hasKey) {
        db.exec(`
          INSERT INTO life_locations(id, key, name, kind, city_id, city, region, country, time_zone, lat, lng, tags_json, indoor, visit_weight, source, active, created_at, updated_at)
            VALUES ('loc_legacy_home', NULL, '家', 'home', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]', 1, 1, 'builtin', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
                   ('loc_legacy_cafe', NULL, '咖啡店', 'cafe', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]', 1, 1, 'builtin', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
                   ('loc_legacy_park', NULL, '社区公园', 'park', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]', 0, 1, 'builtin', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
                   ('loc_legacy_custom', 'custom', '外婆家的小院', 'other', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]', 0, 1, 'admin', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        `);
      } else {
        db.exec(`
          INSERT INTO life_locations(id, name, kind, city, region, country, time_zone, lat, lng, tags_json, indoor, visit_weight, source, active, created_at, updated_at)
            VALUES ('loc_legacy_home', '家', 'home', NULL, NULL, NULL, NULL, NULL, NULL, '[]', 1, 1, 'builtin', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
                   ('loc_legacy_cafe', '咖啡店', 'cafe', NULL, NULL, NULL, NULL, NULL, NULL, '[]', 1, 1, 'builtin', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
                   ('loc_legacy_park', '社区公园', 'park', NULL, NULL, NULL, NULL, NULL, NULL, '[]', 0, 1, 'builtin', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
                   ('loc_legacy_custom', '外婆家的小院', 'other', NULL, NULL, NULL, NULL, NULL, NULL, '[]', 0, 1, 'admin', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        `);
      }
      // state exists from v19, travel_state only from v25; guard both.
      const hasState = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'life_location_state'").get());
      const hasTravel = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'travel_state'").get());
      if (hasState) {
        db.exec(`
          INSERT INTO life_location_state(id, location_id, arrived_at, expected_leave_at, source_plan_id, source_activity_id, confidence, updated_at)
            VALUES (1, 'loc_legacy_park', '2026-01-01T00:00:00.000Z', NULL, NULL, NULL, 0.9, '2026-01-01T00:00:00.000Z');
        `);
      }
      if (hasTravel) {
        db.exec(`
          INSERT INTO travel_state(id, from_location_id, to_location_id, mode, started_at, expected_arrive_at, source_plan_id, source_activity_id, created_at)
            VALUES (1, 'loc_legacy_home', 'loc_legacy_park', 'walk', '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z', NULL, NULL, '2026-01-01T00:00:00.000Z');
        `);
      }
    }
    db.close();

    try {
      const opened = openDatabase({ file, backupDir: path.join(dir, 'backup'), onLog: () => {} });
      try {
        const version = (opened.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
        expect(version).toBe(LATEST_VERSION);
        // Messages survive.
        const msg = opened.db.prepare("SELECT * FROM messages WHERE id = 'msg_up_1'").get() as { role: string };
        expect(msg.role).toBe('user');
        // v29 cleanup: closed systems' tables are gone, retained ones exist.
        for (const gone of ['experiments', 'experiment_assignments', 'experiment_events', 'shadow_runs', 'decision_traces']) {
          const row = opened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(gone);
          expect(row, `${gone} should be dropped by v29`).toBeUndefined();
        }
        for (const kept of ['visible_thoughts', 'life_cities', 'travel_state', 'weather_forecasts', 'metric_distributions', 'messages', 'memories']) {
          const row = opened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(kept);
          expect(row, `${kept} should be retained`).toBeTruthy();
        }
        expect(opened.db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        opened.db.close();
      }

      // v19+ fixtures: boot the app on the migrated DB and verify the legacy
      // location normalization (Ningbo only when no city exists, key
      // backfill, city binding, state/travel repair).
      if (from >= 19) {
        const { createHarness } = await import('./helpers/harness.js');
        const booted = await createHarness({
          skipStickerImport: true,
          startWorkers: false,
          env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', DATA_DIR: dir }
        });
        try {
          const service = booted.app.services.location;
          expect(service.activeCity()?.name).toBe('宁波');
          const locations = service.list();
          const home = locations.find((l) => l.name === '家')!;
          const cafe = locations.find((l) => l.name === '咖啡店')!;
          const custom = locations.find((l) => l.name === '外婆家的小院')!;
          // Recognizable legacy builtins get stable keys; admin locations are
          // never guessed (v23 had no key column at all, so NULL there).
          expect(home.key).toBe('home');
          expect(cafe.key).toBe('cafe');
          if (from >= 25) expect(custom.key).toBe('custom');
          else expect(custom.key).toBeNull();
          // Legacy builtins bind to the active city.
          expect(home.cityId).toBe(service.activeCity()!.id);
          expect(cafe.cityId).toBe(service.activeCity()!.id);
          if (from >= 25) {
            // State pointed at the inactive park -> repaired to home.
            expect(service.current()?.key).toBe('home');
            // Travel referencing the inactive park -> cleared.
            expect(service.currentTravel()).toBeNull();
          }
        } finally {
          await booted.cleanup();
        }
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
