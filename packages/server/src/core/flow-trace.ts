import type { FlowTraceRepo, FlowTraceKind, FlowTraceRow, FlowTraceStatus, FlowStageStatus } from '../db/repos/flow-trace.repo.js';

export interface FlowTraceServiceOptions {
  keep?: number;
}

/** Privacy-safe, bounded lifecycle traces for user replies and proactive runs. */
export class FlowTraceService {
  constructor(private readonly repo: FlowTraceRepo, private readonly opts: FlowTraceServiceOptions = {}) {}

  start(kind: FlowTraceKind, sourceId: string | null, stage: string, detail?: Record<string, unknown>): FlowTraceRow {
    const trace = this.repo.create({ kind, sourceId, stage, detail: sanitizeDetail(detail) });
    this.repo.prune(this.opts.keep ?? 2000);
    return trace;
  }

  stage(traceId: string | null | undefined, name: string, status: FlowStageStatus = 'running', detail?: Record<string, unknown>): FlowTraceRow | undefined {
    if (!traceId) return undefined;
    return this.repo.appendStage(traceId, {
      name,
      status,
      ...(status !== 'running' ? { completedAt: new Date().toISOString() } : {}),
      ...(detail ? { detail: sanitizeDetail(detail) } : {})
    });
  }

  finish(traceId: string | null | undefined, status: Exclude<FlowTraceStatus, 'running'>, detail?: Record<string, unknown>): FlowTraceRow | undefined {
    if (!traceId) return undefined;
    return this.repo.finish(traceId, status, sanitizeDetail(detail));
  }

  fail(traceId: string | null | undefined, stage: string, error?: unknown): void {
    this.stage(traceId, stage, 'failed', { error: safeError(error) });
    this.finish(traceId, 'failed', { error: safeError(error) });
  }

  block(traceId: string | null | undefined, stage: string, reason?: string): void {
    this.stage(traceId, stage, 'blocked', reason ? { reason } : undefined);
    this.finish(traceId, 'blocked', reason ? { reason } : undefined);
  }

  cancel(traceId: string | null | undefined, stage = 'cancelled', reason?: string): void {
    this.stage(traceId, stage, 'cancelled', reason ? { reason } : undefined);
    this.finish(traceId, 'cancelled', reason ? { reason } : undefined);
  }

  get(traceId: string): FlowTraceRow | undefined { return this.repo.get(traceId); }
  recent(limit = 50): FlowTraceRow[] { return this.repo.recent(limit); }
  findBySource(kind: FlowTraceKind, sourceId: string): FlowTraceRow | undefined { return this.repo.findBySource(kind, sourceId); }
}

function sanitizeDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail).slice(0, 20)) {
    if (/token|secret|authorization|prompt|content|text/i.test(key)) continue;
    if (typeof value === 'string') output[key] = value.slice(0, 200);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) output[key] = value;
  }
  return output;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? 'unknown error')).slice(0, 240);
}
