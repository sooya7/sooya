import type { CommitmentKind, CommitmentFollowUpPolicy, CommitmentSubject } from '../future/types.js';

/** Bump when the prompt or schema changes enough to re-analyze old messages. */
export const EXTRACTOR_VERSION = '2';

/** One structured call per turn; schema trimmed by feature flag (§7). */
export interface ExtractedCommitment {
  kind: CommitmentKind;
  subject: CommitmentSubject;
  title: string;
  date_text: string | null;
  time_text: string | null;
  time_precision: 'exact' | 'day' | 'range' | 'relative' | 'unknown';
  follow_up: CommitmentFollowUpPolicy;
  confidence: number;
  importance: number;
}

/** Unified carrier (§7): user-item resolutions and assistant fulfilment share one array. */
export interface ExtractedResolution {
  commitment_id: string;
  action: 'completed' | 'cancelled' | 'rescheduled' | 'updated';
  date_text: string | null;
  outcome: string | null;
  confidence: number;
}

export interface ExtractedRelationshipSignal {
  kind: 'open_topic' | 'shared_experience' | 'emotional_context' | 'unresolved_issue' | 'shared_interest' | 'ongoing_joke' | 'care_context';
  title: string;
  summary: string | null;
  confidence: number;
}

export interface ExtractedRelationshipResolution {
  thread_id: string;
  action: 'completed' | 'cancelled' | 'updated';
  confidence: number;
}

export interface AnalyzerOutput {
  commitments: ExtractedCommitment[];
  commitment_resolutions: ExtractedResolution[];
  relationship_signals: ExtractedRelationshipSignal[];
  relationship_resolutions: ExtractedRelationshipResolution[];
}

export interface ActiveCommitmentView {
  id: string;
  kind: CommitmentKind;
  subject: CommitmentSubject;
  title: string;
  status: string;
  dueLocalDate: string | null;
}

export interface AnalyzerInput {
  userText: string;
  assistantText: string;
  activeCommitments: ActiveCommitmentView[];
  /** Open relationship threads; resolutions may only reference these ids. */
  activeThreads: Array<{ id: string; kind: string; title: string; status: string }>;
  now: Date;
  timeZone: string;
}
