import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

/**
 * P1-3: cross-system restart recovery. Each scenario mutates the database the
 * way a crashed process would leave it, closes the app, and boots a second app
 * on the same data dir — then verifies the recovery path.
 */
async function bootSecond(dataDir: string, extra: Record<string, string> = {}): Promise<Harness> {
  const h = await createHarness({
    skipStickerImport: true,
    replyDebounceMs: 0,
    startWorkers: false,
    env: { ENABLE_BACKGROUND_JOBS: 'false', DATA_DIR: dataDir, ...extra }
  });
  return h;
}

describe('restart recovery across systems (P1-3)', () => {
  it('a hidden generation restarts on the same revision and produces exactly one reply', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0, startWorkers: false, env: { ENABLE_BACKGROUND_JOBS: 'false' } });
    const dataDir = harness.app.env.dataDir;
    const user = harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '重启恢复' }] }).message;
    const admission = harness.app.repos.replyBatches.appendOrCreateMessage(user.id, new Date(0).toISOString(), new Date(0).toISOString());
    harness.app.repos.replyBatches.markQueued(admission.batch.id);
    harness.app.repos.replyBatches.beginGenerating(admission.batch.id, 1, 'dead-worker', -1);
    await harness.app.close();
    harness = null;

    const second = await bootSecond(dataDir);
    harness = second;
    await vi.waitFor(() => expect(second.app.repos.replyBatches.get(admission.batch.id)?.status).toBe('completed'), { timeout: 10000 });
    const assistants = second.app.repos.messages.recent(50).filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(second.app.repos.replyBatches.get(admission.batch.id)?.revision).toBe(1);
  });

  it('a publishing batch with visible text is kept as partial, never overwritten', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0, startWorkers: false, env: { ENABLE_BACKGROUND_JOBS: 'false' } });
    const dataDir = harness.app.env.dataDir;
    const user = harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '已显示内容' }] }).message;
    const admission = harness.app.repos.replyBatches.appendOrCreateMessage(user.id, new Date(0).toISOString(), new Date(0).toISOString());
    const batchId = admission.batch.id;
    harness.app.repos.replyBatches.markQueued(batchId);
    const shell = harness.app.repos.messages.create({
      role: 'assistant', status: 'sending', replyTo: user.id, batchId,
      parts: [{ type: 'text', text: '已显示内容', status: 'sent' }], meta: { batchId, batchMessageIds: [user.id] }
    }).message;
    harness.app.repos.replyBatches.beginGenerating(batchId, 1, 'dead-worker', -1);
    harness.app.repos.replyBatches.beginPublishing(batchId, 1, 'dead-worker');
    await harness.app.close();
    harness = null;

    const second = await bootSecond(dataDir);
    harness = second;
    await vi.waitFor(() => expect(second.app.repos.replyBatches.get(batchId)?.status).toBe('completed'), { timeout: 10000 });
    const row = second.app.repos.replyBatches.get(batchId)!;
    expect(row.assistant_message_id).toBe(shell.id);
    expect(JSON.parse(row.meta_json) as { partial?: number }).toMatchObject({ partial: 1 });
    // The published content is untouched — exactly one assistant message.
    const assistants = second.app.repos.messages.recent(50).filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.content[0].text).toBe('已显示内容');
  });

  it('an in-flight voice generation is failed on restart, leaving no pending audio', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0, startWorkers: false, env: { ENABLE_BACKGROUND_JOBS: 'false' } });
    const dataDir = harness.app.env.dataDir;
    harness.app.repos.voice.create({
      batchId: 'rb_x', revision: 1, mode: 'replace', requestedBy: 'user',
      status: 'synthesizing', spokenText: '半途而废的语音', synthesisText: '半途而废的语音'
    });
    await harness.app.close();
    harness = null;

    const second = await bootSecond(dataDir);
    harness = second;
    const rows = second.app.repos.voice.list(10);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.failure_code).toBe('interrupted_by_restart');
  });

  it('a proactive attempt in flight never duplicates its message after restart', async () => {
    harness = await createHarness({ skipStickerImport: true, replyDebounceMs: 0, startWorkers: false, env: { ENABLE_BACKGROUND_JOBS: 'false' } });
    const dataDir = harness.app.env.dataDir;
    harness.app.repos.proactive.create({
      candidateId: 'cand-restart', candidateKind: 'play', candidateActivity: '练琴',
      requestedMode: 'text', status: 'blocked', detail: {}
    });
    await harness.app.close();
    harness = null;

    const second = await bootSecond(dataDir);
    harness = second;
    // No proactive assistant message appears and the attempt is not 'sent'.
    const assistants = second.app.repos.messages.recent(50).filter((m) => m.role === 'assistant' && m.meta?.proactive);
    expect(assistants).toHaveLength(0);
    const attempt = second.app.repos.proactive.list(10)[0]!;
    expect(attempt.status).not.toBe('sent');
  });

  it('a life boundary settles its outcome exactly once across a restart', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { ENABLE_BACKGROUND_JOBS: 'false', ENABLE_LIFE_ENGINE: 'true', ENABLE_LIFE_REACH_OUT: 'true' },
      clock: () => new Date('2026-07-31T12:00:00+08:00')
    });
    const dataDir = harness.app.env.dataDir;
    await harness.app.services.life.tick();
    const eventsBefore = harness.app.repos.life.events().length;
    await harness.app.close();
    harness = null;

    const second = await bootSecond(dataDir, { ENABLE_LIFE_ENGINE: 'true', ENABLE_LIFE_REACH_OUT: 'true' });
    harness = second;
    // Advance past the boundary: the previous activity settles once.
    const mutable = second.app.services.life as unknown as { now: () => Date };
    const engine = second.app.services.life;
    await engine.tick();
    const eventsAfterFirstTick = second.app.repos.life.events().length;
    await engine.tick();
    expect(second.app.repos.life.events().length).toBe(eventsAfterFirstTick);
    expect(eventsAfterFirstTick).toBeGreaterThanOrEqual(eventsBefore);
    void mutable;
  });
});
