import type { DbLike } from '../handle.js';
import { nowIso } from '../../util/ids.js';

export type OutcomeMediaKind = 'none' | 'image' | 'sticker' | 'voice';

export interface InteractionOutcomeRow {
  id: string;
  source_type: string;
  source_id: string;
  proactive_kind: string;
  media_kind: OutcomeMediaKind;
  sent_at: string;
  user_replied: number;
  reply_latency_ms: number | null;
  reply_length: number | null;
  continued_turns: number;
  score: number;
  created_at: string;
}

export class InteractionOutcomeRepo {
  constructor(private readonly db: DbLike) {}

  insert(input: Omit<InteractionOutcomeRow, 'id' | 'created_at'>): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO interaction_outcomes
            (id, source_type, source_id, proactive_kind, media_kind, sent_at, user_replied,
             reply_latency_ms, reply_length, continued_turns, score, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          `out_${Math.random().toString(36).slice(2, 12)}`,
          input.source_type,
          input.source_id,
          input.proactive_kind,
          input.media_kind,
          input.sent_at,
          input.user_replied,
          input.reply_latency_ms,
          input.reply_length,
          input.continued_turns,
          input.score,
          nowIso()
        ).changes > 0
    );
  }

  has(sourceId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM interaction_outcomes WHERE source_id = ?').get(sourceId));
  }

  recent(since: string): InteractionOutcomeRow[] {
    return this.db
      .prepare('SELECT * FROM interaction_outcomes WHERE sent_at >= ? ORDER BY sent_at DESC LIMIT 500')
      .all(since) as InteractionOutcomeRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM interaction_outcomes').get() as { c: number }).c;
  }

  reset(): number {
    return this.db.prepare('DELETE FROM interaction_outcomes').run().changes;
  }
}
