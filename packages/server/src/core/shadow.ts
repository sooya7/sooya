import type { ShadowRepo } from '../db/repos/shadow.repo.js';
import { createHash } from 'node:crypto';

/**
 * Shadow runtime (next phase P3).
 *
 * Shadow is architecturally read-only: the shadow function only receives a
 * plain input object (ids/kinds/numbers — never free text) and returns a
 * decision; it has no access to any repo, so it cannot write state, trigger
 * memory/proactive/push/media or affect the canonical path. Canonical always
 * runs first and is never influenced by the shadow.
 *
 * Experiments are single-user: assignment is sticky per scope (day/session/
 * conversation) so a variant never flips mid-scope, and a running experiment
 * must first pass through shadow.
 */
export interface ShadowInput {
  subsystem: string;
  canonicalVersion: string;
  shadowVersion: string;
  /** Anonymized fingerprint — ids/kinds/numbers only. */
  input: Record<string, unknown>;
  canonicalDecision: unknown;
  runShadow: () => unknown;
}

export class ShadowService {
  private enabled = false;

  constructor(private readonly repo: ShadowRepo) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Runs the shadow candidate and records the diff. Never throws upward. */
  run(input: ShadowInput): void {
    if (!this.enabled) return;
    try {
      const started = Date.now();
      const shadowDecision = input.runShadow();
      const durationMs = Date.now() - started;
      const canonical = JSON.stringify(input.canonicalDecision ?? null);
      const shadow = JSON.stringify(shadowDecision ?? null);
      this.repo.recordRun({
        subsystem: input.subsystem,
        canonical_version: input.canonicalVersion,
        shadow_version: input.shadowVersion,
        input_fingerprint: fingerprint(input.input),
        canonical_decision: canonical,
        shadow_decision: shadow,
        diff_json: JSON.stringify({ equal: canonical === shadow }),
        duration_ms: durationMs
      });
    } catch { /* a shadow failure must never touch the canonical path */ }
  }

  list(subsystem?: string, limit = 100) {
    return this.repo.list(subsystem, limit);
  }
}

export function fingerprint(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24);
}
