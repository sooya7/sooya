/**
 * Feature flags for the visible thoughts layer. All default OFF: an unset or
 * empty environment behaves exactly like the stable release (no thought rows,
 * no extra model calls, no trace writes).
 *
 * Integration owns config/env.ts; this module reads from any env-shaped
 * object so tests can inject flags directly and app.ts can pass process.env.
 */

export interface ThoughtsFlags {
  /** Master switch: gates the whole layer. */
  visibleThoughtsEnabled: boolean;
  /** Gates the inner-monologue model call specifically. */
  innerMonologueEnabled: boolean;
  /** Model-call budget for a single thought. */
  thoughtTimeoutMs: number;
  /**
   * `reasoning_effort` sent with the reply request so the chat model returns
   * its reasoning; the thought is a rewrite of that reasoning. Only used while
   * the inner monologue is on.
   */
  reasoningEffort: 'low' | 'medium' | 'high';
  /** Also send the finished thought to QQ, ahead of the reply bubbles. */
  qqDelivery: boolean;
  /** `reasoningEffort` when thoughts are actually on, else undefined (the reply request stays as before). */
  replyEffort?: 'low' | 'medium' | 'high';
}

export const DEFAULT_THOUGHT_FLAGS: ThoughtsFlags = {
  visibleThoughtsEnabled: false,
  innerMonologueEnabled: false,
  thoughtTimeoutMs: 8_000,
  reasoningEffort: 'low',
  qqDelivery: false
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
  const flags: ThoughtsFlags = {
    visibleThoughtsEnabled: boolish(env.VISIBLE_THOUGHTS_ENABLED),
    innerMonologueEnabled: boolish(env.VISIBLE_INNER_MONOLOGUE_ENABLED),
    thoughtTimeoutMs: intish(env.VISIBLE_THOUGHTS_TIMEOUT_MS, DEFAULT_THOUGHT_FLAGS.thoughtTimeoutMs),
    reasoningEffort: effortish(env.VISIBLE_THOUGHTS_REASONING_EFFORT),
    qqDelivery: boolish(env.VISIBLE_THOUGHTS_QQ_ENABLED)
  };
  return { ...flags, replyEffort: replyReasoningEffort(flags) };
}

function effortish(value: string | undefined): ThoughtsFlags['reasoningEffort'] {
  const v = value?.trim().toLowerCase();
  return v === 'medium' || v === 'high' ? v : 'low';
}

/** The reasoning effort the reply request should carry, or undefined when thoughts are off. */
export function replyReasoningEffort(flags: ThoughtsFlags): ThoughtsFlags['reasoningEffort'] | undefined {
  return flags.visibleThoughtsEnabled && flags.innerMonologueEnabled ? flags.reasoningEffort : undefined;
}
