import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

export interface ShadowRunRow {
  id: string;
  subsystem: string;
  canonical_version: string;
  shadow_version: string;
  input_fingerprint: string;
  canonical_decision: string;
  shadow_decision: string;
  diff_json: string;
  duration_ms: number;
  created_at: string;
}

export class ShadowRepo {
  constructor(private readonly db: DbLike) {}

  recordRun(input: Omit<ShadowRunRow, 'id' | 'created_at'>): ShadowRunRow {
    const row: ShadowRunRow = { ...input, id: sortableId('shadow'), created_at: nowIso() };
    this.db.prepare(`
      INSERT INTO shadow_runs(id, subsystem, canonical_version, shadow_version, input_fingerprint, canonical_decision, shadow_decision, diff_json, duration_ms, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(row.id, row.subsystem, row.canonical_version, row.shadow_version, row.input_fingerprint, row.canonical_decision, row.shadow_decision, row.diff_json, row.duration_ms, row.created_at);
    return row;
  }

  list(subsystem?: string, limit = 100): ShadowRunRow[] {
    if (subsystem) {
      return this.db.prepare('SELECT * FROM shadow_runs WHERE subsystem = ? ORDER BY created_at DESC LIMIT ?').all(subsystem, Math.max(1, Math.min(200, limit))) as ShadowRunRow[];
    }
    return this.db.prepare('SELECT * FROM shadow_runs ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit))) as ShadowRunRow[];
  }
}
