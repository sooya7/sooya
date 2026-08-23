import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/index.js';
import {
  CommitmentRepo,
  buildSemanticKey,
  lexicalTitleScore,
  type CreateCommitmentInput
} from '../src/db/repos/commitment.repo.js';

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});

function repo(): CommitmentRepo {
  const db = new Database(':memory:');
  open.push(db);
  migrate(db);
  return new CommitmentRepo(db);
}

const EXAM_DAY = '2026-08-28T09:00:00.000Z';
const EXAM = (over: Partial<CreateCommitmentInput> = {}): CreateCommitmentInput => ({
  kind: 'user_event',
  subject: 'user',
  title: '考试',
  dueAt: EXAM_DAY,
  timePrecision: 'day',
  sourceMessageId: 'msg_1',
  ...over
});

describe('commitment migration', () => {
  it('creates the commitments tables alongside the rest of the schema', () => {
    const db = new Database(':memory:');
    open.push(db);
    migrate(db);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'commitment%'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name).sort();
    expect(names).toEqual(['commitment_extraction_runs', 'commitments']);
    // The status CHECK is the storage-level enum closure: no `rescheduled`.
    expect(() =>
      db.prepare("INSERT INTO commitments(id, kind, subject, title, normalized_title, semantic_key, time_precision, source_message_id, created_at, updated_at, last_confirmed_at, status) VALUES ('x','user_event','user','t','t','k','day','m','t','t','t','rescheduled')").run()
    ).toThrow();
  });
});

describe('lexical matching tier', () => {
  it('merges containment and shared bigrams, rejects lookalikes', () => {
    expect(lexicalTitleScore('考试', '考试提醒')).toBe(1);
    expect(lexicalTitleScore('考数学', '数学考试')).toBeGreaterThanOrEqual(0.5);
    expect(lexicalTitleScore('考试', '面试')).toBe(0);
    // No shared bigram: this pair must fall through to the cosine tier.
    expect(lexicalTitleScore('考试', '考数学')).toBe(0);
  });

  it('builds semantic keys from kind, subject, normalized title and day', () => {
    expect(buildSemanticKey({ kind: 'user_event', subject: 'user', title: '考试', dueAt: EXAM_DAY })).toBe(
      'user_event:user:考试:2026-08-28'
    );
    expect(buildSemanticKey({ kind: 'follow_up', subject: 'user', title: 'PR 检查' })).toBe(
      'follow_up:user:pr 检查:undated'
    );
  });
});

describe('CommitmentRepo.ingest two-layer idempotency', () => {
  it('creates a pending row and derives the semantic key', () => {
    const r = repo();
    const { commitment, matched } = r.ingest(EXAM());
    expect(matched).toBeNull();
    expect(commitment.status).toBe('pending');
    expect(commitment.semanticKey).toBe('user_event:user:考试:2026-08-28');
    expect(commitment.normalizedTitle).toBe('考试');
    expect(r.countByStatus()).toEqual({ pending: 1 });
  });

  it('reinforces on an exact semantic_key hit instead of duplicating', () => {
    const r = repo();
    r.ingest(EXAM({ confidence: 0.6 }));
    const second = r.ingest(EXAM({ confidence: 0.9, sourceMessageId: 'msg_2' }));
    expect(second.matched).toBe('exact');
    const rows = r.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confidence).toBeCloseTo(0.9);
    expect(rows[0]!.sourceMessageId).toBe('msg_1');
  });

  it('merges lexically matched repeats ("周五考试" / "周五我有考试")', () => {
    const r = repo();
    r.ingest(EXAM({ title: '考试' }));
    const second = r.ingest(EXAM({ title: '考试提醒', sourceMessageId: 'msg_2' }));
    expect(second.matched).toBe('semantic');
    expect(r.list()).toHaveLength(1);
  });

  it('merges "考试" and "考数学" through the cosine tier when vectors exist', () => {
    const r = repo();
    const first = r.ingest(EXAM({ title: '考试', embedding: [1, 0], embeddingModel: 'test' })).commitment;
    const second = r.ingest(EXAM({ title: '考数学', embedding: [0.99, 0.141], embeddingModel: 'test' }));
    expect(second.matched).toBe('semantic');
    expect(second.commitment.id).toBe(first.id);
    expect(r.list()).toHaveLength(1);
  });

  it('keeps "考试" and "考数学" apart without vectors', () => {
    const r = repo();
    r.ingest(EXAM({ title: '考试' }));
    const second = r.ingest(EXAM({ title: '考数学' }));
    expect(second.matched).toBeNull();
    expect(r.list()).toHaveLength(2);
  });

  it('does not merge different events on the same day', () => {
    const r = repo();
    r.ingest(EXAM({ title: '考试' }));
    expect(r.ingest(EXAM({ title: '面试' })).matched).toBeNull();
    expect(r.list()).toHaveLength(2);
  });

  it('does not merge the same title across distant dates or kinds', () => {
    const r = repo();
    r.ingest(EXAM());
    expect(r.ingest(EXAM({ dueAt: '2026-09-11T09:00:00.000Z', sourceMessageId: 'msg_2' })).matched).toBeNull();
    expect(r.ingest(EXAM({ kind: 'shared_plan', sourceMessageId: 'msg_3' })).matched).toBeNull();
    expect(r.list()).toHaveLength(3);
  });
});

