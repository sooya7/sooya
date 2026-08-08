import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Harness } from './helpers/harness.js';
import { createHarness } from './helpers/harness.js';
import { ReplyCoordinator } from '../src/core/reply-coordinator.js';
import { ThoughtRepo } from '../src/db/repos/thought.repo.js';
import { ThoughtSafetyFilter } from '../src/core/thoughts/safety.js';
import { ThoughtPresenter } from '../src/core/thoughts/presenter.js';
import { DecisionTraceService } from '../src/core/thoughts/trace.js';
import { ThoughtsService } from '../src/core/thoughts/service.js';
import { DEFAULT_THOUGHT_FLAGS, type ThoughtsFlags } from '../src/core/thoughts/flags.js';

const ADMIN_TOKEN = 'decision-trace-admin-token';
const replyOptions = { recentMessages: 24, memoryLimit: 8 };

let harness: Harness | undefined;
let coordinator: ReplyCoordinator | undefined;
let repo: ThoughtRepo | undefined;

afterEach(async () => {
  await coordinator?.stop();
  coordinator = undefined;
  repo = undefined;
  await harness?.cleanup();
  harness = undefined;
});

async function build(): Promise<void> {
  const h = await createHarness({
    skipStickerImport: true,
    env: { ADMIN_API_TOKEN: ADMIN_TOKEN },
    chat: { script: [['好的。']] }
  });
  harness = h;
  const { repos, services, config } = h.app;
  repo = new ThoughtRepo(h.app.db);
  const safety = new ThoughtSafetyFilter();
  const traces = new DecisionTraceService({
    repo,
    world: () => services.world.snapshot(),
    life: () => {
      const s = services.life.snapshot();
      return { activity: s.activity, mood: s.mood };
    },
    context: () => services.context,
    voice: (id) => repos.voice.latestForMessage(id),
    experiments: { canonicalVariantForSubsystem: () => null }
  });
  const presenter = new ThoughtPresenter({
    repo,
    chat: () => services.capabilities.chatProvider(),
    safety,
    bus: services.bus,
    errorLog: repos.errors,
    safetyRefs: { personaName: config.getPersona().name },
    timeoutMs: 2000
  });
  const flags: ThoughtsFlags = {
    ...DEFAULT_THOUGHT_FLAGS,
    visibleThoughtsEnabled: true,
    innerMonologueEnabled: true,
    adminDecisionTraceEnabled: true
  };
  const thoughts = new ThoughtsService({ flags, repo, presenter, traces, messages: repos.messages, errorLog: repos.errors });
  (h.app.services as unknown as { thoughts: ThoughtsService }).thoughts = thoughts;
  coordinator = new ReplyCoordinator({
    messages: repos.messages,
    batches: repos.replyBatches,
    replier: services.replier,
    bus: services.bus,
    db: h.app.db,
    errorLog: repos.errors,
    thoughts,
    initialDebounceMs: 0,
    publishGraceMs: 0,
    onCompleted: vi.fn()
  });
}

async function driveReply(h: Harness, text: string) {
  const user = h.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text }] }).message;
  const admission = h.app.repos.replyBatches.appendOrCreateMessage(user.id, new Date(0).toISOString(), new Date(0).toISOString());
  const batchId = admission.batch.id;
  h.app.repos.replyBatches.markQueued(batchId);
  const outcome = await coordinator!.enqueue(batchId, replyOptions);
  return { batchId, outcome, admission };
}

async function waitFor(fn: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Decision trace — admin-only audit', () => {
  it('records a trace after the reply completes with safe decision metadata', async () => {
    await build();
    const h = harness!;
    const { batchId, outcome } = await driveReply(h, '今天工作好累，压力好大');
    expect(outcome.ok).toBe(true);
    await waitFor(() => repo!.countTraces() === 1);

    const trace = repo!.getTrace(batchId, 1)!;
    expect(trace.batchId).toBe(batchId);
    expect(trace.revision).toBe(1);
    expect(trace.replyIntent).toBe('emotional_support');
    // Safe summaries only: life activity/mood lines, never raw memory text.
    expect(Array.isArray(trace.lifeContext)).toBe(true);
    expect(trace.lifeContext!.some((line) => line.startsWith('activity:'))).toBe(true);
    expect(typeof trace.memoryRecallCount).toBe('number');
    expect(trace.weather).toBeNull();
    expect(trace.proactive).toBeNull();
  });

  it('serves the trace to the admin API with a valid token and refuses without one', async () => {
    await build();
    const h = harness!;
    const { batchId } = await driveReply(h, '你好');
    await waitFor(() => repo!.countTraces() === 1);

    const ok = await h.app.server.inject({
      method: 'GET',
      url: `/api/admin/decision-trace?batchId=${batchId}&revision=1`,
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { trace: { batchId: string; revision: number; replyIntent?: string } };
    expect(body.trace.batchId).toBe(batchId);
    expect(body.trace.revision).toBe(1);

    const noToken = await h.app.server.inject({ method: 'GET', url: `/api/admin/decision-trace?batchId=${batchId}&revision=1` });
    expect(noToken.statusCode).toBe(401);
  });

  it('rejects a missing/invalid batchId+revision pair', async () => {
    await build();
    const h = harness!;
    const bad = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/decision-trace?revision=1',
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    expect(bad.statusCode).toBe(400);
    const missing = await h.app.server.inject({
      method: 'GET',
      url: `/api/admin/decision-trace?batchId=rb_never&revision=1`,
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    expect(missing.statusCode).toBe(404);
  });

  it('lists recent traces newest first', async () => {
    await build();
    const h = harness!;
    const first = await driveReply(h, '第一条');
    const second = await driveReply(h, '第二条');
    await waitFor(() => repo!.countTraces() === 2);

    const res = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/decision-trace/recent',
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { traces: Array<{ batchId: string; revision: number }> };
    expect(body.traces).toHaveLength(2);
    expect(body.traces[0]!.batchId).toBe(second.batchId);
    expect(body.traces[1]!.batchId).toBe(first.batchId);
  });

  it('never exposes the trace through the user-facing thought API', async () => {
    await build();
    const h = harness!;
    const { outcome } = await driveReply(h, '你好');
    await waitFor(() => {
      const thought = repo!.getUserThought(outcome.messageId);
      return thought !== undefined && thought.status === 'completed';
    });

    const res = await h.app.server.inject({ method: 'GET', url: `/api/thoughts/${outcome.messageId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { thought: Record<string, unknown> };
    // Only the inner monologue is served: no decision fields, no batch trace.
    expect(body.thought['kind']).toBe('inner_monologue');
    expect(body.thought['visibility']).toBe('user');
    for (const forbidden of ['replyIntent', 'lifeContext', 'memoryRecallCount', 'semanticGuard', 'experimentVariant', 'proactive']) {
      expect(body.thought[forbidden]).toBeUndefined();
    }
  });

  it('writes no trace when ADMIN_DECISION_TRACE_ENABLED is off', async () => {
    await build();
    const h = harness!;
    // Flip the flag after wiring: the service must not record traces.
    (h.app.services as unknown as { thoughts: { deps: { flags: ThoughtsFlags } } }).thoughts.deps.flags.adminDecisionTraceEnabled = false;
    const { batchId } = await driveReply(h, '你好');
    await waitFor(() => h.app.repos.replyBatches.get(batchId)?.status === 'completed');
    expect(repo!.countTraces()).toBe(0);
  });
});
