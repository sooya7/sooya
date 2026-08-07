import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

export type VoiceGenerationStatus =
  | 'planned'
  | 'scripted'
  | 'synthesizing'
  | 'published'
  | 'superseded'
  | 'failed'
  | 'cancelled';

export interface VoiceGenerationRow {
  id: string;
  batch_id: string | null;
  revision: number;
  message_id: string | null;
  text_part_id: string | null;
  mode: string;
  requested_by: string;
  status: VoiceGenerationStatus;
  spoken_text: string;
  synthesis_text: string;
  delivery_json: string;
  naturalness_json: string;
  provider: string | null;
  retry_count: number;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  failure_code: string | null;
  media_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface VoiceGenerationInput {
  batchId?: string | null;
  revision?: number;
  mode: string;
  requestedBy: string;
  status?: VoiceGenerationStatus;
  spokenText: string;
  synthesisText: string;
  delivery?: Record<string, unknown>;
  naturalness?: Record<string, unknown>;
  provider?: string | null;
  messageId?: string | null;
  textPartId?: string | null;
}

export class VoiceGenerationRepo {
  constructor(private readonly db: DbLike) {}

  create(input: VoiceGenerationInput): VoiceGenerationRow {
    const ts = nowIso();
    const row: VoiceGenerationRow = {
      id: sortableId('vg'),
      batch_id: input.batchId ?? null,
      revision: input.revision ?? 0,
      message_id: input.messageId ?? null,
      text_part_id: input.textPartId ?? null,
      mode: input.mode,
      requested_by: input.requestedBy,
      status: input.status ?? 'planned',
      spoken_text: input.spokenText,
      synthesis_text: input.synthesisText,
      delivery_json: JSON.stringify(input.delivery ?? {}),
      naturalness_json: JSON.stringify(input.naturalness ?? {}),
      provider: input.provider ?? null,
      retry_count: 0,
      started_at: null,
      completed_at: null,
      failed_at: null,
      failure_code: null,
      media_id: null,
      created_at: ts,
      updated_at: ts
    };
    this.db.prepare(
      `INSERT INTO voice_generations(
        id, batch_id, revision, message_id, text_part_id, mode, requested_by,
        status, spoken_text, synthesis_text, delivery_json, naturalness_json,
        provider, retry_count, started_at, completed_at, failed_at, failure_code,
        media_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,NULL,NULL,NULL,NULL,?,?)`
    ).run(
      row.id, row.batch_id, row.revision, row.message_id, row.text_part_id, row.mode,
      row.requested_by, row.status, row.spoken_text, row.synthesis_text,
      row.delivery_json, row.naturalness_json, row.provider, ts, ts
    );
    return row;
  }

  get(id: string): VoiceGenerationRow | undefined {
    return this.db.prepare('SELECT * FROM voice_generations WHERE id = ?').get(id) as VoiceGenerationRow | undefined;
  }

  update(id: string, patch: Partial<Pick<VoiceGenerationRow, 'status' | 'spoken_text' | 'synthesis_text' | 'delivery_json' | 'naturalness_json' | 'provider' | 'retry_count' | 'started_at' | 'completed_at' | 'failed_at' | 'failure_code' | 'media_id' | 'message_id' | 'text_part_id'>>): void {
    const current = this.get(id);
    if (!current) return;
    const next = { ...current, ...patch, updated_at: nowIso() };
    this.db.prepare(`
      UPDATE voice_generations SET
        status=?, spoken_text=?, synthesis_text=?, delivery_json=?, naturalness_json=?,
        provider=?, retry_count=?, started_at=?, completed_at=?, failed_at=?,
        failure_code=?, media_id=?, message_id=?, text_part_id=?, updated_at=?
      WHERE id=?
    `).run(
      next.status, next.spoken_text, next.synthesis_text, next.delivery_json,
      next.naturalness_json, next.provider, next.retry_count, next.started_at,
      next.completed_at, next.failed_at, next.failure_code, next.media_id,
      next.message_id, next.text_part_id, next.updated_at, id
    );
  }

  latestForMessage(messageId: string): VoiceGenerationRow | undefined {
    return this.db.prepare(
      'SELECT * FROM voice_generations WHERE message_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(messageId) as VoiceGenerationRow | undefined;
  }

  /** Rows still in flight after a restart lost their connection. */
  recoverInFlight(): void {
    this.db.prepare(
      `UPDATE voice_generations
       SET status = 'failed', failure_code = 'interrupted_by_restart', failed_at = ?, updated_at = ?
       WHERE status IN ('planned','scripted','synthesizing')`
    ).run(nowIso(), nowIso());
  }

  /** Recent published/attempted auto voices, for frequency control. */
  countAutoSince(sinceIso: string): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM voice_generations
       WHERE requested_by = 'auto' AND created_at >= ? AND status IN ('published','synthesizing','scripted','planned')`
    ).get(sinceIso) as { n: number }).n;
  }

  list(limit = 50): VoiceGenerationRow[] {
    return this.db.prepare('SELECT * FROM voice_generations ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit))) as VoiceGenerationRow[];
  }
}
