import type { LifeLogRow } from '../db/repos/life.repo.js';
import type { Commitment } from './future/types.js';

/**
 * Generic proactive candidate (plan §17/§19): every source — Life today,
 * Future commitments, Relationship later — funnels into one arbiter so no
 * subsystem ever talks to QQ on its own.
 */
export type ProactiveCandidateSource = 'life' | 'commitment';

export interface ProactiveCandidate {
  source: ProactiveCandidateSource;
  /** Stable identity for attempt tracking: `life:<id>` / `commitment:<id>`. */
  key: string;
  /** Machine reason carried into attempts/metrics, e.g. upcoming_user_event. */
  reason: string;
  /** 0..1 — how soon / how much this needs a turn now. */
  urgency: number;
  /** 0..1 — how much the user cares, per the source's own scoring. */
  salience: number;
  /** Life payload; the existing Moment composer consumes this unchanged. */
  lifeCandidate?: LifeLogRow;
  /** Commitment payload for reminder-style proactive care. */
  commitment?: {
    id: string;
    kind: Commitment['kind'];
    title: string;
    /** Minutes until startsAt; null when only a day-precision dueAt exists. */
    distanceMinutes: number | null;
  };
}

/**
 * §20 candidate score. Deliberately cheap and deterministic; learned
 * preference weights (§22-26) multiply in later, after hard gates — never
 * before them.
 */
export function candidateScore(candidate: ProactiveCandidate, opts: { recentlySentKeys: Set<string> }): number {
  let score = candidate.urgency * 0.6 + candidate.salience * 0.4;
  // Repetition penalty: an already-sent candidate this cycle is not a candidate.
  if (opts.recentlySentKeys.has(candidate.key)) score -= 1;
  return score;
}

/** Pick the highest-scoring candidate; ties go to the earlier collector entry. */
export function arbitrate(candidates: ProactiveCandidate[], recentlySentKeys: Set<string>): ProactiveCandidate | null {
  let best: ProactiveCandidate | null = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = candidateScore(candidate, { recentlySentKeys });
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  // A repetition-penalized candidate (score <= 0) is not a candidate.
  return best !== null && bestScore > 0 ? best : null;
}

/** Live commitments worth a natural, model-worded heads-up. */
export function commitmentCandidates(
  commitments: Commitment[],
  now: Date
): ProactiveCandidate[] {
  const out: ProactiveCandidate[] = [];
  for (const c of commitments) {
    if (c.followUpPolicy === 'none') continue;
    if (c.status !== 'pending' && c.status !== 'due') continue;
    if (c.archivedAt) continue;
    const anchor = c.startsAt ?? c.dueAt;
    if (!anchor) continue;
    const distanceMs = Date.parse(anchor) - now.getTime();
    // Too early to mention (beyond ~36h) or long past (grace already handled
    // staleness): the sweet spot is "soon" and "today".
    if (distanceMs > 36 * 3_600_000 || distanceMs < -6 * 3_600_000) continue;
    if (c.earliestReachOutAt && now.getTime() < Date.parse(c.earliestReachOutAt)) continue;
    if (c.latestReachOutAt && now.getTime() > Date.parse(c.latestReachOutAt) && c.followUpPolicy === 'explicit_reminder') continue;
    const distanceHours = Math.abs(distanceMs) / 3_600_000;
    const urgency = Math.max(0, Math.min(1, 1 - distanceHours / 36));
    const salience = Math.max(0.3, Math.min(1, c.importance));
    out.push({
      source: 'commitment',
      key: `commitment:${c.id}`,
      reason: c.followUpPolicy === 'explicit_reminder' ? 'commitment_reminder_due' : 'upcoming_user_event',
      urgency: c.followUpPolicy === 'explicit_reminder' ? Math.max(0.8, urgency) : urgency,
      salience,
      commitment: {
        id: c.id,
        kind: c.kind,
        title: c.title,
        distanceMinutes: Math.round(distanceMs / 60_000)
      }
    });
  }
  return out;
}
