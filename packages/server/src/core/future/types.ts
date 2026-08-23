/**
 * Future / Commitment Engine — runtime authority for the time axis.
 *
 * Ombre keeps the long-term semantic meaning ("用户很重视这次考试"), Life keeps
 * SOOYA's own day; commitments are the only place with a due time and a state
 * machine. The status enum is closed on purpose: rescheduling is expressed as
 * supersede + a new row, never as a `rescheduled` status.
 */

export type CommitmentKind =
  | 'user_event'
  | 'shared_plan'
  | 'assistant_commitment'
  | 'reminder_request'
  | 'follow_up';

export type CommitmentSubject = 'user' | 'assistant' | 'shared';

export type CommitmentTimePrecision = 'exact' | 'day' | 'range' | 'relative' | 'unknown';

export type CommitmentStatus =
  | 'tentative'
  | 'pending'
  | 'due'
  | 'completed'
  | 'cancelled'
  | 'missed'
  | 'expired'
  | 'superseded';

export type CommitmentFollowUpPolicy = 'none' | 'natural' | 'explicit_reminder';

export interface Commitment {
  id: string;
  kind: CommitmentKind;
  subject: CommitmentSubject;
  title: string;
  normalizedTitle: string;
  semanticKey: string;
  startsAt: string | null;
  dueAt: string | null;
  timePrecision: CommitmentTimePrecision;
  status: CommitmentStatus;
  confidence: number;
  importance: number;
  sourceMessageId: string;
  sourceText: string | null;
  followUpPolicy: CommitmentFollowUpPolicy;
  earliestReachOutAt: string | null;
  latestReachOutAt: string | null;
  supersedesId: string | null;
  supersededById: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  outcome: string | null;
  extractorVersion: string;
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt: string;
}

/**
 * Statuses that still represent an open future. These are the only rows that
 * dedupe against new mentions and qualify for Future Context injection;
 * everything else (completed / cancelled / missed / expired / superseded, or
 * anything with `archivedAt` set) is history.
 */
export const LIVE_COMMITMENT_STATUSES: readonly CommitmentStatus[] = ['tentative', 'pending', 'due'];

/**
 * User- and scheduler-driven status transitions. Rescheduling is absent by
 * design: the old row goes to `superseded` and a new row links back via
 * `supersedesId`.
 */
export const COMMITMENT_TRANSITIONS: Readonly<Record<CommitmentStatus, readonly CommitmentStatus[]>> = {
  tentative: ['pending', 'completed', 'cancelled', 'expired', 'superseded'],
  pending: ['due', 'completed', 'cancelled', 'missed', 'superseded'],
  due: ['completed', 'cancelled', 'missed', 'superseded'],
  completed: [],
  cancelled: [],
  missed: [],
  expired: [],
  superseded: []
};

/**
 * Grace window after the event time before an unconfirmed item stops being
 * current — exact/day events close faster than fuzzy ranges.
 */
export const COMMITMENT_GRACE_DAYS: Readonly<Record<CommitmentTimePrecision, number>> = {
  exact: 3,
  day: 3,
  range: 7,
  relative: 7,
  unknown: 7
};
