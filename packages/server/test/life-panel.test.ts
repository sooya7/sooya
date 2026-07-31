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

/**
 * A user message at a known distance from the pinned engine clock.
 *
 * `messages.create` always stamps wall-clock now, so the gap the engine sees
 * was "pinned clock minus real now" -- a number that depends on what time of
 * day the suite runs, and goes negative after 17:30 Beijing. The quiet-gap
 * assertions then measured the clock instead of the panel. Backdating the row
 * makes the distance the test's own choice.
 */
function userMessageMinutesAgo(h: Harness, minutes: number, text: string): void {
  const { message } = h.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text }] });
  const stamp = new Date(pinnedNow.getTime() - minutes * 60_000).toISOString();
  h.app.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(stamp, message.id);
}

async function get(h: Harness, url: string) {
  const res = await h.app.server.inject({ method: 'GET', url, headers: ADMIN });
  return { res, body: res.json() as any };
}

async function put(h: Harness, url: string, payload: unknown) {
  const res = await h.app.server.inject({ method: 'PUT', url, payload, headers: ADMIN });
  return { res, body: res.json() as any };
}

/**
 * The reason she is silent is the whole point of this endpoint. Before it, the
 * only observable was "no message", which looks the same whether she is capped,
 * asleep, or has nothing finished worth mentioning.
 */
describe('life panel', () => {
  it('reports what she is doing, her log and why she has not spoken', async () => {
    const h = await panelHarness();
    const { res, body } = await get(h, '/api/admin/life');
    expect(res.statusCode).toBe(200);
    expect(body.snapshot.activity).toBeTruthy();
    expect(body.snapshot.mood).toBeTruthy();
    expect(Array.isArray(body.log)).toBe(true);
    // Nothing has finished yet in a fresh install, so that is the honest reason.
    expect(body.reachOut.reason).toBe('nothing_worth_saying');
    expect(body.reachOut.enabledByDeployment).toBe(true);
    expect(body.settings).toMatchObject({ reachOut: true, quietGapMinutes: expect.any(Number), maxReachOutsPerDay: expect.any(Number) });
  });

  it('names the user as the reason while she is still inside the quiet gap', async () => {
    const h = await panelHarness({ LIFE_QUIET_GAP_MINUTES: '60' });
    userMessageMinutesAgo(h, 10, '在吗');
    const { body } = await get(h, '/api/admin/life');
    expect(body.reachOut.reason).toBe('user_was_recently_here');
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
    // Fields left alone keep following the env default instead of being frozen.
    expect(body.lifePolicy.silentFrom).toBeUndefined();
    const after = await get(h, '/api/admin/life');
    expect(after.body.settings.quietGapMinutes).toBe(30);
  });

  it('applies a changed quiet gap to the live decision without a restart', async () => {
    // The message sits 60 minutes back: inside a 1440-minute gap, outside a
    // 30-minute one. Lowering the setting must flip the answer on the next read.
    const h = await panelHarness({ LIFE_QUIET_GAP_MINUTES: '1440' });
    userMessageMinutesAgo(h, 60, '我去洗澡');
    const before = await get(h, '/api/admin/life');
    expect(before.body.reachOut.reason).toBe('user_was_recently_here');
    await put(h, '/api/admin/life/settings', { quietGapMinutes: 30 });
    const after = await get(h, '/api/admin/life');
    expect(after.body.reachOut.reason).not.toBe('user_was_recently_here');
  });

  it('lets the panel switch reach-out off, and reports it as the reason', async () => {
    const h = await panelHarness();
    await put(h, '/api/admin/life/settings', { reachOut: false });
    const { body } = await get(h, '/api/admin/life');
    expect(body.settings.reachOut).toBe(false);
    expect(body.reachOut.reason).toBe('disabled');
    // The deployment switch is still reported as on: the panel is the one saying no.
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
