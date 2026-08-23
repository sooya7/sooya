import type { CommitmentRepo, CreateCommitmentInput } from '../../db/repos/commitment.repo.js';
import type { ErrorLogRepo } from '../../db/repos/misc.repo.js';
import type { PostTurnSemanticAnalyzer } from '../post-turn/analyzer.js';
import { EXTRACTOR_VERSION, type ActiveCommitmentView, type ExtractedRelationshipResolution, type ExtractedRelationshipSignal } from '../post-turn/types.js';
import { resolveCommitmentTime, isoToZonedDate } from './time-parser.js';
import type { Commitment } from './types.js';

export interface AnalyzerRelationshipOutput {
  relationship_signals: ExtractedRelationshipSignal[];
  relationship_resolutions: ExtractedRelationshipResolution[];
}

export interface AnalyzeOutcome {
  skipped: boolean;
  extracted: number;
  merged: number;
  resolved: number;
  rescheduled: number;
}

const EMPTY_OUTCOME: AnalyzeOutcome = { skipped: true, extracted: 0, merged: 0, resolved: 0, rescheduled: 0 };

/**
 * Runtime authority for the time axis (§3.2): consumes analyzer output into
 * the commitment repo and drives the time-based lifecycle. Ombre keeps the
 * semantic memory; nothing here is written there.
 */
export class FutureService {
  constructor(
    private readonly deps: {
      repo: CommitmentRepo;
      analyzer: PostTurnSemanticAnalyzer;
      timeZone: string;
      errors?: ErrorLogRepo;
      embed?: (texts: string[]) => Promise<{ vectors: number[][]; model: string } | null>;
      clock?: () => Date;
      onApplied?: (summary: AnalyzeOutcome) => void;
      /** §7: the same analyzer call feeds Relationship; failures stay isolated. */
      relationship?: {
        consume(output: AnalyzerRelationshipOutput, ctx: { messageId: string }): Promise<unknown>;
        /** Open threads surfaced to the analyzer prompt for resolutions. */
        contextThreads?(limit: number): Array<{ id: string; kind: string; title: string; status: string }>;
      };
    }
  ) {}

