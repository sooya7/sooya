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
  recoveredFrom?: 'backup';
  quarantinePath?: string;
  /**
   * Set when the file opened and holds readable data but `foreign_key_check`
   * reported violations. That is an inconsistency, not corruption: the process
   * keeps serving and only shouts about it.
   */
  inconsistent?: string;
}

/**
 * Why a database could not be used.
 *
 * `corrupt`   sqlite itself says the bytes are damaged — the only case where
 *             replacing the file is ever justified.
 * `unusable`  the file could not be opened at all: a missing native module,
 *             wrong permissions, a full disk, a locked file. The data is very
 *             probably fine and must not be touched.
 * `inconsistent` opens and reads fine, but referential integrity is off.
 */
export type DbFailureKind = 'corrupt' | 'unusable' | 'inconsistent';

/**
 * Thrown instead of destroying data. Production incident 2026-07-31: a missing
 * `better_sqlite3.node` was read as "database corrupt", the live database was
 * renamed away and replaced with an empty one, and the service happily served
 * 0 messages. Refusing to start is always the better failure.
 */
export class DatabaseUnusableError extends Error {
  readonly kind: DbFailureKind;
  readonly reason: string;
  constructor(kind: DbFailureKind, reason: string, hint: string) {
    super(`${hint} (${kind}: ${reason})`);
    this.name = 'DatabaseUnusableError';
    this.kind = kind;
    this.reason = reason;
  }
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

/**
 * Returns null when healthy, otherwise the failure reason.
 * `quick` uses PRAGMA quick_check (structure only, ~10x faster), which is the
 * right check for the startup hot path; the full integrity_check is reserved
 * for low-frequency verification (backup validation, restore). The failure
 * string keeps the `integrity_check:` prefix either way so the classifier and
 * log lines stay unchanged.
 */
export function checkIntegrity(db: Db, opts: { quick?: boolean } = {}): string | null {
  try {
    const pragma = opts.quick ? 'quick_check' : 'integrity_check';
    const rows = db.pragma(pragma) as Array<Record<string, string>>;
    const first = Object.values(rows[0] ?? {})[0];
    if (first !== 'ok') return `integrity_check: ${rows.map((r) => Object.values(r)[0]).join('; ')}`;
    const fk = db.pragma('foreign_key_check') as unknown[];
    if (fk.length > 0) return `foreign_key_check: ${fk.length} violation(s)`;
    return null;
  } catch (err) {
    return `integrity_check failed: ${(err as Error).message}`;
  }
}

/**
 * Only sqlite's own corruption verdicts count as corruption. Anything else —
 * `Could not locate the bindings file`, EACCES, ENOSPC, SQLITE_CANTOPEN,
 * SQLITE_BUSY — means "cannot open", which says nothing about the bytes.
 */
export function classifyDbError(err: unknown): DbFailureKind {
  const code = typeof (err as { code?: unknown })?.code === 'string' ? ((err as { code: string }).code) : '';
  if (code.startsWith('SQLITE_CORRUPT') || code.startsWith('SQLITE_NOTADB')) return 'corrupt';
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('disk image is malformed') || msg.includes('file is not a database')) return 'corrupt';
  return 'unusable';
}

/** Classifies the string `checkIntegrity` returns. */
export function classifyIntegrityFailure(failure: string): DbFailureKind {
  if (failure.startsWith('integrity_check:')) return 'corrupt';
  if (failure.startsWith('foreign_key_check:')) return 'inconsistent';
  return classifyDbError(new Error(failure.replace(/^integrity_check failed: /, '')));
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

/** Undo a quarantine so a failed restore leaves the original bytes in place. */
function unquarantine(file: string, target: string, log: OpenDbOptions['onLog']): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${file}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
    const src = `${target}${suffix}`;
    if (fs.existsSync(src)) {
      try {
        fs.renameSync(src, `${file}${suffix}`);
      } catch {
        /* ignore */
      }
    }
  }
  log?.('error', 'restore failed, the original database was put back', { file, target });
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
    try {
      applyPragmas(db);
      return db;
    } catch (error) {
      try { db.close(); } catch { /* preserve the original open failure */ }
      throw error;
    }
  };

  let db: Db | null = null;
  let failure: { kind: DbFailureKind; reason: string } | null = null;
  try {
    db = tryOpen();
    const integrity = checkIntegrity(db, { quick: true });
    if (integrity) failure = { kind: classifyIntegrityFailure(integrity), reason: integrity };
  } catch (err) {
    failure = { kind: classifyDbError(err), reason: (err as Error).message };
  }

  if (!failure) {
    migrate(db!);
    return { db: db!, recovered: false };
  }

  if (!autoRecover) {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    throw new DatabaseUnusableError(failure.kind, failure.reason, 'database unhealthy');
  }

  /*
   * Readable data with broken references. Replacing the file would trade a
   * fixable inconsistency for real data loss, so keep serving and be loud.
   */
  if (failure.kind === 'inconsistent') {
    onLog?.('error', 'database has referential inconsistencies; serving it as-is, NOT replacing it', {
      reason: failure.reason
    });
    migrate(db!);
    return { db: db!, recovered: false, inconsistent: failure.reason };
  }

  try {
    db?.close();
  } catch {
    /* ignore */
  }

  /*
   * "Cannot open" is not "corrupt". The native module can be missing, the file
   * can be root-owned, the disk can be full — in every one of those cases the
   * data is intact and the only safe move is to stop and say so.
   */
  if (failure.kind === 'unusable') {
    onLog?.('error', 'database could not be opened; refusing to quarantine or replace it', {
      reason: failure.reason
    });
    throw new DatabaseUnusableError(
      failure.kind,
      failure.reason,
      'refusing to start: the database could not be opened. It has been left untouched — fix the cause (native module, permissions, disk space) rather than replacing the file'
    );
  }

  // From here on sqlite itself says the bytes are damaged.
  const backup = backupDir ? latestValidBackup(backupDir) : null;
  if (!backup) {
    onLog?.('error', 'database is corrupt and no usable backup was found; refusing to replace it', {
      reason: failure.reason
    });
    throw new DatabaseUnusableError(
      failure.kind,
      failure.reason,
      'refusing to start: the database is corrupt and no restorable backup was found. The file is left in place — never serve an empty database in its stead'
    );
  }

  onLog?.('error', 'database corrupt, restoring from a verified backup', { reason: failure.reason, backup });
  const quarantinePath = quarantine(file, onLog);
  try {
    fs.copyFileSync(backup, file);
    const recoveredDb = tryOpen();
    const integrity = checkIntegrity(recoveredDb);
    if (integrity && classifyIntegrityFailure(integrity) === 'corrupt') {
      try {
        recoveredDb.close();
      } catch {
        /* ignore */
      }
      throw new Error(`restored database still corrupt: ${integrity}`);
    }
    migrate(recoveredDb);
    onLog?.('warn', 'database restored from backup', { backup });
    return {
      db: recoveredDb,
      recovered: true,
      recoveredFrom: 'backup',
      quarantinePath,
      ...(integrity ? { inconsistent: integrity } : {})
    };
  } catch (err) {
    unquarantine(file, quarantinePath, onLog);
    throw new DatabaseUnusableError(
      'corrupt',
      (err as Error).message,
      'refusing to start: restoring the verified backup failed, so the original database was put back untouched'
    );
  }
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

