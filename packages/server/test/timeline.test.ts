import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.cleanup();
  h = null;
});

function seedMessage(harness: Harness, text: string, atIso: string): string {
  const { message } = harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text }] });
  harness.app.db.raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(atIso, message.id);
  return message.id;
}

describe('TimelineService episode building (§22)', () => {
  it('groups a same-topic burst into one episode and closes it on 3h silence', async () => {
    h = await createHarness({ env: { TIMELINE_ENABLED: 'true' }, clock: () => new Date('2026-08-21T14:00:00.000Z') });
    const repo = h.app.repos.episodes;
    seedMessage(h, '这次 SOOYA 的新功能我觉得可以再调一下', '2026-08-21T05:20:00.000Z');
    seedMessage(h, '对，主动消息的频率也可以看看', '2026-08-21T05:26:00.000Z');
    seedMessage(h, '我晚上再整理一下反馈给你', '2026-08-21T05:31:00.000Z');

    const first = await await h.app.services.timeline.sweep(new Date('2026-08-21T06:00:00.000Z'));
    expect(first.opened).toBe(1);
    expect(first.attached).toBe(3);
    expect(repo.openRows()).toHaveLength(1);

    // Four hours later: silence closes the episode with a heuristic title.
    const second = await h.app.services.timeline.sweep(new Date('2026-08-21T10:00:00.000Z'));
    expect(second.closed).toBe(1);
    expect(repo.openRows()).toHaveLength(0);
    const episodes = repo.listByDateRange('2026-08-21', '2026-08-21');
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.messageIds).toHaveLength(3);
  });

  it('starts a new episode on a clear topic switch', async () => {
    h = await createHarness({ env: { TIMELINE_ENABLED: 'true' }, clock: () => new Date('2026-08-21T14:00:00.000Z') });
    const repo = h.app.repos.episodes;
    seedMessage(h, '猫今天又把水杯碰倒了，气死我了', '2026-08-21T05:20:00.000Z');
    seedMessage(h, '那只猫真的太能闹了', '2026-08-21T05:25:00.000Z');
    seedMessage(h, '明天的火车票帮我看看几点出发合适', '2026-08-21T05:30:00.000Z');

    await h.app.services.timeline.sweep(new Date('2026-08-21T06:00:00.000Z'));
    const episodes = repo.listByDateRange('2026-08-21', '2026-08-21');
    expect(episodes.length).toBeGreaterThanOrEqual(2);
  });

  it('records an important completed commitment as a milestone episode', async () => {
    h = await createHarness({ env: { TIMELINE_ENABLED: 'true' }, clock: () => new Date('2026-08-21T14:00:00.000Z') });
    const repo = h.app.repos.episodes;
    const exam = h.app.repos.commitments.ingest({
      kind: 'user_event',
      subject: 'user',
      title: '考试',
      dueAt: '2026-08-20T16:00:00.000Z',
      timePrecision: 'day',
      importance: 0.9,
      sourceMessageId: 'seed',
      timeZone: h.app.env.LIFE_TIME_ZONE
    }).commitment;
    h.app.repos.commitments.resolve(exam.id, 'completed', { at: '2026-08-21T08:00:00.000Z', outcome: '考完了' });

    const outcome = await h.app.services.timeline.sweep(new Date('2026-08-21T14:00:00.000Z'));
    expect(outcome.milestones).toBe(1);
    const milestone = repo.listByDateRange('2026-08-21', '2026-08-21').find((e) => e.kind === 'milestone');
    expect(milestone?.title).toContain('考试');
    expect(milestone?.commitmentIds).toContain(exam.id);
    // Idempotent: a second sweep must not duplicate the milestone.
    const again = await h.app.services.timeline.sweep(new Date('2026-08-21T15:00:00.000Z'));
    expect(again.milestones).toBe(0);
  });

  it('stays completely dark when the flag is off', async () => {
    h = await createHarness({ clock: () => new Date('2026-08-21T14:00:00.000Z') });
    seedMessage(h, '随便聊聊', '2026-08-21T05:20:00.000Z');
    const outcome = await h.app.services.timeline.sweep(new Date('2026-08-21T06:00:00.000Z'));
    expect(outcome).toEqual({ closed: 0, opened: 0, attached: 0, milestones: 0 });
    expect(h.app.repos.episodes.listByDateRange('2026-08-01', '2026-08-31')).toHaveLength(0);
  });

  it('exposes admin timeline endpoints', async () => {
    h = await createHarness({ env: { TIMELINE_ENABLED: 'true', ADMIN_API_TOKEN: 'test-admin-token' } });
    seedMessage(h, '一起看新出的那部剧', '2026-08-21T05:20:00.000Z');
    await h.app.services.timeline.sweep(new Date('2026-08-21T06:00:00.000Z'));
    h.app.services.timeline.sweep(new Date('2026-08-21T12:00:00.000Z'));
    const list = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/timeline/episodes?from=2026-08-21&to=2026-08-21',
      headers: { 'x-admin-token': 'test-admin-token' }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().episodes.length).toBeGreaterThanOrEqual(1);
  });
});
