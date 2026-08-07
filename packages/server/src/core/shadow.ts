import type { ShadowRepo, ExperimentRepo, ExperimentRow, AssignmentScope } from '../db/repos/shadow.repo.js';
import { createHash } from 'node:crypto';

/**
 * Shadow + Experiment runtime (next phase P3).
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

export class ExperimentService {
  private enabled = false;

  constructor(
    private readonly repo: ExperimentRepo,
    private readonly clock: () => Date = () => new Date()
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  list() {
    return this.repo.list();
  }

  create(name: string, subsystem: string, variants: string[], assignmentScope: AssignmentScope = 'day') {
    return this.repo.create({ name, subsystem, variants, assignmentScope });
  }

  /** Transition guard: shadow → running only via start-shadow first. */
  setStatus(id: string, status: string): { ok: boolean; error?: string; experiment?: ExperimentRow } {
    const experiment = this.repo.get(id);
    if (!experiment) return { ok: false, error: 'not_found' };
    if (status === 'running' && experiment.status === 'draft') {
      return { ok: false, error: 'shadow_prerequisite' };
    }
    if (status === 'running' && experiment.status === 'shadow') {
      // Promote: every variant moves to the same scope-sticky assignment.
      const variants = this.repo.variants(experiment);
      const scopeKey = this.scopeKey(experiment.assignment_scope);
      const variant = this.repo.variantFor(experiment.id, scopeKey, variants);
      this.repo.recordEvent(experiment.id, variant, 'started');
    }
    if (status === 'paused') this.repo.recordEvent(experiment.id, 'control', 'paused');
    if (status === 'completed' || status === 'cancelled') this.repo.recordEvent(experiment.id, 'control', status);
    return { ok: true, experiment: this.repo.setStatus(id, status as ExperimentRow['status']) };
  }

  /**
   * Variant for a running experiment, sticky per scope. When paused, returns
   * 'control' immediately (pause = instant rollback).
   */
  variantFor(id: string): string | null {
    if (!this.enabled) return null;
    const experiment = this.repo.get(id);
    if (!experiment) return null;
    if (experiment.status === 'paused') return 'control';
    if (experiment.status !== 'running' && experiment.status !== 'shadow') return null;
    const variants = this.repo.variants(experiment);
    if (variants.length === 0) return 'control';
    return this.repo.variantFor(experiment.id, this.scopeKey(experiment.assignment_scope), variants);
  }

  /** Scope key: day = local calendar date, session = process session, conversation = conversation id. */
  private scopeKey(scope: AssignmentScope): string {
    if (scope === 'day') return this.clock().toISOString().slice(0, 10);
    if (scope === 'session') return 'session';
    return 'main';
  }

  events(experimentId: string, limit = 100) {
    return this.repo.events(experimentId, limit);
  }

  /** Variant for the first active experiment of a subsystem, or null. */
  variantForSubsystem(subsystem: string): string | null {
    if (!this.enabled) return null;
    // A paused experiment keeps subsystem ownership (returning 'control',
    // i.e. canonical behavior) until it is completed/cancelled.
    const experiment = this.repo.list().find((e) => e.subsystem === subsystem && (e.status === 'running' || e.status === 'shadow' || e.status === 'paused'));
    if (!experiment) return null;
    return this.variantFor(experiment.id);
  }
}

/** Stable fingerprint of an anonymized input — never the input itself. */
export function fingerprint(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24);
}
