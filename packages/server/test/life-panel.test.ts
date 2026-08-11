import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

const ADMIN = { 'x-admin-token': 'admin-test-token' };

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

let pinnedNow = localTime('2026-07-31T17:30');

async function panelHarness(env: Record<string, string> = {}, at = '2026-07-31T17:30'): Promise<Harness> {
  pinnedNow = localTime(at);
  harness = await createHarness({
    env: { ADMIN_API_TOKEN: 'admin-test-token', ENABLE_LIFE_ENGINE: 'true', ENABLE_LIFE_REACH_OUT: 'true', ENABLE_BACKGROUND_JOBS: 'false', ...env },
    startWorkers: false,
    clock: () => localTime(at)
  });
  return harness;
}

/** A user message at a known distance from the pinned engine clock. */
function userMessageMinutesAgo(h: Harness, minutes: number, text: string): void {
  const { message } = h.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text }] });
  const stamp = new Date(pinnedNow.getTime() - minutes * 60_000).toISOString();
  h.app.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(stamp, message.id);
}

function stageShareableCandidate(h: Harness): void {
  h.app.repos.life.advance({
    activity: '去公园看猫', kind: 'out', mood: '好奇',
    startedAt: localTime('2026-07-31T14:00').toISOString(),
    endsAt: localTime('2026-07-31T17:00').toISOString()
  });
  h.app.repos.life.advance({
    activity: '练琴', kind: 'play', mood: '专注',
    startedAt: localTime('2026-07-31T17:00').toISOString(),
    endsAt: localTime('2026-07-31T18:00').toISOString()
  });
}

async function get(h: Harness, url: string) {
  const res = await h.app.server.inject({ method: 'GET', url, headers: ADMIN });
  return { res, body: res.json() as any };
}

async function put(h: Harness, url: string, payload: unknown) {
  const res = await h.app.server.inject({ method: 'PUT', url, payload, headers: ADMIN });
  return { res, body: res.json() as any };
}

/** The panel explains why a Life event is or is not ready for Moments. */
describe('life panel', () => {
  it('reports what she is doing, her log and why there is no Moment to publish yet', async () => {
    const h = await panelHarness();
    const { res, body } = await get(h, '/api/admin/life');
    expect(res.statusCode).toBe(200);
    expect(body.snapshot.activity).toBeTruthy();
    expect(body.snapshot.mood).toBeTruthy();
    expect(Array.isArray(body.log)).toBe(true);
    expect(body.reachOut.reason).toBe('nothing_worth_saying');
    expect(body.reachOut.enabledByDeployment).toBe(true);
    expect(body.settings).toMatchObject({ reachOut: true, quietGapMinutes: expect.any(Number), maxReachOutsPerDay: expect.any(Number) });
  });

  it('reports recent chat activity without using it as a Moments blocker', async () => {
    const h = await panelHarness({ LIFE_QUIET_GAP_MINUTES: '60' });
    userMessageMinutesAgo(h, 10, '在吗');
    const { body } = await get(h, '/api/admin/life');
    expect(body.reachOut.reason).toBe('nothing_worth_saying');
    expect(body.reachOut.lastUserAt).toBeTruthy();
  });

  it('says silent_hours during the hours she is asleep', async () => {
    const h = await panelHarness({}, '2026-07-31T03:00');
    const { body } = await get(h, '/api/admin/life');
    expect(body.reachOut.reason).toBe('silent_hours');
  });

  it('persists panel settings over the deployment defaults', async () => {
    const h = await panelHarness({ LIFE_QUIET_GAP_MINUTES: '180', LIFE_MAX_REACH_OUTS_PER_DAY: '3' });
    const { res, body } = await put(h, '/api/admin/life/settings', { quietGapMinutes: 30, maxReachOutsPerDay: 8 });
    expect(res.statusCode).toBe(200);
    expect(body.settings).toMatchObject({ quietGapMinutes: 30, maxReachOutsPerDay: 8 });
    expect(body.lifePolicy.silentFrom).toBeUndefined();
    const after = await get(h, '/api/admin/life');
    expect(after.body.settings.quietGapMinutes).toBe(30);
  });

  it('applies a changed Moments gap to the live decision without a restart', async () => {
    const h = await panelHarness({ LIFE_QUIET_GAP_MINUTES: '1440' });
    stageShareableCandidate(h);
    h.app.repos.moments.create({
      candidateId: 'old-breakfast-moment',
      text: '早些时候的早餐意外地很好吃。',
      activity: '吃早餐',
      createdAt: new Date(pinnedNow.getTime() - 60 * 60_000).toISOString()
    });

    const before = await get(h, '/api/admin/life');
    expect(before.body.reachOut.reason).toBe('moment_gap');

    await put(h, '/api/admin/life/settings', { quietGapMinutes: 30 });
    const after = await get(h, '/api/admin/life');
    expect(after.body.reachOut.reason).toBe('ok');
  });

  it('lets the panel switch Moments publishing off, and reports it as the reason', async () => {
    const h = await panelHarness();
    await put(h, '/api/admin/life/settings', { reachOut: false });
    const { body } = await get(h, '/api/admin/life');
    expect(body.settings.reachOut).toBe(false);
    expect(body.reachOut.reason).toBe('disabled');
    expect(body.reachOut.enabledByDeployment).toBe(true);
  });

  it('treats a zero daily cap as off rather than dividing by it', async () => {
    const h = await panelHarness();
    await put(h, '/api/admin/life/settings', { maxReachOutsPerDay: 0 });
    const { body } = await get(h, '/api/admin/life');
    expect(body.reachOut.reason).toBe('daily_cap');
  });

  it('rejects out-of-range settings instead of storing nonsense', async () => {
    const h = await panelHarness();
    const { res } = await put(h, '/api/admin/life/settings', { silentFrom: 26 });
    expect(res.statusCode).toBe(400);
    const { body } = await get(h, '/api/admin/life');
    expect(body.settings.silentFrom).toBe(0);
  });

  it('keeps both endpoints behind the admin guard', async () => {
    const h = await panelHarness();
    const read = await h.app.server.inject({ method: 'GET', url: '/api/admin/life' });
    const write = await h.app.server.inject({ method: 'PUT', url: '/api/admin/life/settings', payload: { reachOut: false } });
    expect(read.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);
  });
});
