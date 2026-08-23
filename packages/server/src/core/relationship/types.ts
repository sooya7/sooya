/**
 * Relationship Continuity (docs/RELATIONSHIP-CONTRACT.md — frozen PR6).
 * Structured unfinished-relationship state; never a numeric affection score.
 */

export type RelationshipThreadKind =
  | 'open_topic'
  | 'shared_experience'
  | 'emotional_context'
  | 'unresolved_issue'
  | 'shared_interest'
  | 'ongoing_joke'
  | 'care_context';

export type ThreadStatus = 'open' | 'cooling' | 'resolved' | 'archived';

export interface RelationshipThread {
  id: string;
  kind: RelationshipThreadKind;
  title: string;
  normalizedTitle: string;
  summary: string;
  status: ThreadStatus;
  salience: number;
  confidence: number;
  firstMessageId: string | null;
  lastMessageId: string | null;
  linkedCommitmentId: string | null;
  reopenCount: number;
  openedAt: string;
  lastTouchedAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** §3: an incoming signal joins an existing thread only above this score. */
export const MATCH_THRESHOLD = 0.62;

/** §4: per-kind salience half-life in days. A single TTL for all kinds is banned. */
export const SALIENCE_HALFLIFE_DAYS: Readonly<Record<RelationshipThreadKind, number>> = {
  unresolved_issue: 21,
  emotional_context: 14,
  care_context: 14,
  shared_experience: 10,
  shared_interest: 10,
  open_topic: 7,
  ongoing_joke: 3
};

/** §4 thresholds: cooling stops context injection but stays re-wakeable. */
export const COOLING_SALIENCE = 0.35;
export const ARCHIVE_SALIENCE = 0.15;

/** §3 kind compatibility groups for the matching score. */
export const KIND_GROUPS: ReadonlyArray<readonly RelationshipThreadKind[]> = [
  ['open_topic', 'shared_interest', 'shared_experience'],
  ['emotional_context', 'care_context', 'unresolved_issue']
];

export function kindCompatibility(a: RelationshipThreadKind, b: RelationshipThreadKind): number {
  if (a === b) return 1;
  for (const group of KIND_GROUPS) {
    if (group.includes(a) && group.includes(b)) return 0.5;
  }
  return 0;
}
