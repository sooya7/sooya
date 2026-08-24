import type { DbLike } from '../handle.js';
import { nowIso, randomId } from '../../util/ids.js';

export type FlowTraceKind = 'user_reply' | 'proactive';
export type FlowTraceStatus = 'running' | 'ok' | 'failed' | 'blocked' | 'cancelled';
export type FlowStageStatus = FlowTraceStatus;

export interface FlowTraceStage {
  name: string;
  startedAt: string;
  completedAt?: string;
  status: FlowStageStatus;
  detail?: Record<string, unknown>;
}

export interface FlowTraceRow {
  traceId: string;
  kind: FlowTraceKind;
  sourceId: string | null;
  status: FlowTraceStatus;
  currentStage: string | null;
  stages: FlowTraceStage[];
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface FlowTraceDbRow {
  trace_id: string;
  kind: FlowTraceKind;
  source_id: string | null;
  status: FlowTraceStatus;
  current_stage: string | null;
  stages_json: string;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

export class FlowTraceRepo {
  constructor(private readonly db: DbLike) {}

  create(input: { kind: FlowTraceKind; sourceId?: string | null; stage: string; detail?: Record<string, unknown> }): FlowTraceRow {
    const traceId = `flow_${randomId(16)}`;
    const ts = nowIso();
    const stages: FlowTraceStage[] = [{ name: input.stage, startedAt: ts, status: 'running', detail: input.detail }];
    this.db.prepare(
      `INSERT INTO flow_traces(trace_id, kind, source_id, status, current_stage, stages_json, started_at, updated_at, completed_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?, NULL)`
    ).run(traceId, input.kind, input.sourceId ?? null, input.stage, JSON.stringify(stages), ts, ts);
    return this.get(traceId)!;
  }

  get(traceId: string): FlowTraceRow | undefined {
    const row = this.db.prepare('SELECT * FROM flow_traces WHERE trace_id = ?').get(traceId) as FlowTraceDbRow | undefined;
    return row ? this.map(row) : undefined;
  }

  appendStage(traceId: string, stage: Omit<FlowTraceStage, 'startedAt'> & { startedAt?: string }): FlowTraceRow | undefined {
    const current = this.get(traceId);
    if (!current) return undefined;
    const ts = nowIso();
    const next: FlowTraceStage = {
      name: stage.name,
      startedAt: stage.startedAt ?? ts,
      ...(stage.completedAt ? { completedAt: stage.completedAt } : {}),
      status: stage.status,
      ...(stage.detail ? { detail: stage.detail } : {})
    };
    const stages = [...current.stages, next].slice(-80);
    this.db.prepare(
      `UPDATE flow_traces SET status = 'running', current_stage = ?, stages_json = ?, updated_at = ?, completed_at = NULL WHERE trace_id = ?`
    ).run(next.name, JSON.stringify(stages), ts, traceId);
    return this.get(traceId);
  }

  finish(traceId: string, status: Exclude<FlowTraceStatus, 'running'>, detail?: Record<string, unknown>): FlowTraceRow | undefined {
    const current = this.get(traceId);
    if (!current) return undefined;
    const ts = nowIso();
    const stages = detail
      ? [...current.stages, { name: 'flow.completed', startedAt: ts, completedAt: ts, status, detail }].slice(-80)
      : current.stages;
    this.db.prepare(
      `UPDATE flow_traces SET status = ?, current_stage = ?, stages_json = ?, updated_at = ?, completed_at = ? WHERE trace_id = ?`
    ).run(status, current.currentStage, JSON.stringify(stages), ts, ts, traceId);
    return this.get(traceId);
  }

  recent(limit = 50): FlowTraceRow[] {
    const rows = this.db.prepare('SELECT * FROM flow_traces ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit))) as FlowTraceDbRow[];
    return rows.map((row) => this.map(row));
  }

  findBySource(kind: FlowTraceKind, sourceId: string): FlowTraceRow | undefined {
    const row = this.db.prepare('SELECT * FROM flow_traces WHERE kind = ? AND source_id = ? ORDER BY started_at DESC LIMIT 1').get(kind, sourceId) as FlowTraceDbRow | undefined;
    return row ? this.map(row) : undefined;
  }

  prune(keep = 2000): number {
    return this.db.prepare(
      'DELETE FROM flow_traces WHERE trace_id NOT IN (SELECT trace_id FROM flow_traces ORDER BY updated_at DESC LIMIT ?)'
    ).run(Math.max(100, Math.min(10_000, keep))).changes;
  }

  private map(row: FlowTraceDbRow): FlowTraceRow {
    let stages: FlowTraceStage[] = [];
    try {
      const parsed = JSON.parse(row.stages_json) as unknown;
      if (Array.isArray(parsed)) stages = parsed as FlowTraceStage[];
    } catch {
      stages = [];
    }
    return {
      traceId: row.trace_id,
      kind: row.kind,
      sourceId: row.source_id,
      status: row.status,
      currentStage: row.current_stage,
      stages,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at
    };
  }
}
