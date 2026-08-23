import type { RelationshipThreadRepo, RelationshipThreadRow } from '../../db/repos/relationship-thread.repo.js';
import { normalizeThreadTitle } from '../../db/repos/relationship-thread.repo.js';
import { cosineSimilarity, ngrams } from '../../db/repos/memory.repo.js';
import type { RelationshipThreadKind } from './types.js';
import { kindCompatibility, MATCH_THRESHOLD, type RelationshipThread } from './types.js';
import type { ExtractedRelationshipResolution, ExtractedRelationshipSignal } from '../post-turn/types.js';

const DAY_MS = 86_400_000;

/** §3 matching score components; see docs/RELATIONSHIP-CONTRACT.md §3. */
function matchScore(
  signal: { kind: RelationshipThreadKind; normalizedTitle: string; embedding?: number[] },
  thread: RelationshipThreadRow,
  vector: number[] | null,
  now: Date
): number {
  let semantic = 0;
  if (signal.embedding && vector) {
    const cosine = cosineSimilarity(signal.embedding, vector);
    if (cosine > 0) semantic = cosine;
  }
  const ga = ngrams(signal.normalizedTitle, 2);
  const gb = ngrams(thread.normalized_title, 2);
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  const entity = ga.size > 0 && gb.size > 0 ? shared / Math.min(ga.size, gb.size) : 0;
  const elapsedDays = Math.max(0, (now.getTime() - Date.parse(thread.last_touched_at)) / DAY_MS);
  const recency = Math.max(0, 1 - elapsedDays / 28) >= 0.75 ? 1 : Math.max(0, 1 - elapsedDays / 28) / 0.75;
  const kind = kindCompatibility(signal.kind, thread.kind);
  return 0.5 * semantic + 0.2 * entity + 0.2 * recency + 0.1 * kind;
}

export interface ConsumeOutcome {
  opened: number;
  touched: number;
  resolved: number;
}

/**
 * Consumes the flag-gated relationship half of the unified analyzer output
 * (§7/§13): signals open or touch threads by the frozen matching rule,
 * resolutions close them. One model call per turn feeds this and Future.
 */
export class RelationshipService {
  constructor(
    private readonly deps: {
      repo: RelationshipThreadRepo;
      embed?: (texts: string[]) => Promise<{ vectors: number[][]; model: string } | null>;
      clock?: () => Date;
      onError?: (message: string) => void;
    }
  ) {}

  async consume(
    output: {
      relationship_signals: ExtractedRelationshipSignal[];
      relationship_resolutions: ExtractedRelationshipResolution[];
    },
    ctx: { messageId: string }
  ): Promise<ConsumeOutcome> {
    const now = this.deps.clock?.() ?? new Date();
    const outcome: ConsumeOutcome = { opened: 0, touched: 0, resolved: 0 };

    for (const signal of output.relationship_signals) {
      const normalizedTitle = normalizeThreadTitle(signal.title);
      const embedding = await this.embedOne(signal.title);
      const matchable = this.deps.repo.matchable();
      let best: { row: RelationshipThreadRow; score: number } | null = null;
      // Tier 1: the same normalized title is the same thread, no scoring needed.
      const exact = matchable.find((row) => row.normalized_title === normalizedTitle);
      if (exact) {
        best = { row: exact, score: Infinity };
      } else {
        for (const row of matchable) {
          const score = matchScore(
            { kind: signal.kind, normalizedTitle, embedding: embedding?.[0] },
            row,
            this.deps.repo.vectorOf(row),
            now
          );
          if (!best || score > best.score) best = { row, score };
        }
      }
      if (best && (best.score === Infinity || best.score >= MATCH_THRESHOLD)) {
        this.deps.repo.touch(best.row.id, { summary: signal.summary ?? undefined, messageId: ctx.messageId });
        outcome.touched++;
      } else {
        this.deps.repo.create({
          kind: signal.kind,
          title: signal.title,
          summary: signal.summary ?? signal.title,
          salience: 0.6 + signal.confidence * 0.4,
          confidence: signal.confidence,
          messageId: ctx.messageId,
          embedding: embedding?.[0],
          embeddingModel: embedding?.[1]
        });
        outcome.opened++;
      }
    }

    for (const resolution of output.relationship_resolutions) {
      const thread = this.deps.repo.get(resolution.thread_id);
      if (!thread || thread.status === 'resolved' || thread.status === 'archived') continue;
      if (resolution.action === 'completed' || resolution.action === 'cancelled') {
        this.deps.repo.resolve(resolution.thread_id);
        outcome.resolved++;
      } else {
        this.deps.repo.touch(resolution.thread_id, { messageId: ctx.messageId });
        outcome.touched++;
      }
    }
    return outcome;
  }

  /** Time-driven decay sweep (§4); called from maintenance. */
  tick(now: Date = this.deps.clock?.() ?? new Date()): { cooling: number; archived: number } {
    return this.deps.repo.decaySweep(now);
  }

  private async embedOne(text: string): Promise<[number[], string] | null> {
    if (!this.deps.embed) return null;
    try {
      const result = await this.deps.embed([text]);
      if (!result || result.vectors[0] === undefined) return null;
      return [result.vectors[0]!, result.model];
    } catch (err) {
      this.deps.onError?.((err as Error).message);
      return null;
    }
  }
}

/** §18: the 3-5 lines about ongoing shared context that enter the prompt. */
export class RelationshipContextService {
  constructor(private readonly deps: { repo: RelationshipThreadRepo; clock?: () => Date }) {}

  contextLines(limit = 5): string[] {
    return this.deps.repo.contextThreads(limit).map((t) => renderThread(t));
  }
}

function renderThread(t: RelationshipThread): string {
  const body = t.summary || t.title;
  switch (t.kind) {
    case 'unresolved_issue':
      return `- 关于「${t.title}」的分歧尚未完全收尾：${body}。可以自然关心，但不要每轮都提。`;
    case 'emotional_context':
    case 'care_context':
      return `- ${body}。最近可以自然留意这一点。`;
    case 'ongoing_joke':
      return `- 你们之间有个持续的玩笑：「${t.title}」，偶尔提起会很自然。`;
    case 'shared_experience':
    case 'shared_interest':
      return `- 你们最近一起在经历：${body}。`;
    default:
      return `- 你们有一个聊到一半的话题：${body}。`;
  }
}
