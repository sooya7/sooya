/**
 * MemoryTemporalAdapter — frozen interface (docs/OMBRE-TEMPORAL-AUDIT.md §3).
 *
 * NOT implemented yet by design (PR11 decision rule): production runs the
 * Ombre backend, and the adapter is only worth building once the live-probe
 * audit (Q1-Q4) confirms what Ombre already provides. Until then, all
 * time-axis authority lives in the commitment/relationship state machines.
 */

export interface TemporalFact {
  key: string;
  content: string;
  validFrom: string | null;
  validTo: string | null;
  lastConfirmedAt: string | null;
  confidence: number;
}

export type ConflictKind = 'reinforce' | 'correction' | 'changed_over_time' | 'uncertain_conflict';

export interface MemoryTemporalAdapter {
  /** Current facts for a key — superseded rows must NOT appear. */
  currentFacts(key: string): Promise<TemporalFact[]>;
  /** Full version timeline, for recall/history features only. */
  history(key: string): Promise<TemporalFact[]>;
  /**
   * Write a new observation; the adapter decides the conflict kind.
   * - correction: old fact gets validTo = now
   * - changed_over_time: timeline extended, both stay queryable
   * - uncertain_conflict: both kept, confidences lowered
   */
  observe(key: string, content: string, observedAt: string, confidence: number): Promise<ConflictKind>;
}
