import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/index.js';
import { CommitmentRepo } from '../src/db/repos/commitment.repo.js';
import { FutureContextService } from '../src/core/future/context.js';
import { createHarness, type Harness } from './helpers/harness.js';

const TZ = 'Asia/Shanghai';
/** Saturday, 2026-08-22 15:30 local. */
const NOW = new Date('2026-08-22T07:30:00.000Z');

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

function service(clock = () => NOW): { svc: FutureContextService; repo: CommitmentRepo } {
  const db = new Database(':memory:');
  open.push(db);
  migrate(db);
  const repo = new CommitmentRepo(db);
  return { svc: new FutureContextService({ repo, timeZone: TZ, clock }), repo };
}

describe('FutureContextService rendering (§9)', () => {
  it('renders the plan examples for each kind', () => {
    const { svc, repo } = service();
    repo.ingest({ kind: 'user_event', subject: 'user', title: '考试', dueAt: '2026-08-23T16:00:00.000Z', timePrecision: 'day', sourceMessageId: 'm1', timeZone: TZ });
    repo.ingest({ kind: 'shared_plan', subject: 'shared', title: '挑电影', dueAt: '2026-08-22T15:59:00.000Z', timePrecision: 'day', sourceMessageId: 'm1', timeZone: TZ });
    repo.ingest({ kind: 'follow_up', subject: 'user', title: 'pr 检查', timePrecision: 'unknown', sourceMessageId: 'm1', timeZone: TZ });
    const lines = svc.contextLines();
    expect(lines).toContain('- 用户周一有考试，还有 2 天。');
    expect(lines).toContain('- 你们说好今天一起挑电影。');
    expect(lines).toContain('- 用户要跟进「pr 检查」，尚未确认完成。');
  });

  it('renders exact reminders with a clock time', () => {
    const { svc, repo } = service();
    repo.ingest({
      kind: 'reminder_request',
      subject: 'user',
      title: '续费提醒',
      startsAt: '2026-08-23T01:00:00.000Z',
      dueAt: '2026-08-23T01:00:00.000Z',
      timePrecision: 'exact',
      sourceMessageId: 'm1',
      followUpPolicy: 'explicit_reminder',
      timeZone: TZ
    });
    expect(svc.contextLines()).toEqual(['- 用户让你提醒：续费提醒（明天 09:00）。']);
  });

  it('hides completed, missed and archived rows', () => {
    const { svc, repo } = service();
    const exam = repo.ingest({ kind: 'user_event', subject: 'user', title: '考试', dueAt: '2026-08-27T16:00:00.000Z', timePrecision: 'day', sourceMessageId: 'm1', timeZone: TZ }).commitment;
    const missed = repo.ingest({ kind: 'reminder_request', subject: 'user', title: '续费', dueAt: '2026-08-20T12:00:00.000Z', latestReachOutAt: '2026-08-20T14:00:00.000Z', timePrecision: 'exact', followUpPolicy: 'explicit_reminder', sourceMessageId: 'm1', timeZone: TZ }).commitment;
    repo.resolve(exam.id, 'completed', { outcome: '考完了' });
    repo.applyTimeDrivenTransitions(NOW.toISOString()); // reminder is past its window → missed
    expect(repo.get(missed.id)!.status).toBe('missed');
    expect(svc.contextLines()).toEqual([]);
  });
});

describe('ContextBuilder integration (§10/§11)', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.cleanup();
  });

  const options = {
    recentMessages: 10,
    memoryLimit: 8,
    allowVision: false,
    stickerCatalogue: '',
    voiceMoods: '',
    capabilityNotes: [],
    contextWindow: 8_000,
    maxOutputTokens: 1_000
  };

  it('injects the future section and suppresses memory lines that restate it (§10.4)', async () => {
    h = await createHarness({ embedding: 'off', env: { FUTURE_ENGINE_ENABLED: 'true' } });
    // An exam two days out; the future line names its weekday, which the
    // restating memory echoes — that shared entity is what makes the pair a
    // duplicate regardless of the real clock the test runs under.
    const target = new Date(Date.now() + 2 * 86_400_000);
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][target.getDay()];
    h.app.repos.commitments.ingest({
      kind: 'user_event',
      subject: 'user',
      title: '考试',
      startsAt: target.toISOString(),
      dueAt: target.toISOString(),
      timePrecision: 'day',
      sourceMessageId: 'seed',
      timeZone: h.app.env.LIFE_TIME_ZONE
    });
    const restating = h.app.repos.memories.upsert({ kind: 'project', content: `用户最近很重视${weekday}的考试`, sourceMessageId: 'seed' }).record;

    const built = await h.app.services.context.build(h.app.config.getPersona(), '考试加油', options);
    expect(built.system).toContain('接下来值得记得的事情');
    expect(built.futureLines).toBe(1);
    // §10.4: exactly one current statement of the exam fact — the Future
    // line. The restating memory was recalled but suppressed, not injected.
    expect(built.system.match(/有考试/g)).toHaveLength(1);
    expect(built.futureDedupedMemories).toBe(1);
    expect(built.memoryTrace.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: restating.id, droppedReason: 'deduplicated_future' })])
    );
  });

  it('stays completely dark when the flag is off', async () => {
    h = await createHarness({ embedding: 'off', env: { FUTURE_ENGINE_ENABLED: 'false' } });
    h.app.repos.commitments.ingest({
      kind: 'user_event',
      subject: 'user',
      title: '考试',
      dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      timePrecision: 'day',
      sourceMessageId: 'seed'
    });
    const built = await h.app.services.context.build(h.app.config.getPersona(), '你好', options);
    expect(built.system).not.toContain('接下来值得记得的事情');
    expect(built.futureLines).toBe(0);
  });

  it('exposes admin inspect endpoints for commitments', async () => {
    h = await createHarness({ env: { FUTURE_ENGINE_ENABLED: 'true' } });
    const headers = { 'x-admin-token': 'test-admin-token' };
    const created = h.app.repos.commitments.ingest({
      kind: 'user_event',
      subject: 'user',
      title: '考试',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      timePrecision: 'day',
      sourceMessageId: 'seed',
      timeZone: h.app.env.LIFE_TIME_ZONE
    }).commitment;

    const list = await h.app.server.inject({ method: 'GET', url: '/api/admin/future/commitments', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().commitments).toHaveLength(1);
    expect(list.json().counts.pending).toBe(1);

    const contextLines = await h.app.server.inject({ method: 'GET', url: '/api/admin/future/context', headers });
    expect(contextLines.statusCode).toBe(200);
    expect(contextLines.json().lines[0]).toContain('考试');

    const resolve = await h.app.server.inject({
      method: 'POST',
      url: `/api/admin/future/commitments/${created.id}/resolve`,
      headers,
      payload: { action: 'completed', outcome: 'admin 修正' }
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().commitment.status).toBe('completed');

    const after = await h.app.server.inject({ method: 'GET', url: '/api/admin/future/commitments?status=completed', headers });
    expect(after.json().commitments).toHaveLength(1);

    const unauthorized = await h.app.server.inject({ method: 'GET', url: '/api/admin/future/commitments' });
    expect(unauthorized.statusCode).toBe(401);
  });
});
