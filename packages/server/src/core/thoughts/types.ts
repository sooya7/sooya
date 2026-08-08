/**
 * Visible Thoughts — frozen types (docs/NEXT-PHASE-CONTRACTS.md §1.6).
 *
 * These types are NOT the character's hidden reasoning. They are short,
 * safe, public-facing summaries produced from a strict input whitelist:
 *   user message / final canonical reply / safe Life context / safe WorldContext /
 *   reply intent / voice mode / safe decision metadata.
 * Never feed the system prompt, hidden chain-of-thought, internal safety rules,
 * API keys, provider secrets, raw memory retrieval text or raw tool output into
 * the presenter, and never surface any of them in a thought.
 */

export type VisibleThoughtKind = 'inner_monologue' | 'decision_summary';
export type VisibleThoughtVisibility = 'user' | 'admin';
export type VisibleThoughtStatus = 'generating' | 'completed' | 'cancelled' | 'failed';

export interface VisibleThought {
  id: string;
  messageId: string;
  batchId: string;
  revision: number;
  kind: VisibleThoughtKind;
  text: string;
  visibility: VisibleThoughtVisibility;
  status: VisibleThoughtStatus;
  createdAt: string;
}

