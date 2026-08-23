import type { InteractionOutcomeRepo, OutcomeMediaKind } from '../../db/repos/interaction-outcome.repo.js';
import type { ProactiveAttemptRepo } from '../../db/repos/proactive.repo.js';
import type { MessageRepo } from '../../db/repos/message.repo.js';

const WINDOW_DAYS = 14;
const MIN_SAMPLES = 30;
const WEIGHT_MIN = 0.7;
const WEIGHT_MAX = 1.3;

export interface KindStat {
  kind: string;
  samples: number;
  replyRate: number;
  avgTurns: number;
  weight: number;
}

export interface LearningProfile {
  stats: KindStat[];
  windowDays: number;
  minSamples: number;
}

/**
 * Interaction Feedback Learner (§22-26): learns only how to interact, never
 * who to be. Rolling statistics over proactive outcomes; weights are clamped
 * to [0.7, 1.3] and only ever multiply a candidate's score AFTER the hard
 * gates — a bad streak can soften a behaviour, never silence it.
 */
export class FeedbackService {
  constructor(
    private readonly deps: {
      outcomes: InteractionOutcomeRepo;
      attempts: ProactiveAttemptRepo;
      messages: MessageRepo;
      learningEnabled: boolean;
      clock?: () => Date;
    }
  ) {}

  /**
   * Derive outcomes from sent proactive attempts and the user's replies.
   * Recorded regardless of the flag (data accrues); only weight application
   * is gated.
   */
  sweep(now: Date = this.deps.clock?.() ?? new Date()): { recorded: number } {
    let recorded = 0;
    const sentAttempts = this.deps.attempts
      .list(50)
      .filter((attempt) => attempt.status === 'sent' && attempt.sendSuccess)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const attempt of sentAttempts) {
      if (this.deps.outcomes.has(attempt.id)) continue;
      const sentAt = attempt.createdAt;
      const sentMs = Date.parse(sentAt);
      if (!Number.isFinite(sentMs)) continue;
      const kind = attempt.candidateId?.startsWith('commitment:') ? 'commitment' : 'life';
      const mediaKind: OutcomeMediaKind = attempt.finalMode === 'image' ? 'image' : 'none';

      // A user reply belongs to the LATEST proactive before it: the window
      // ends at the next proactive send, capped at 48h.
      const nextSend = sentAttempts.find((other) => Date.parse(other.createdAt) > sentMs);
      const windowEnd = Math.min(sentMs + 48 * 3_600_000, nextSend ? Date.parse(nextSend.createdAt) : Infinity);
      const replies = this.deps.messages
        .recent(60)
        .filter((m) => m.role === 'user' && Date.parse(m.createdAt) > sentMs && Date.parse(m.createdAt) < windowEnd)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const first = replies[0];
      const latency = first ? Date.parse(first.createdAt) - sentMs : null;
      const length = first ? first.content.reduce((n, p) => n + (p.type === 'text' ? (p.text ?? '').length : 0), 0) : null;
      const continuedTurns = replies.length;
      const score = first ? 1 + Math.min(continuedTurns, 3) * 0.25 : 0;
      const ok = this.deps.outcomes.insert({
        source_type: 'proactive',
        source_id: attempt.id,
        proactive_kind: kind,
        media_kind: mediaKind,
        sent_at: sentAt,
        user_replied: first ? 1 : 0,
        reply_latency_ms: latency,
        reply_length: length,
        continued_turns: continuedTurns,
        score
      });
      if (ok) recorded++;
    }
    return { recorded };
  }

  /** §23/§25: rolling window per proactive kind; weights bounded by clamp. */
  profile(now: Date = this.deps.clock?.() ?? new Date()): LearningProfile {
    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    const rows = this.deps.outcomes.recent(since);
    const byKind = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byKind.get(row.proactive_kind) ?? [];
      list.push(row);
      byKind.set(row.proactive_kind, list);
    }
    const stats: KindStat[] = [];
    for (const [kind, list] of byKind) {
      // The window is 14 days OR the last 30 samples, whichever is smaller.
      const window = list.slice(0, MIN_SAMPLES);
      const replies = window.filter((r) => r.user_replied === 1).length;
      const replyRate = window.length > 0 ? replies / window.length : 0;
      const avgTurns = window.length > 0 ? window.reduce((n, r) => n + r.continued_turns, 0) / window.length : 0;
      stats.push({
        kind,
        samples: window.length,
        replyRate,
        avgTurns,
        weight: clampWeight(WEIGHT_MIN + replyRate * 0.6)
      });
    }
    return { stats, windowDays: WINDOW_DAYS, minSamples: MIN_SAMPLES };
  }

  /**
   * Candidate score multiplier. With too few samples — or the flag off —
   * neutral 1.0: no single bad day may reshape behaviour (§25).
   */
  weightFor(kind: string, now: Date = this.deps.clock?.() ?? new Date()): number {
    if (!this.deps.learningEnabled) return 1;
    const stat = this.profile(now).stats.find((s) => s.kind === kind);
    if (!stat || stat.samples < 5) return 1;
    return stat.weight;
  }

  /** Admin control (§12 Learning): wipe learned preferences. */
  reset(): number {
    return this.deps.outcomes.reset();
  }
}

function clampWeight(value: number): number {
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, value));
}
