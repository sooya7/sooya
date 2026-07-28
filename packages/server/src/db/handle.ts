import type BetterSqlite3 from 'better-sqlite3';
import type { Db } from './index.js';

type PrepareFn = Db['prepare'];
type ExecFn = Db['exec'];
type PragmaFn = Db['pragma'];
type TransactionFn = Db['transaction'];

/**
 * Indirection layer over the SQLite connection.
 *
 * Repositories and services capture a `DbHandle` instead of a raw connection,
 * so operations that must replace the underlying file (backup restore,
 * corruption recovery) can swap the connection without leaving any component
 * pointing at a closed handle.
 */
export class DbHandle {
  private current: Db;

  readonly prepare: PrepareFn;
  readonly exec: ExecFn;
  readonly pragma: PragmaFn;
  readonly transaction: TransactionFn;

  constructor(initial: Db) {
    this.current = initial;
    // Bound as arrow functions that resolve `this.current` at call time, so the
    // exact better-sqlite3 signatures are preserved for callers.
    this.prepare = ((sql: string) => this.current.prepare(sql)) as PrepareFn;
    this.exec = ((sql: string) => this.current.exec(sql)) as ExecFn;
    this.pragma = ((source: string, options?: BetterSqlite3.PragmaOptions) =>
      this.current.pragma(source, options as never)) as PragmaFn;
    this.transaction = ((fn: (...args: unknown[]) => unknown) => {
      const wrapped = (...args: unknown[]) => this.current.transaction(fn)(...args);
      return wrapped;
    }) as unknown as TransactionFn;
  }

  /** The live connection. Use only where a real Database instance is required. */
  get raw(): Db {
    return this.current;
  }

  swap(next: Db): Db {
    const previous = this.current;
    this.current = next;
    return previous;
  }

  backup(destination: string, options?: BetterSqlite3.BackupOptions): Promise<BetterSqlite3.BackupMetadata> {
    return this.current.backup(destination, options);
  }

  get open(): boolean {
    return this.current.open;
  }
}

/** Everything the repositories need; satisfied by both DbHandle and Database. */
export type DbLike = Pick<Db, 'prepare' | 'exec' | 'pragma' | 'transaction'>;
