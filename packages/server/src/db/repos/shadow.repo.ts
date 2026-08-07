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

export type ExperimentStatus = 'draft' | 'shadow' | 'running' | 'paused' | 'completed' | 'cancelled';
export type AssignmentScope = 'day' | 'session' | 'conversation';

export interface ExperimentRow {
  id: string;
  name: string;
  subsystem: string;
  variants_json: string;
  status: ExperimentStatus;
  assignment_scope: AssignmentScope;
  created_at: string;
  updated_at: string;
}

export interface ExperimentAssignmentRow {
  experiment_id: string;
  scope_key: string;
  variant: string;
  assigned_at: string;
}

export interface ExperimentEventRow {
  id: string;
  experiment_id: string;
  variant: string;
  event: string;
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

export class ExperimentRepo {
  constructor(private readonly db: DbLike) {}

  create(input: { name: string; subsystem: string; variants: string[]; assignmentScope?: AssignmentScope }): ExperimentRow {
    const ts = nowIso();
    const row: ExperimentRow = {
      id: sortableId('exp'),
      name: input.name,
      subsystem: input.subsystem,
      variants_json: JSON.stringify(input.variants),
      status: 'draft',
      assignment_scope: input.assignmentScope ?? 'day',
      created_at: ts,
      updated_at: ts
    };
    this.db.prepare(`
      INSERT INTO experiments(id, name, subsystem, variants_json, status, assignment_scope, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(row.id, row.name, row.subsystem, row.variants_json, row.status, row.assignment_scope, row.created_at, row.updated_at);
    return row;
  }

  get(id: string): ExperimentRow | undefined {
    return this.db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as ExperimentRow | undefined;
  }

  list(): ExperimentRow[] {
    return this.db.prepare('SELECT * FROM experiments ORDER BY created_at DESC').all() as ExperimentRow[];
  }

  setStatus(id: string, status: ExperimentStatus): ExperimentRow | undefined {
    this.db.prepare('UPDATE experiments SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
    return this.get(id);
  }

  variants(row: ExperimentRow): string[] {
    try { return JSON.parse(row.variants_json) as string[]; } catch { return []; }
  }

  /** Day/session/conversation-sticky assignment: once assigned, never flips. */
  variantFor(id: string, scopeKey: string, variants: string[]): string {
    const existing = this.db.prepare('SELECT variant FROM experiment_assignments WHERE experiment_id = ? AND scope_key = ?')
      .get(id, scopeKey) as { variant: string } | undefined;
    if (existing) return existing.variant;
    if (variants.length === 0) return 'control';
    let hash = 0;
    for (let i = 0; i < scopeKey.length; i++) hash = (hash * 31 + scopeKey.charCodeAt(i)) >>> 0;
    const variant = variants[hash % variants.length]!;
    this.db.prepare(`
      INSERT INTO experiment_assignments(experiment_id, scope_key, variant, assigned_at) VALUES (?,?,?,?)
    `).run(id, scopeKey, variant, nowIso());
    return variant;
  }

  recordEvent(experimentId: string, variant: string, event: string): void {
    this.db.prepare(`
      INSERT INTO experiment_events(id, experiment_id, variant, event, created_at) VALUES (?,?,?,?,?)
    `).run(sortableId('expev'), experimentId, variant, event, nowIso());
  }

  events(experimentId: string, limit = 100): ExperimentEventRow[] {
    return this.db.prepare(
      'SELECT * FROM experiment_events WHERE experiment_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(experimentId, Math.max(1, Math.min(200, limit))) as ExperimentEventRow[];
  }
}
