/**
 * Feature flags for the visible thoughts layer. All default OFF: an unset or
 * empty environment behaves exactly like the stable release (no thought rows,
 * no extra model calls, no trace writes).
 *
 * Integration owns config/env.ts; this module reads from any env-shaped
 * object so tests can inject flags directly and app.ts can pass process.env.
 */

export interface ThoughtsFlags {
  /** Master switch: gates the whole layer (thoughts + traces). */
  visibleThoughtsEnabled: boolean;
  /** Gates the inner-monologue model call specifically. */
  innerMonologueEnabled: boolean;
  /** Gates decision-trace persistence (admin-only surface). */
  adminDecisionTraceEnabled: boolean;
  /** Model-call budget for a single thought. */
  thoughtTimeoutMs: number;
}

export const DEFAULT_THOUGHT_FLAGS: ThoughtsFlags = {
  visibleThoughtsEnabled: false,
  innerMonologueEnabled: false,
  adminDecisionTraceEnabled: false,
  thoughtTimeoutMs: 8_000
};

function boolish(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function intish(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

export function readThoughtsFlags(env: NodeJS.ProcessEnv): ThoughtsFlags {
  return {
    visibleThoughtsEnabled: boolish(env.VISIBLE_THOUGHTS_ENABLED),
    innerMonologueEnabled: boolish(env.VISIBLE_INNER_MONOLOGUE_ENABLED),
    adminDecisionTraceEnabled: boolish(env.ADMIN_DECISION_TRACE_ENABLED),
    thoughtTimeoutMs: intish(env.VISIBLE_THOUGHTS_TIMEOUT_MS, DEFAULT_THOUGHT_FLAGS.thoughtTimeoutMs)
  };
}
