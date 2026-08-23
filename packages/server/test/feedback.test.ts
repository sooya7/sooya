import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/index.js';
import { InteractionOutcomeRepo } from '../src/db/repos/interaction-outcome.repo.js';
import { FeedbackService } from '../src/core/feedback/service.js';
import { MessageRepo } from '../src/db/repos/message.repo.js';
import { ProactiveAttemptRepo } from '../src/db/repos/proactive.repo.js';
import { MediaTextRepo } from '../src/db/repos/media-text.repo.js';

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

function service(opts: { learningEnabled?: boolean; clock?: () => Date } = {}): {
  svc: FeedbackService;
  outcomes: InteractionOutcomeRepo;
  attempts: ProactiveAttemptRepo;
  messages: MessageRepo;
  db: Database.Database;
} {
  const db = new Database(':memory:');
  open.push(db);
  migrate(db);
  const outcomes = new InteractionOutcomeRepo(db);
  const attempts = new ProactiveAttemptRepo(db);
  const messages = new MessageRepo(db, new MediaTextRepo(db));
  return {
    svc: new FeedbackService({ outcomes, attempts, messages, learningEnabled: opts.learningEnabled ?? true, clock: opts.clock }),
    outcomes,
    attempts,
    messages,
    db
  };
}

describe('FeedbackService (§22-26)', () => {
  it('derives outcomes from sent attempts and user replies', () => {
    const { svc, attempts, db } = service();
    attempts.create({ candidateId: 'commitment:c1', candidateKind: 'user_event', candidateActivity: '面试', requestedMode: 'text', status: 'sent', sendSuccess: true });
    attempts.create({ candidateId: 'life:l1', candidateKind: 'out', candidateActivity: '看猫', requestedMode: 'text', status: 'sent', sendSuccess: true });
    // Attempts are stamped with the real clock; pin them to the scenario time.
    db.prepare("UPDATE proactive_attempts SET created_at = '2026-08-21T05:50:00.000Z' WHERE candidate_id = 'commitment:c1'").run();
    db.prepare("UPDATE proactive_attempts SET created_at = '2026-08-21T05:55:00.000Z' WHERE candidate_id = 'life:l1'").run();

    const insert = db.prepare(
      `INSERT INTO messages (id, conversation_id, role, created_at, updated_at, seq, status, meta_json)
       VALUES (?, 'main', 'user', ?, ?, 1, 'sent', '{}')`
    );
    // 05:52 lands inside c1's [05:50, 05:55) window; l1 gets no reply.
    insert.run('u1', '2026-08-21T05:52:00.000Z', '2026-08-21T05:52:00.000Z');
    db.prepare(
      `INSERT INTO message_parts (id, message_id, idx, type, text, status) VALUES ('p1', 'u1', 0, 'text', '谢谢你提醒！', 'sent')`
    ).run();

    const outcome = svc.sweep(new Date('2026-08-22T12:00:00.000Z'));
    expect(outcome.recorded).toBe(2);
    const profile = svc.profile(new Date('2026-08-22T12:00:00.000Z'));
    const commitment = profile.stats.find((s) => s.kind === 'commitment')!;
    expect(commitment.samples).toBe(1);
    expect(commitment.replyRate).toBe(1);
    const life = profile.stats.find((s) => s.kind === 'life')!;
    expect(life.replyRate).toBe(0);
  });

  it('clamps learned weights into [0.7, 1.3] and stays neutral below 5 samples', () => {
    const { svc, outcomes } = service();
    // One ignored send of an unrelated kind: a single sample must stay neutral.
    outcomes.insert({
      source_type: 'proactive', source_id: 'a1', proactive_kind: 'sticker', media_kind: 'sticker',
      sent_at: '2026-08-21T06:00:00.000Z', user_replied: 0, reply_latency_ms: null, reply_length: null,
      continued_turns: 0, score: 0
    });
    expect(svc.weightFor('sticker', new Date('2026-08-22T12:00:00.000Z'))).toBe(1);

    for (let i = 0; i < 20; i++) {
      outcomes.insert({
        source_type: 'proactive', source_id: `ok-${i}`, proactive_kind: 'life', media_kind: 'none',
        sent_at: '2026-08-21T07:00:00.000Z', user_replied: 1, reply_latency_ms: 60_000, reply_length: 20,
        continued_turns: 3, score: 1.75
      });
    }
    for (let i = 0; i < 20; i++) {
      outcomes.insert({
        source_type: 'proactive', source_id: `ig-${i}`, proactive_kind: 'image', media_kind: 'image',
        sent_at: '2026-08-21T08:00:00.000Z', user_replied: 0, reply_latency_ms: null, reply_length: null,
        continued_turns: 0, score: 0
      });
    }
    expect(svc.weightFor('life', new Date('2026-08-22T12:00:00.000Z'))).toBeCloseTo(1.3);
    // A fully ignored behaviour softens to 0.7 — but never to zero (§26 禁止永久屏蔽).
    expect(svc.weightFor('image', new Date('2026-08-22T12:00:00.000Z'))).toBeCloseTo(0.7);
  });

  it('applies no learning at all when the flag is off', () => {
    const { svc, outcomes } = service({ learningEnabled: false });
    for (let i = 0; i < 10; i++) {
      outcomes.insert({
        source_type: 'proactive', source_id: `x-${i}`, proactive_kind: 'life', media_kind: 'none',
        sent_at: '2026-08-21T09:00:00.000Z', user_replied: 0, reply_latency_ms: null, reply_length: null,
        continued_turns: 0, score: 0
      });
    }
    expect(svc.weightFor('life', new Date('2026-08-22T12:00:00.000Z'))).toBe(1);
  });

  it('resets learned preferences on demand', () => {
    const { svc, outcomes } = service();
    outcomes.insert({
      source_type: 'proactive', source_id: 'r1', proactive_kind: 'life', media_kind: 'none',
      sent_at: '2026-08-21T06:00:00.000Z', user_replied: 1, reply_latency_ms: 1000, reply_length: 5,
      continued_turns: 1, score: 1.25
    });
    expect(svc.reset()).toBe(1);
    expect(svc.profile(new Date('2026-08-22T12:00:00.000Z')).stats).toHaveLength(0);
  });
});