  /** Post-turn pipeline step (§8): fence → analyze → ingest/resolve. */
  async analyzeAndApply(input: {
    userText: string;
    assistantText: string;
    sourceMessageId: string;
    at?: Date;
  }): Promise<AnalyzeOutcome> {
    if (!input.sourceMessageId) return EMPTY_OUTCOME;
    if (!this.deps.repo.claimExtraction(input.sourceMessageId, EXTRACTOR_VERSION)) return EMPTY_OUTCOME;

    const now = input.at ?? this.deps.clock?.() ?? new Date();
    const active = this.deps.repo.upcoming(12);
    const activeThreads = this.deps.relationship?.contextThreads?.(8) ?? [];
    const analyzerOutput = await this.deps.analyzer.analyze({
      userText: input.userText,
      assistantText: input.assistantText,
      activeCommitments: active.map((c) => toView(c, this.deps.timeZone)),
      activeThreads,
      now,
      timeZone: this.deps.timeZone
    });

    let extracted = 0;
    let merged = 0;
    const embedded = await this.embedTitles(analyzerOutput.commitments.map((c) => c.title));

    for (let i = 0; i < analyzerOutput.commitments.length; i++) {
      const item = analyzerOutput.commitments[i]!;
      const resolved = resolveCommitmentTime({
        dateText: item.date_text,
        timeText: item.time_text,
        now,
        timeZone: this.deps.timeZone
      });
      const tentative = item.confidence < 0.55 && item.time_precision !== 'exact';
      const payload: CreateCommitmentInput = {
        kind: item.kind,
        subject: item.subject,
        title: item.title,
        startsAt: resolved?.startsAt ?? null,
        dueAt: resolved?.dueAt ?? null,
        timePrecision: resolved ? item.time_precision : 'unknown',
        status: tentative ? 'tentative' : 'pending',
        confidence: item.confidence,
        importance: item.importance,
        sourceMessageId: input.sourceMessageId,
        sourceText: input.userText.slice(0, 200),
        followUpPolicy: item.kind === 'reminder_request' ? 'explicit_reminder' : item.follow_up,
        latestReachOutAt: item.kind === 'reminder_request' || item.follow_up === 'explicit_reminder' ? resolved?.latestReachOutAt ?? null : null,
        extractorVersion: EXTRACTOR_VERSION,
        timeZone: this.deps.timeZone,
        embedding: embedded?.vectors[i],
        embeddingModel: embedded?.model
      };
      const result = this.deps.repo.ingest(payload);
      if (result.matched) merged++;
      else extracted++;
    }

    let resolved = 0;
    let rescheduled = 0;
    const liveById = new Map(active.map((c) => [c.id, c]));
    for (const r of analyzerOutput.commitment_resolutions) {
      const target = liveById.get(r.commitment_id);
      if (!target || !isLive(target)) continue;
      if (r.action === 'completed') {
        this.deps.repo.resolve(target.id, 'completed', { outcome: r.outcome ?? undefined });
        resolved++;
      } else if (r.action === 'cancelled') {
        this.deps.repo.resolve(target.id, 'cancelled', { outcome: r.outcome ?? undefined });
        resolved++;
      } else if (r.action === 'rescheduled') {
        const next = resolveCommitmentTime({ dateText: r.date_text, now, timeZone: this.deps.timeZone });
        if (next) {
          this.deps.repo.supersede(target.id, {
            kind: target.kind,
            subject: target.subject,
            title: target.title,
            startsAt: next.startsAt,
            dueAt: next.dueAt,
            timePrecision: target.timePrecision === 'unknown' ? 'day' : target.timePrecision,
            confidence: Math.max(target.confidence, r.confidence),
            importance: target.importance,
            sourceMessageId: input.sourceMessageId,
            sourceText: r.outcome ?? null,
            followUpPolicy: target.followUpPolicy,
            latestReachOutAt: next.latestReachOutAt,
            extractorVersion: EXTRACTOR_VERSION,
            timeZone: this.deps.timeZone
          });
          rescheduled++;
        }
      }
      // 'updated' reinforces recency without changing status.
    }

    const outcome: AnalyzeOutcome = { skipped: false, extracted, merged, resolved, rescheduled };
    this.deps.onApplied?.(outcome);
    // §7 distribution: Relationship consumes the same call's output. A
    // relationship failure must never unwind commitment writes.
    if (this.deps.relationship) {
      try {
        await this.deps.relationship.consume(
          {
            relationship_signals: analyzerOutput.relationship_signals,
            relationship_resolutions: analyzerOutput.relationship_resolutions
          },
          { messageId: input.sourceMessageId }
        );
      } catch (err) {
        this.deps.errors?.add('relationship.consume', (err as Error).message);
      }
    }
    return outcome;
  }

  /** §7 distribution seam; app.ts attaches Relationship when its flag is on. */
  attachRelationship(relationship: {
    consume(output: AnalyzerRelationshipOutput, ctx: { messageId: string }): Promise<unknown>;
    contextThreads?(limit: number): Array<{ id: string; kind: string; title: string; status: string }>;
  } | undefined): void {
    (this.deps as { relationship?: unknown }).relationship = relationship;
  }

  /** Time-driven lifecycle tick (§13); call from a maintenance job. */
  tick(now: Date = this.deps.clock?.() ?? new Date()): { promotedDue: number; missed: number; expired: number; archived: number } {
    return this.deps.repo.applyTimeDrivenTransitions(now.toISOString());
  }

  private async embedTitles(titles: string[]): Promise<{ vectors: number[][]; model: string } | null> {
    if (!this.deps.embed || titles.length === 0) return null;
    try {
      return await this.deps.embed(titles);
    } catch (err) {
      this.deps.errors?.add('future.embed', (err as Error).message);
      return null;
    }
  }
}

function toView(c: Commitment, timeZone: string): ActiveCommitmentView {
  return {
    id: c.id,
    kind: c.kind,
    subject: c.subject,
    title: c.title,
    status: c.status,
    dueLocalDate: c.dueAt ? isoToZonedDate(c.dueAt, timeZone) : null
  };
}

function isLive(c: Commitment): boolean {
  return (c.status === 'tentative' || c.status === 'pending' || c.status === 'due') && !c.archivedAt;
}
