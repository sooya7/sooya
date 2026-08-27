import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/index.js';
import { RelationshipThreadRepo } from '../src/db/repos/relationship-thread.repo.js';
import { RelationshipContextService, RelationshipService } from '../src/core/relationship/service.js';
import { SALIENCE_HALFLIFE_DAYS } from '../src/core/relationship/types.js';

const open: Database.Database[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});

/** Sunday 2026-08-23 local noon. */
const NOW = new Date('2026-08-23T04:00:00.000Z');

function service(clock = () => NOW): {
  svc: RelationshipService;
  ctx: RelationshipContextService;
  repo: RelationshipThreadRepo;
} {
  const db = new Database(':memory:');
  open.push(db);
  migrate(db);
  const repo = new RelationshipThreadRepo(db);
  return {
    svc: new RelationshipService({ repo, clock }),
    ctx: new RelationshipContextService({ repo, clock }),
    repo
  };
}

describe('RelationshipService.consume (§13/§14 contract)', () => {
  it('opens a thread on first signal and touches on the repeat', async () => {
    const { svc, repo } = service();
    const first = await svc.consume(
      { relationship_signals: [{ kind: 'shared_experience', title: '一起调试 SOOYA', summary: '你们这几天都在排查线上问题', confidence: 0.8 }], relationship_resolutions: [] },
      { messageId: 'm1' }
    );
    expect(first.opened).toBe(1);
    const second = await svc.consume(
      { relationship_signals: [{ kind: 'shared_experience', title: '一起调试 SOOYA', summary: '用户还会继续反馈表现', confidence: 0.85 }], relationship_resolutions: [] },
      { messageId: 'm2' }
    );
    expect(second.touched).toBe(1);
    const threads = repo.list();
    expect(threads).toHaveLength(1);
    expect(threads[0]!.summary).toBe('用户还会继续反馈表现');
    expect(threads[0]!.lastMessageId).toBe('m2');
  });

  it('joins a similar thread only above the frozen threshold (§3)', async () => {
    const { svc, repo } = service();
    await svc.consume(
      { relationship_signals: [{ kind: 'open_topic', title: '装修方案', summary: null, confidence: 0.8 }], relationship_resolutions: [] },
      { messageId: 'm1' }
    );
    // Different topic, same kind: no shared entities → new thread.
    const second = await svc.consume(
      { relationship_signals: [{ kind: 'open_topic', title: '旅行计划', summary: null, confidence: 0.8 }], relationship_resolutions: [] },
      { messageId: 'm2' }
    );
    expect(second.opened).toBe(1);
    expect(repo.list()).toHaveLength(2);
  });

  it('joins via embedding cosine when titles differ', async () => {
    const db = new Database(':memory:');
    open.push(db);
    migrate(db);
    const repo = new RelationshipThreadRepo(db);
    const clock = () => NOW;
    // "一起调试 SOOYA" and "一起排查线上问题" share a vector direction.
    const vectors: number[][] = [[1, 0], [0.99, 0.1]];
    let call = 0;
    const svc = new RelationshipService({
      repo,
      clock,
      embed: async () => ({ vectors: [vectors[Math.min(call++, 1)]!], model: 'mock' })
    });
    const first = await svc.consume(
      { relationship_signals: [{ kind: 'shared_experience', title: '一起调试 SOOYA', summary: null, confidence: 0.8 }], relationship_resolutions: [] },
      { messageId: 'm1' }
    );
    expect(first.opened).toBe(1);
    const second = await svc.consume(
      { relationship_signals: [{ kind: 'shared_experience', title: '一起排查线上问题', summary: null, confidence: 0.8 }], relationship_resolutions: [] },
      { messageId: 'm2' }
    );
    // cosine((1,0),(0.99,0.1)) ≈ 0.995 → 0.5*0.995 + recency 1*0.2 + kind 0.1 > 0.62.
    expect(second.touched).toBe(1);
    expect(repo.list()).toHaveLength(1);
  });

  it('resolves via analyzer resolutions and counts a reopen', async () => {
    const { svc, repo } = service();
    await svc.consume(
      { relationship_signals: [{ kind: 'unresolved_issue', title: '上次误会', summary: '解释过但情绪未完全过去', confidence: 0.9 }], relationship_resolutions: [] },
      { messageId: 'm1' }
    );
    const thread = repo.list()[0]!;
    const closed = await svc.consume(
      { relationship_signals: [], relationship_resolutions: [{ thread_id: thread.id, action: 'completed', confidence: 0.95 }] },
      { messageId: 'm2' }
    );
    expect(closed.resolved).toBe(1);
    expect(repo.get(thread.id)!.status).toBe('resolved');
    // Reopening bumps reopenCount and clears resolvedAt.
    repo.touch(thread.id);
    const reopened = repo.get(thread.id)!;
    expect(reopened.status).toBe('open');
    expect(reopened.reopenCount).toBe(1);
  });
});

describe('salience decay per kind (§4)', () => {
  it('cools and archives on distinct schedules, never one TTL', () => {
    // RelationshipThreadRepo timestamps direct creates from the wall clock.
    // Pin it to the same fixture clock used by RelationshipService so this test
    // remains a five-day decay test instead of drifting as real time advances.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { repo, svc } = service();
    repo.create({ kind: 'ongoing_joke', title: '猫猫梗', messageId: 'm1' });
    repo.create({ kind: 'unresolved_issue', title: '大事', messageId: 'm1' });

    // 5 days: the joke (3d halflife) has decayed hard; the issue (21d) is fine.
    const after5 = svc.tick(new Date(NOW.getTime() + 5 * 86_400_000));
    expect(after5.cooling).toBe(1);
    const joke = repo.list().find((t) => t.title === '猫猫梗')!;
    expect(joke.status).toBe('cooling');

    // 60 days without a touch: everything archives, at its own pace.
    const after60 = svc.tick(new Date(NOW.getTime() + 60 * 86_400_000));
    expect(after60.archived).toBe(2);
    expect(SALIENCE_HALFLIFE_DAYS.unresolved_issue).toBeGreaterThan(SALIENCE_HALFLIFE_DAYS.ongoing_joke);
  });
});

describe('RelationshipContextService (§18)', () => {
  it('renders open salient threads and hides cooling/resolved ones', () => {
    const { ctx, repo } = service();
    repo.create({ kind: 'unresolved_issue', title: '上次误会', summary: '解释过但情绪未完全过去', messageId: 'm1' });
    const cooling = repo.create({ kind: 'open_topic', title: '装修', messageId: 'm1', salience: 0.3 });
    void cooling;
    const resolved = repo.create({ kind: 'shared_interest', title: '爵士乐', messageId: 'm1' });
    repo.resolve(resolved.id);
    const lines = ctx.contextLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('上次误会');
    expect(lines[0]).toContain('不要每轮都提');
  });
});