describe('CommitmentRepo lifecycle', () => {
  it('reschedules via supersede + new row, keeping the full chain', () => {
    const r = repo();
    const first = r.ingest(EXAM()).commitment;
    const { previous, replacement } = r.supersede(first.id, EXAM({ dueAt: '2026-09-04T09:00:00.000Z', sourceMessageId: 'msg_2' }));
    expect(previous.status).toBe('superseded');
    expect(previous.supersededById).toBe(replacement.id);
    expect(replacement.status).toBe('pending');
    expect(replacement.supersedesId).toBe(first.id);
    expect(r.supersedeChain(replacement.id).map((c) => c.id)).toEqual([first.id, replacement.id]);
    expect(() => r.supersede(first.id, EXAM())).toThrow(/already superseded/);
    expect(r.upcoming().map((c) => c.id)).toEqual([replacement.id]);
  });

  it('applies user-driven resolutions and rejects illegal jumps', () => {
    const r = repo();
    const c = r.ingest(EXAM()).commitment;
    const done = r.resolve(c.id, 'completed', { outcome: '考完了' });
    expect(done.status).toBe('completed');
    expect(done.completedAt).toBeTruthy();
    expect(done.outcome).toBe('考完了');
    expect(() => r.resolve(c.id, 'cancelled')).toThrow(/cannot move completed/);

    const c2 = r.ingest(EXAM({ title: '面试', dueAt: '2026-08-30T02:00:00.000Z' })).commitment;
    // Expiry is only reachable from tentative; there is no `rescheduled` target.
    expect(() => r.resolve(c2.id, 'expired')).toThrow(/cannot move pending/);
    expect(() => r.resolve(c2.id, 'rescheduled' as never)).toThrow();
  });

  it('confirms a tentative mention into a pending commitment', () => {
    const r = repo();
    const t = r.ingest(EXAM({ status: 'tentative', title: '去大阪', timePrecision: 'range' })).commitment;
    expect(t.status).toBe('tentative');
    expect(r.confirm(t.id).status).toBe('pending');
    expect(() => r.confirm(t.id)).toThrow(/cannot move pending/);
  });

  it('runs the time-driven state machine in one pass (§13)', () => {
    const r = repo();
    const NOW = '2026-08-31T12:00:00.000Z';
    const todayExam = r.ingest(EXAM({ title: '考试', dueAt: '2026-08-31T08:00:00.000Z' })).commitment;
    const reminder = r.ingest(
      EXAM({
        kind: 'reminder_request',
        title: '续费提醒',
        dueAt: '2026-08-30T08:00:00.000Z',
        latestReachOutAt: '2026-08-30T20:00:00.000Z',
        followUpPolicy: 'explicit_reminder'
      })
    ).commitment;
    const promise = r.ingest(
      EXAM({
        kind: 'assistant_commitment',
        subject: 'assistant',
        title: '问她结果',
        dueAt: '2026-08-29T08:00:00.000Z',
        latestReachOutAt: '2026-08-29T20:00:00.000Z',
        followUpPolicy: 'explicit_reminder'
      })
    ).commitment;
    const trip = r.ingest(
      EXAM({ status: 'tentative', title: '去大阪', dueAt: '2026-08-15T00:00:00.000Z', timePrecision: 'range' })
    ).commitment;
    const checkup = r.ingest(EXAM({ title: '体检', dueAt: '2026-08-26T00:00:00.000Z' })).commitment;
    const later = r.ingest(EXAM({ title: '旅行', dueAt: '2026-09-20T00:00:00.000Z' })).commitment;

    const outcome = r.applyTimeDrivenTransitions(NOW);
    expect(outcome).toEqual({ promotedDue: 4, missed: 2, expired: 1, archived: 1 });

    // Same-day due item stays current: context visibility ends with grace, not with due_at.
    expect(r.get(todayExam.id)!.status).toBe('due');
    expect(r.get(todayExam.id)!.archivedAt).toBeNull();
    expect(r.get(reminder.id)!.status).toBe('missed');
    expect(r.get(promise.id)!.status).toBe('missed');
    expect(r.get(trip.id)!.status).toBe('expired');
    expect(r.get(checkup.id)!.status).toBe('due');
    expect(r.get(checkup.id)!.archivedAt).toBeTruthy();
    expect(r.get(later.id)!.status).toBe('pending');

    const visible = r.upcoming();
    expect(visible.map((c) => c.id)).toEqual([todayExam.id, later.id]);
  });

  it('archives manually without touching status history', () => {
    const r = repo();
    const c = r.ingest(EXAM()).commitment;
    expect(r.archive(c.id)).toBe(true);
    expect(r.archive(c.id)).toBe(false);
    const row = r.get(c.id)!;
    expect(row.status).toBe('pending');
    expect(row.archivedAt).toBeTruthy();
    expect(r.upcoming()).toHaveLength(0);
  });
});

describe('extraction fence and admin edits', () => {
  it('claims each (message, extractor version) pair exactly once', () => {
    const r = repo();
    expect(r.claimExtraction('msg_9', '1')).toBe(true);
    expect(r.claimExtraction('msg_9', '1')).toBe(false);
    expect(r.claimExtraction('msg_9', '2')).toBe(true);
    expect(r.claimExtraction('msg_10', '1')).toBe(true);
  });

  it('recomputes the semantic key when the edit moves the date', () => {
    const r = repo();
    const c = r.ingest(EXAM()).commitment;
    const moved = r.update(c.id, { dueAt: '2026-09-04T09:00:00.000Z' })!;
    expect(moved.semanticKey).toBe('user_event:user:考试:2026-09-04');
    // The moved key is now free for a fresh mention of the original day.
    expect(r.ingest(EXAM({ sourceMessageId: 'msg_2' })).matched).toBeNull();
  });
});
