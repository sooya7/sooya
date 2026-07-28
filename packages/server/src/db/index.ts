import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { MIGRATIONS, LATEST_VERSION } from './migrations.js';
import { ensureDirSync } from '../util/fsx.js';

export type Db = BetterSqlite3.Database;

export interface OpenDbResult {
  db: Db;
  /** True when a corrupted database was quarantined and replaced. */
  recovered: boolean;
  recoveredFrom?: 'backup' | 'fresh';
  quarantinePath?: string;
}

export interface OpenDbOptions {
  file: string;
  backupDir?: string;
  /** Set false in unit tests that intentionally poke at broken files. */
  autoRecover?: boolean;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

function applyPragmas(db: Db): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 8000');
  db.pragma('temp_store = MEMORY');
}

/** Returns null when healthy, otherwise the failure reason. */
export function checkIntegrity(db: Db): string | null {
  try {
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const first = rows[0]?.integrity_check;
    if (first !== 'ok') return `integrity_check: ${rows.map((r) => r.integrity_check).join('; ')}`;
    const fk = db.pragma('foreign_key_check') as unknown[];
    if (fk.length > 0) return `foreign_key_check: ${fk.length} violation(s)`;
    return null;
  } catch (err) {
    return `integrity_check failed: ${(err as Error).message}`;
  }
}

export function migrate(db: Db): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version)
  );
  const insert = db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const run = db.transaction(() => {
      m.up(db);
      insert.run(m.version, m.name, new Date().toISOString());
    });
    run();
  }
  return LATEST_VERSION;
}

function quarantine(file: string, log: OpenDbOptions['onLog']): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.corrupt-${stamp}`;
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${file}${suffix}`;
    if (fs.existsSync(src)) {
      try {
        fs.renameSync(src, `${target}${suffix}`);
      } catch {
        try {
          fs.rmSync(src, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }
  log?.('error', 'database quarantined', { file, target });
  return target;
}

function latestValidBackup(backupDir: string): string | null {
  if (!fs.existsSync(backupDir)) return null;
  const candidates = fs
    .readdirSync(backupDir)
    .filter((n) => n.endsWith('.db') || n.endsWith('.sqlite'))
    .map((n) => ({ n, full: path.join(backupDir, n) }))
    .sort((a, b) => fs.statSync(b.full).mtimeMs - fs.statSync(a.full).mtimeMs);
  for (const c of candidates) {
    let probe: Db | null = null;
    try {
      probe = new Database(c.full, { readonly: true, fileMustExist: true });
      if (checkIntegrity(probe) === null) {
        probe.close();
        return c.full;
      }
    } catch {
      /* try next */
    } finally {
      try {
        probe?.close();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function openDatabase(opts: OpenDbOptions): OpenDbResult {
  const { file, backupDir, autoRecover = true, onLog } = opts;
  ensureDirSync(path.dirname(file));

  const tryOpen = (): Db => {
    const db = new Database(file);
    applyPragmas(db);
    return db;
  };

  let db: Db | null = null;
  let failure: string | null = null;
  try {
    db = tryOpen();
    failure = checkIntegrity(db);
  } catch (err) {
    failure = (err as Error).message;
  }

  if (failure && autoRecover) {
    onLog?.('error', 'database unhealthy, starting recovery', { reason: failure });
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    const quarantinePath = quarantine(file, onLog);
    const backup = backupDir ? latestValidBackup(backupDir) : null;
    let recoveredFrom: 'backup' | 'fresh' = 'fresh';
    if (backup) {
      fs.copyFileSync(backup, file);
      recoveredFrom = 'backup';
      onLog?.('warn', 'database restored from backup', { backup });
    } else {
      onLog?.('warn', 'no valid backup found, starting with a fresh database');
    }
    let recoveredDb: Db;
    try {
      recoveredDb = tryOpen();
      if (checkIntegrity(recoveredDb) !== null) throw new Error('restored database still corrupt');
    } catch (err) {
      // Backup itself was unusable: fall back to fresh.
      try {
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}-wal`, { force: true });
        fs.rmSync(`${file}-shm`, { force: true });
      } catch {
        /* ignore */
      }
      onLog?.('error', 'restore failed, creating fresh database', { error: (err as Error).message });
      recoveredDb = tryOpen();
      recoveredFrom = 'fresh';
    }
    migrate(recoveredDb);
    return { db: recoveredDb, recovered: true, recoveredFrom, quarantinePath };
  }

  if (failure) throw new Error(`database unhealthy: ${failure}`);
  migrate(db!);
  return { db: db!, recovered: false };
}

export function closeDatabase(db: Db): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* ignore */
  }
  try {
    db.close();
  } catch {
    /* ignore */
  }
}

/**
 * Force a counter to at least `floor`.
 *
 * Restoring an older snapshot rewinds both the rows and the counters. A client
 * that is still connected holds sequence numbers from *before* the restore, so
 * if the counters restarted from a lower value the server would re-issue ids
 * the client has already seen: its `Last-Event-ID` would sit permanently ahead
 * of the stream and it would never receive another event. Raising the counters
 * keeps sequence numbers globally monotonic across a restore.
 */
export function raiseCounter(db: Pick<Db, 'prepare'>, name: 'message_seq' | 'event_seq', floor: number): number {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as { value: number } | undefined;
  const current = row?.value ?? 0;
  if (current >= floor) return current;
  db.prepare('UPDATE counters SET value = ? WHERE name = ?').run(floor, name);
  return floor;
}

/**
 * Make sure the counters cover the data actually present, then lift them to the
 * supplied floors. Returns the resulting values.
 */
export function reconcileCounters(
  db: Pick<Db, 'prepare'>,
  floors: { messageSeq?: number; eventSeq?: number } = {}
): { messageSeq: number; eventSeq: number } {
  const maxMessage = (db.prepare('SELECT COALESCE(MAX(seq), 0) s FROM messages').get() as { s: number }).s;
  const maxEvent = (db.prepare('SELECT COALESCE(MAX(seq), 0) s FROM events').get() as { s: number }).s;
  return {
    messageSeq: raiseCounter(db, 'message_seq', Math.max(maxMessage, floors.messageSeq ?? 0)),
    eventSeq: raiseCounter(db, 'event_seq', Math.max(maxEvent, floors.eventSeq ?? 0))
  };
}

/** Atomic counter used for message/event sequence numbers. */
export function nextSeq(db: Pick<Db, 'prepare'>, name: 'message_seq' | 'event_seq'): number {
  const stmt = db.prepare('UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value');
  const row = stmt.get(name) as { value: number } | undefined;
  if (!row) throw new Error(`counter ${name} missing`);
  return row.value;
}
