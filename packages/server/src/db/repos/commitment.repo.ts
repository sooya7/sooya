import type { DbLike } from '../handle.js';
import {
  COMMITMENT_GRACE_DAYS,
  COMMITMENT_TRANSITIONS,
  LIVE_COMMITMENT_STATUSES,
  type Commitment,
  type CommitmentFollowUpPolicy,
  type CommitmentKind,
  type CommitmentStatus,
  type CommitmentSubject,
  type CommitmentTimePrecision
} from '../../core/future/types.js';
import { bufferToFloats, cosineSimilarity, floatsToBuffer, ngrams, normalizeMemoryText } from './memory.repo.js';
import { isoToZonedDate } from '../../core/future/time-parser.js';
import { newCommitmentId, nowIso } from '../../util/ids.js';

export interface CommitmentRow {
  id: string;
  kind: CommitmentKind;
  subject: CommitmentSubject;
  title: string;
  normalized_title: string;
  semantic_key: string;
  starts_at: string | null;
  due_at: string | null;
  time_precision: CommitmentTimePrecision;
  status: CommitmentStatus;
  confidence: number;
  importance: number;
  source_message_id: string;
  source_text: string | null;
  follow_up_policy: CommitmentFollowUpPolicy;
  earliest_reach_out_at: string | null;
  latest_reach_out_at: string | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  completed_at: string | null;
  archived_at: string | null;
  outcome: string | null;
  embedding: Buffer | null;
  embedding_dim: number | null;
  embedding_model: string | null;
  extractor_version: string;
  created_at: string;
  updated_at: string;
  last_confirmed_at: string;
}

export interface CreateCommitmentInput {
  kind: CommitmentKind;
  subject: CommitmentSubject;
  title: string;
  startsAt?: string | null;
  dueAt?: string | null;
  timePrecision: CommitmentTimePrecision;
  status?: CommitmentStatus;
  confidence?: number;
  importance?: number;
  sourceMessageId: string;
  sourceText?: string | null;
  followUpPolicy?: CommitmentFollowUpPolicy;
  earliestReachOutAt?: string | null;
  latestReachOutAt?: string | null;
  extractorVersion?: string;
  /**
   * Timezone the anchors were resolved in. The semantic key stores the LOCAL
   * day ("周五" stays 2026-08-28 even though local midnight is Aug-27 16:00Z);
   * UTC slicing would shift keys by one day for eastern longitudes.
   */
  timeZone?: string;
  /**
   * Write-time embedding (§10.3: vectors are computed when the analyzer runs,
   * never on the reply hot path). Enables the cosine tier of semantic dedupe.
   */
  embedding?: number[];
  embeddingModel?: string;
}

export type IngestMatch = 'exact' | 'semantic' | null;

export interface TimeDrivenOutcome {
  promotedDue: number;
  missed: number;
  expired: number;
  archived: number;
}

const DAY_MS = 86_400_000;
const EXTRACTION_CLAIM_STALE_MS = 15 * 60_000;
/** Two mentions of the same real event resolve to dates at most this far apart. */
const TIME_WINDOW_DAYS = 2;
/** Lexical tier of the secondary match; below it nothing merges without vectors. */
const LEXICAL_THRESHOLD = 0.5;
const COSINE_THRESHOLD = 0.92;
const LIVE_SQL = LIVE_COMMITMENT_STATUSES.map(() => '?').join(',');

export function normalizeCommitmentTitle(title: string): string {
  return normalizeMemoryText(title);
}

/** `user_event:user:考试:2026-08-28` — kind, subject, normalized title, resolved local day. */
export function buildSemanticKey(input: {
  kind: CommitmentKind;
  subject: CommitmentSubject;
  title: string;
  startsAt?: string | null;
  dueAt?: string | null;
  timeZone?: string;
}): string {
  const anchor = input.startsAt ?? input.dueAt;
  const day = anchor ? isoToZonedDate(anchor, input.timeZone ?? 'UTC') : 'undated';
  return `${input.kind}:${input.subject}:${normalizeCommitmentTitle(input.title)}:${day}`;
}

/**
 * Lexical tier of semantic matching. Containment and shared bigrams only —
 * loose character overlap would merge "考试" with "面试", so short CJK titles
 * that share no bigram fall through to the cosine tier instead.
 */
export function lexicalTitleScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 1;
  const ga = ngrams(a, 2);
  const gb = ngrams(b, 2);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return shared / Math.min(ga.size, gb.size);
}

/** Both dated and within the window, or both undated — a dated mention never merges into an undated row. */
function timeWindowOverlaps(a: { starts_at: string | null; due_at: string | null }, b: { startsAt?: string | null; dueAt?: string | null }): boolean {
  const dayA = a.starts_at ?? a.due_at;
  const dayB = b.startsAt ?? b.dueAt;
  if (!dayA && !dayB) return true;
  if (!dayA || !dayB) return false;
  const diff = Math.abs(Date.parse(dayA) - Date.parse(dayB));
  return diff <= TIME_WINDOW_DAYS * DAY_MS;
}

function graceMs(precision: CommitmentTimePrecision): number {
  return COMMITMENT_GRACE_DAYS[precision] * DAY_MS;
}

export class CommitmentRepo {
  constructor(private readonly db: DbLike) {}

  /**
   * Layer-2 job idempotency fence (§5.2). The v41 table stores successful
   * claims forever, while an in-flight claim acts as a lease: a process death
   * cannot brick the message permanently because an old claim is reclaimed
   * after 15 minutes. Normal provider/parse/apply failures explicitly release
   * the claim via releaseExtraction().
   */
  claimExtraction(sourceMessageId: string, extractorVersion: string): boolean {
    const ts = nowIso();
    const staleBefore = new Date(Date.parse(ts) - EXTRACTION_CLAIM_STALE_MS).toISOString();
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM commitment_extraction_runs WHERE source_message_id = ? AND extractor_version = ? AND claimed_at < ?'
        )
        .run(sourceMessageId, extractorVersion, staleBefore);
      return (
        this.db
          .prepare('INSERT OR IGNORE INTO commitment_extraction_runs(source_message_id, extractor_version, claimed_at) VALUES (?, ?, ?)')
          .run(sourceMessageId, extractorVersion, ts).changes > 0
      );
    });
    return run();
  }

  /** Release a failed attempt so the durable job can retry immediately. */
  releaseExtraction(sourceMessageId: string, extractorVersion: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM commitment_extraction_runs WHERE source_message_id = ? AND extractor_version = ?')
        .run(sourceMessageId, extractorVersion).changes > 0
    );
  }

  /**
   * Dedupe-aware insert (§5.1). Layer 1 hits an identical semantic_key; layer 2
   * narrows by kind/subject/time-window and merges on lexical or cosine
   * similarity. Anything else becomes a new row. Never scans embeddings
   * unconditionally — cosine only runs when both sides already have vectors.
   */
  ingest(input: CreateCommitmentInput): { commitment: Commitment; matched: IngestMatch } {
    const run = this.db.transaction((): { row: CommitmentRow; matched: IngestMatch } => {
      const normalizedTitle = normalizeCommitmentTitle(input.title);
      const semanticKey = buildSemanticKey(input);

      const exact = this.db
        .prepare(
          `SELECT * FROM commitments WHERE semantic_key = ? AND status IN (${LIVE_SQL}) AND archived_at IS NULL
           ORDER BY updated_at DESC LIMIT 1`
        )
        .get(semanticKey, ...LIVE_COMMITMENT_STATUSES) as CommitmentRow | undefined;
      if (exact) return { row: this.reinforce(exact, input), matched: 'exact' };

      const candidates = this.db
        .prepare(
          `SELECT * FROM commitments WHERE kind = ? AND subject = ? AND status IN (${LIVE_SQL}) AND archived_at IS NULL`
        )
        .all(input.kind, input.subject, ...LIVE_COMMITMENT_STATUSES) as CommitmentRow[];
      let best: { row: CommitmentRow; score: number } | undefined;
      for (const cand of candidates) {
        if (!timeWindowOverlaps(cand, input)) continue;
        const lexical = lexicalTitleScore(cand.normalized_title, normalizedTitle);
        let score = lexical >= LEXICAL_THRESHOLD ? lexical : 0;
        if (score === 0 && input.embedding && cand.embedding) {
          const cosine = cosineSimilarity(input.embedding, bufferToFloats(cand.embedding));
          if (cosine >= COSINE_THRESHOLD) score = cosine;
        }
        if (score > 0 && (!best || score > best.score)) best = { row: cand, score };
      }
      if (best) return { row: this.reinforce(best.row, input), matched: 'semantic' };

      return { row: this.insert(input, { normalizedTitle, semanticKey }), matched: null };
    });
    const result = run();
    return { commitment: this.toRecord(result.row), matched: result.matched };
  }

  /** A repeat mention strengthens the existing row instead of creating one. */
  private reinforce(row: CommitmentRow, input: CreateCommitmentInput): CommitmentRow {
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE commitments SET confidence = MAX(confidence, ?), importance = MAX(importance, ?),
           last_confirmed_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(input.confidence ?? row.confidence, input.importance ?? row.importance, ts, ts, row.id);
    if (input.embedding && !row.embedding) {
      this.setEmbedding(row.id, input.embedding, input.embeddingModel ?? input.extractorVersion ?? 'unknown');
    }
    return this.rowById(row.id)!;
  }

  private insert(
    input: CreateCommitmentInput,
    derived: { normalizedTitle: string; semanticKey: string }
  ): CommitmentRow {
    const id = newCommitmentId();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO commitments
          (id, kind, subject, title, normalized_title, semantic_key, starts_at, due_at, time_precision, status,
           confidence, importance, source_message_id, source_text, follow_up_policy,
           earliest_reach_out_at, latest_reach_out_at, extractor_version, created_at, updated_at, last_confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.kind,
        input.subject,
        input.title,
        derived.normalizedTitle,
        derived.semanticKey,
        input.startsAt ?? null,
        input.dueAt ?? null,
        input.timePrecision,
        input.status ?? 'pending',
        input.confidence ?? 0.6,
        input.importance ?? 0.5,
        input.sourceMessageId,
        input.sourceText ?? null,
        input.followUpPolicy ?? 'natural',
        input.earliestReachOutAt ?? null,
        input.latestReachOutAt ?? null,
        input.extractorVersion ?? '1',
        ts,
        ts,
        ts
      );
    if (input.embedding) this.setEmbedding(id, input.embedding, input.embeddingModel ?? input.extractorVersion ?? 'unknown');
    return this.rowById(id)!;
  }

  /**
   * Reschedule semantics (§12): the old row becomes `superseded` and a new row
   * links back via supersedes_id, so the timeline keeps both dates. There is no
   * `rescheduled` status to write.
   */
  supersede(previousId: string, input: CreateCommitmentInput): { previous: Commitment; replacement: Commitment } {
    const run = this.db.transaction(() => {
      const previous = this.rowById(previousId);
      if (!previous) throw new Error(`commitment ${previousId} not found`);
      if (previous.status === 'superseded' || previous.superseded_by_id) {
        throw new Error(`commitment ${previousId} is already superseded`);
      }
      const ts = nowIso();
      const replacement = this.insert(input, {
        normalizedTitle: normalizeCommitmentTitle(input.title),
        semanticKey: buildSemanticKey(input)
      });
      this.db
        .prepare('UPDATE commitments SET supersedes_id = ?, updated_at = ? WHERE id = ?')
        .run(previousId, ts, replacement.id);
      this.db
        .prepare("UPDATE commitments SET status = 'superseded', superseded_by_id = ?, updated_at = ? WHERE id = ?")
        .run(replacement.id, ts, previousId);
      return {
        previous: this.toRecord(this.rowById(previousId)!),
        replacement: this.toRecord(this.rowById(replacement.id)!)
      };
    });
    return run();
  }

  /** User-driven resolution (§12). Invalid jumps are rejected by the transition table. */
  resolve(
    id: string,
    action: 'completed' | 'cancelled' | 'missed' | 'expired',
    opts: { outcome?: string; at?: string } = {}
  ): Commitment {
    const row = this.rowById(id);
    if (!row) throw new Error(`commitment ${id} not found`);
    if (!COMMITMENT_TRANSITIONS[row.status].includes(action)) {
      throw new Error(`commitment ${id} cannot move ${row.status} → ${action}`);
    }
    const ts = opts.at ?? nowIso();
    this.db
      .prepare(
        `UPDATE commitments SET status = ?, outcome = COALESCE(?, outcome),
           completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END, updated_at = ? WHERE id = ?`
      )
      .run(action, opts.outcome ?? null, action, ts, ts, id);
    return this.toRecord(this.rowById(id)!);
  }

  /** A tentative mention gets confirmed and becomes a real pending item. */
  confirm(id: string): Commitment {
    const row = this.rowById(id);
    if (!row) throw new Error(`commitment ${id} not found`);
    if (!COMMITMENT_TRANSITIONS[row.status].includes('pending')) {
      throw new Error(`commitment ${id} cannot move ${row.status} → pending`);
    }
    const ts = nowIso();
    this.db
      .prepare("UPDATE commitments SET status = 'pending', last_confirmed_at = ?, updated_at = ? WHERE id = ?")
      .run(ts, ts, id);
    return this.toRecord(this.rowById(id)!);
  }

  /** Stop injecting an unconfirmed item into Future Context without rewriting its history. */
  archive(id: string, at: string = nowIso()): boolean {
    return this.db
      .prepare(
        `UPDATE commitments SET archived_at = ?, updated_at = ?
           WHERE id = ? AND status IN (${LIVE_SQL}) AND archived_at IS NULL`
      )
      .run(at, at, id, ...LIVE_COMMITMENT_STATUSES).changes > 0;
  }

  /**
   * Time-driven lifecycle (§13): due promotion, missed explicit promises,
   * expired tentatives and grace-window archiving. Runs inside one
   * transaction; ordering matters — an overdue reminder becomes `missed`
   * rather than being archived into silence.
   */
  applyTimeDrivenTransitions(now: string = nowIso()): TimeDrivenOutcome {
    const run = this.db.transaction(() => {
      // Due promotion anchors on startsAt: a day-precision item becomes "due"
      // at local midnight of its day, not at its end-of-day dueAt.
      const promotedDue = this.db
        .prepare(
          `UPDATE commitments SET status = 'due', updated_at = ?
             WHERE status = 'pending' AND archived_at IS NULL
               AND COALESCE(starts_at, due_at) IS NOT NULL AND COALESCE(starts_at, due_at) <= ?`
        )
        .run(now, now).changes;

      const missed = this.db
        .prepare(
          `UPDATE commitments SET status = 'missed', updated_at = ?
             WHERE status IN ('pending','due') AND archived_at IS NULL
               AND COALESCE(latest_reach_out_at, CASE WHEN kind = 'assistant_commitment' THEN due_at END) IS NOT NULL
               AND COALESCE(latest_reach_out_at, CASE WHEN kind = 'assistant_commitment' THEN due_at END) < ?
               AND (follow_up_policy = 'explicit_reminder' OR kind IN ('reminder_request','assistant_commitment'))`
        )
        .run(now, now).changes;

      const expired = this.transitionPastGrace('tentative', 'expired', now);
      const archived = this.transitionPastGrace('pending-due', 'archived', now);
      return { promotedDue, missed, expired, archived };
    });
    return run();
  }

  private transitionPastGrace(
    statuses: 'tentative' | 'pending-due',
    to: 'expired' | 'archived',
    now: string
  ): number {
    const statusSql = statuses === 'tentative' ? "status = 'tentative'" : "status IN ('pending','due')";
    const rows = this.db
      .prepare(
        `SELECT id, due_at, time_precision FROM commitments
           WHERE ${statusSql} AND archived_at IS NULL AND due_at IS NOT NULL AND due_at <= ?`
      )
      .all(now) as Array<Pick<CommitmentRow, 'id' | 'due_at' | 'time_precision'>>;
    let changed = 0;
    const nowMs = Date.parse(now);
    for (const row of rows) {
      if (Date.parse(row.due_at!) + graceMs(row.time_precision) > nowMs) continue;
      if (to === 'expired') {
        changed += this.db
          .prepare("UPDATE commitments SET status = 'expired', updated_at = ? WHERE id = ?")
          .run(now, row.id).changes;
      } else {
        changed += this.db
          .prepare('UPDATE commitments SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
          .run(now, now, row.id).changes;
      }
    }
    return changed;
  }

  /**
   * Rows eligible for Future Context: live statuses only, nothing archived.
   * A due item stays visible on its day — staleness is the scheduler's call
   * (§13), not a query-time guess.
   */
  upcoming(limit = 5): Commitment[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM commitments WHERE status IN (${LIVE_SQL}) AND archived_at IS NULL
         ORDER BY (due_at IS NULL), due_at, importance DESC LIMIT ?`
      )
      .all(...LIVE_COMMITMENT_STATUSES, limit) as CommitmentRow[];
    return rows.map((r) => this.toRecord(r));
  }

  list(
    opts: {
      status?: CommitmentStatus | CommitmentStatus[];
      kind?: CommitmentKind;
      includeArchived?: boolean;
      limit?: number;
      offset?: number;
    } = {}
  ): Commitment[] {
    const limit = Math.min(opts.limit ?? 100, 500);
    const offset = opts.offset ?? 0;
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    if (!opts.includeArchived) where.push('archived_at IS NULL');
    const sql = `SELECT * FROM commitments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return (this.db.prepare(sql).all(...params) as CommitmentRow[]).map((r) => this.toRecord(r));
  }

  /** Oldest → newest across a supersede chain; the seed row may sit anywhere in it. */
  supersedeChain(id: string): Commitment[] {
    let root = this.rowById(id);
    if (!root) return [];
    for (let hops = 0; root!.supersedes_id && hops < 32; hops++) {
      const next = this.rowById(root!.supersedes_id);
      if (!next) break;
      root = next;
    }
    const chain: CommitmentRow[] = [root!];
    for (let hops = 0; hops < 32; hops++) {
      const nextId = chain[chain.length - 1]!.superseded_by_id;
      if (!nextId) break;
      const next = this.rowById(nextId);
      if (!next) break;
      chain.push(next);
    }
    return chain.map((r) => this.toRecord(r));
  }

  update(
    id: string,
    patch: {
      title?: string;
      startsAt?: string | null;
      dueAt?: string | null;
      timePrecision?: CommitmentTimePrecision;
      importance?: number;
      confidence?: number;
      followUpPolicy?: CommitmentFollowUpPolicy;
      earliestReachOutAt?: string | null;
      latestReachOutAt?: string | null;
      timeZone?: string;
    }
  ): Commitment | undefined {
    const row = this.rowById(id);
    if (!row) return undefined;
    const title = patch.title ?? row.title;
    const startsAt = patch.startsAt !== undefined ? patch.startsAt : row.starts_at;
    const dueAt = patch.dueAt !== undefined ? patch.dueAt : row.due_at;
    const normalizedTitle = normalizeCommitmentTitle(title);
    const semanticKey = buildSemanticKey({
      kind: row.kind,
      subject: row.subject,
      title,
      startsAt,
      dueAt,
      timeZone: patch.timeZone
    });
    this.db
      .prepare(
        `UPDATE commitments SET title = ?, normalized_title = ?, semantic_key = ?, starts_at = ?, due_at = ?,
           time_precision = ?, importance = ?, confidence = ?, follow_up_policy = ?,
           earliest_reach_out_at = ?, latest_reach_out_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        title,
        normalizedTitle,
        semanticKey,
        startsAt,
        dueAt,
        patch.timePrecision ?? row.time_precision,
        patch.importance ?? row.importance,
        patch.confidence ?? row.confidence,
        patch.followUpPolicy ?? row.follow_up_policy,
        patch.earliestReachOutAt !== undefined ? patch.earliestReachOutAt : row.earliest_reach_out_at,
        patch.latestReachOutAt !== undefined ? patch.latestReachOutAt : row.latest_reach_out_at,
        nowIso(),
        id
      );
    return this.get(id);
  }

  setEmbedding(id: string, vector: number[], model: string): void {
    this.db
      .prepare('UPDATE commitments SET embedding = ?, embedding_dim = ?, embedding_model = ? WHERE id = ?')
      .run(floatsToBuffer(vector), vector.length, model, id);
  }

  rowById(id: string): CommitmentRow | undefined {
    return this.db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) as CommitmentRow | undefined;
  }

  get(id: string): Commitment | undefined {
    const row = this.rowById(id);
    return row ? this.toRecord(row) : undefined;
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) c FROM commitments GROUP BY status')
      .all() as Array<{ status: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM commitments WHERE id = ?').run(id).changes > 0;
  }

  toRecord(row: CommitmentRow): Commitment {
    return {
      id: row.id,
      kind: row.kind,
      subject: row.subject,
      title: row.title,
      normalizedTitle: row.normalized_title,
      semanticKey: row.semantic_key,
      startsAt: row.starts_at,
      dueAt: row.due_at,
      timePrecision: row.time_precision,
      status: row.status,
      confidence: row.confidence,
      importance: row.importance,
      sourceMessageId: row.source_message_id,
      sourceText: row.source_text,
      followUpPolicy: row.follow_up_policy,
      earliestReachOutAt: row.earliest_reach_out_at,
      latestReachOutAt: row.latest_reach_out_at,
      supersedesId: row.supersedes_id,
      supersededById: row.superseded_by_id,
      completedAt: row.completed_at,
      archivedAt: row.archived_at,
      outcome: row.outcome,
      extractorVersion: row.extractor_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastConfirmedAt: row.last_confirmed_at
    };
  }
}
