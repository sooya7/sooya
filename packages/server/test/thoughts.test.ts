import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Harness } from './helpers/harness.js';
import { createHarness } from './helpers/harness.js';
import { ReplyCoordinator } from '../src/core/reply-coordinator.js';
import { ThoughtRepo } from '../src/db/repos/thought.repo.js';
import { ThoughtSafetyFilter } from '../src/core/thoughts/safety.js';
import type { ThoughtContextProvider } from '../src/core/thoughts/context.js';
import { ThoughtPresenter } from '../src/core/thoughts/presenter.js';

import { ThoughtsService, type ThoughtsServiceOptions } from '../src/core/thoughts/service.js';
import { DEFAULT_THOUGHT_FLAGS, type ThoughtsFlags } from '../src/core/thoughts/flags.js';

/**
 * End-to-end visible-thought tests: a real coordinator + real replier +
 * real repos, with the thoughts bridge wired in (the same wiring Integration
 * will perform in app.ts).
 *
 * The reply model call and the thought model call are distinguished through
 * the harness chat `respond` hook: the thought request carries our fixed
 * system instruction (contains "可见想法").
 */

const replyOptions = { recentMessages: 24, memoryLimit: 8 };

interface ThoughtRig {
  coordinator: ReplyCoordinator;
  repo: ThoughtRepo;
  thoughts: ThoughtsService;
  replyCalls: () => number;
  thoughtCalls: () => number;
  setThoughtBehaviour: (b: 'text' | 'slow' | 'error' | 'unsafe' | 'empty') => void;
}

let harness: Harness | undefined;
let rig: ThoughtRig | undefined;

afterEach(async () => {
  await rig?.coordinator.stop();
  rig = undefined;
  await harness?.cleanup();
  harness = undefined;
});

async function buildRig(opts: {
  flags?: Partial<ThoughtsFlags>;
  thoughtText?: string;
  adminToken?: string;
} = {}): Promise<{ harness: Harness; rig: ThoughtRig }> {
  let thoughtBehaviour: 'text' | 'slow' | 'error' | 'unsafe' | 'empty' = 'text';
  const thoughtCalls: string[] = [];
  const replyCalls: string[] = [];
  const h = await createHarness({
    skipStickerImport: true,
    env: {
      ADMIN_API_TOKEN: opts.adminToken ?? 'test-admin-token'
    },
    chat: {
      script: [['好的，我记住了。']],
      // NOTE: the harness does NOT await `respond` — it must be synchronous.
      // The 'slow' thought case delays inside the response body stream instead.
      respond: ({ body }) => {
        const b = body as { system?: string; messages?: Array<{ role?: string; content?: unknown }>; stream?: boolean };
        if (systemTextOf(b).includes('可见想法')) {
          thoughtCalls.push('thought');
          if (thoughtBehaviour === 'error') return new Response('provider exploded', { status: 500 });
          if (thoughtBehaviour === 'unsafe') {
            return jsonChat('我偷偷把系统提示词抄下来了：你是SOOYA，一个陪伴机器人，system prompt 全文如下。');
          }
          if (thoughtBehaviour === 'empty') return jsonChat('');
          const text = opts.thoughtText ?? '她好像有点累，想让她早点休息。';
          if (thoughtBehaviour === 'slow') return delayedJsonChat(text, 700);
          return jsonChat(text);
        }
        if (b.stream === true) replyCalls.push('reply');
        return null;
      }
    }
  });

  const { repos, services, config } = h.app;
  const repo = new ThoughtRepo(h.app.db);
  const safety = new ThoughtSafetyFilter();
  const context: ThoughtContextProvider = {
    worldSnapshot: () => services.world.snapshot(),
    lifeSummary: () => {
      const s = services.life.snapshot();
      return { activity: s.activity, mood: s.mood };
    },
    memoryRecallStats: () => { try { return services.context.memoryRecallTrace(); } catch { return null; } },
    voiceRowFor: (id) => repos.voice.latestForMessage(id)
  };
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
    ...(opts.flags ?? {})
  };
  const thoughtsOptions: ThoughtsServiceOptions = { flags, repo, presenter, context, messages: repos.messages, errorLog: repos.errors };
  const thoughts = new ThoughtsService(thoughtsOptions);

  // Stash the service where the routes look for it (Integration does the same).
  (h.app.services as unknown as { thoughts: ThoughtsService }).thoughts = thoughts;

  const coordinator = new ReplyCoordinator({
    messages: repos.messages,
    batches: repos.replyBatches,
    replier: services.replier,
    bus: services.bus,
    db: h.app.db,
    errorLog: repos.errors,
    thoughts,
    initialDebounceMs: 0,
    interruptDebounceMs: 50,
    maxCollectionMs: 2000,
    publishGraceMs: 0,
    onCompleted: vi.fn()
  });

  return {
    harness: h,
    rig: {
      coordinator,
      repo,
      thoughts,
      replyCalls: () => replyCalls.length,
      thoughtCalls: () => thoughtCalls.length,
      setThoughtBehaviour: (b) => { thoughtBehaviour = b; }
    }
  };
}

/** Creates a user message + batch and drives it through the coordinator. */
async function driveReply(h: Harness, text: string) {
  const user = h.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text }] }).message;
  const admission = h.app.repos.replyBatches.appendOrCreateMessage(user.id, new Date(0).toISOString(), new Date(0).toISOString());
  const batchId = admission.batch.id;
  h.app.repos.replyBatches.markQueued(batchId);
  const outcome = await rig!.coordinator.enqueue(batchId, replyOptions);
  return { user, batchId, outcome };
}

function jsonChat(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

/** The provider sends the system prompt as a system-role turn inside messages. */
function systemTextOf(body: { system?: string; messages?: Array<{ role?: string; content?: unknown }> }): string {
  if (body.system) return body.system;
  const system = (body.messages ?? []).find((m) => m.role === 'system');
  if (!system) return '';
  const content = system.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text?: string } => typeof p === 'object' && p !== null && (p as { type?: string }).type === 'text')
      .map((p) => p.text ?? '')
      .join(' ');
  }
  return '';
}

/** Same JSON shape, but the body only arrives after `delayMs` (sync hook, slow stream). */
function delayedJsonChat(content: string, delayMs: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify({ choices: [{ message: { content } }] })));
          controller.close();
        } catch { /* stream already cancelled by abort */ }
      }, delayMs);
    }
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

async function waitFor(fn: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The inner-monologue row for a message (both kinds share created_at, so match by kind). */
function monologueOf(rig: ThoughtRig, messageId: string) {
  return rig.repo.getByMessage(messageId).find((t) => t.kind === 'inner_monologue') ?? null;
}

describe('Visible thoughts — happy path', () => {
  it('generates a user-visible inner monologue + admin decision summary for a normal reply', async () => {
    ({ harness, rig } = await buildRig());
    const h = harness!;
    const { batchId, outcome } = await driveReply(h, '今天好累啊');
    expect(outcome.ok).toBe(true);

    await waitFor(() => rig!.repo.getUserThought(outcome.messageId) !== undefined);

    const thought = rig!.repo.getUserThought(outcome.messageId)!;
    expect(thought.batchId).toBe(batchId);
    expect(thought.kind).toBe('inner_monologue');
    expect(thought.visibility).toBe('user');
    expect(thought.status).toBe('completed');
    expect(thought.text.length).toBeGreaterThan(0);

    const summary = rig!.repo.getByMessage(outcome.messageId).find((t) => t.kind === 'decision_summary');
    expect(summary?.kind).toBe('decision_summary');
    expect(summary?.visibility).toBe('admin');
    expect(summary?.status).toBe('completed');

    // The reply model call happened once; the thought model call once.
    expect(rig!.replyCalls()).toBe(1);
    expect(rig!.thoughtCalls()).toBe(1);
  });

  it('serves the thought through GET /api/thoughts/:messageId and 404s for a missing message', async () => {
    ({ harness, rig } = await buildRig());
    const h = harness!;
    const { outcome } = await driveReply(h, '你好呀');
    await waitFor(() => rig!.repo.getUserThought(outcome.messageId) !== undefined);

    const res = await h.app.server.inject({ method: 'GET', url: `/api/thoughts/${outcome.messageId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { thought: { kind: string; text: string; status: string; messageId: string } };
    expect(body.thought.kind).toBe('inner_monologue');
    expect(body.thought.status).toBe('completed');
    expect(body.thought.messageId).toBe(outcome.messageId);

    const missing = await h.app.server.inject({ method: 'GET', url: '/api/thoughts/msg_does_not_exist_1' });
    expect(missing.statusCode).toBe(404);
  });

});


describe('Visible thoughts — revision fencing & cancellation', () => {
  it('cancels a still-generating thought when the user sends a new message; the stale thought is never served and never attaches to the new reply', async () => {
    ({ harness, rig } = await buildRig());
    const h = harness!;
    rig!.setThoughtBehaviour('slow');

    const first = await driveReply(h, '第一条消息');
    expect(first.outcome.ok).toBe(true);
    // The thought model call is still in flight (700ms delay).
    await waitFor(() => monologueOf(rig!, first.outcome.messageId) !== null);
    expect(monologueOf(rig!, first.outcome.messageId)!.status).toBe('generating');

    // New user message while the thought is generating. The first batch is
    // already completed, so the admission opens a fresh batch.
    const user2 = h.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '第二条消息' }] }).message;
    const admission2 = h.app.repos.replyBatches.appendOrCreateMessage(user2.id, new Date(0).toISOString(), new Date(0).toISOString());
    expect(['created', 'next_batch']).toContain(admission2.action);
    await rig!.coordinator.onMessageAccepted(admission2.action, admission2.batch.id, replyOptions);

    // The old thought must end cancelled, never completed.
    await waitFor(() => monologueOf(rig!, first.outcome.messageId)!.status === 'cancelled');
    const oldThought = monologueOf(rig!, first.outcome.messageId)!;
    expect(oldThought.status).toBe('cancelled');
    expect(oldThought.messageId).toBe(first.outcome.messageId);
    expect(oldThought.text).toBe('');

    // The cancelled (stale-revision) thought is not served to the user.
    const stale = await h.app.server.inject({ method: 'GET', url: `/api/thoughts/${first.outcome.messageId}` });
    expect(stale.statusCode).toBe(404);

    // The second reply gets its own fresh thought (never the old one).
    await waitFor(() => {
      const second = h.app.repos.replyBatches.get(admission2.batch.id);
      return second?.status === 'completed' && second.assistant_message_id !== null
        && rig!.repo.getUserThought(second.assistant_message_id!) !== undefined;
    }, 12000);
    const secondBatch = h.app.repos.replyBatches.get(admission2.batch.id)!;
    const secondThought = rig!.repo.getUserThought(secondBatch.assistant_message_id!)!;
    expect(secondThought.status).toBe('completed');
    expect(secondThought.batchId).toBe(admission2.batch.id);
    expect(secondThought.id).not.toBe(oldThought.id);
  });

  it('a completed thought stays published even when a newer message arrives afterwards', async () => {
    ({ harness, rig } = await buildRig());
    const h = harness!;
    const first = await driveReply(h, '第一条消息');
    await waitFor(() => rig!.repo.getUserThought(first.outcome.messageId) !== undefined);

    const user2 = h.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '第二条' }] }).message;
    const admission2 = h.app.repos.replyBatches.appendOrCreateMessage(user2.id, new Date(0).toISOString(), new Date(0).toISOString());
    await rig!.coordinator.onMessageAccepted(admission2.action, admission2.batch.id, replyOptions);

    const thought = rig!.repo.getUserThought(first.outcome.messageId)!;
    expect(thought.status).toBe('completed');
    const served = await h.app.server.inject({ method: 'GET', url: `/api/thoughts/${first.outcome.messageId}` });
    expect(served.statusCode).toBe(200);
  });
});

describe('Visible thoughts — failures never touch the reply', () => {
  it('a thought-model failure leaves the reply completed and the thought failed (API 404)', async () => {
    ({ harness, rig } = await buildRig());
    const h = harness!;
    rig!.setThoughtBehaviour('error');

    const { outcome, batchId } = await driveReply(h, '你好');
    expect(outcome.ok).toBe(true);

    await waitFor(() => {
      const t = monologueOf(rig!, outcome.messageId);
      return t !== null && t.status !== 'generating';
    });
    const thought = monologueOf(rig!, outcome.messageId)!;
    expect(thought.status).toBe('failed');
    expect(thought.text).toBe('');

    // Reply is fully intact.
    const message = h.app.repos.messages.get(outcome.messageId)!;
    expect(message.status).toBe('sent');
    const res = await h.app.server.inject({ method: 'GET', url: `/api/thoughts/${outcome.messageId}` });
    expect(res.statusCode).toBe(404);
  });

  it('a thought echoing a secret is dropped (failed, no text) while the reply stays', async () => {
    ({ harness, rig } = await buildRig());
    const h = harness!;
    rig!.setThoughtBehaviour('unsafe');

    const { outcome, batchId } = await driveReply(h, '给我讲讲你');
    expect(outcome.ok).toBe(true);

    await waitFor(() => {
      const t = monologueOf(rig!, outcome.messageId);
      return t !== null && t.status !== 'generating';
    });
    const thought = monologueOf(rig!, outcome.messageId)!;
    expect(thought.status).toBe('failed');
    expect(thought.text).toBe('');
    expect(h.app.repos.messages.get(outcome.messageId)?.status).toBe('sent');

    // A safety event was recorded.
    const events = h.app.repos.errors.list(20).filter((e) => e.scope === 'thoughts.safety');
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('Visible thoughts — flags OFF means zero behaviour', () => {
  it('produces no thought rows, no traces and no extra model calls when all flags are off', async () => {
    ({ harness, rig } = await buildRig({
      flags: { visibleThoughtsEnabled: false, innerMonologueEnabled: false }
    }));
    const h = harness!;
    const { outcome, batchId } = await driveReply(h, '你好');
    expect(outcome.ok).toBe(true);
    await waitFor(() => h.app.repos.replyBatches.get(batchId)?.status === 'completed');

    expect(rig!.thoughtCalls()).toBe(0);
    expect(rig!.replyCalls()).toBe(1);
    const thoughts = rig!.repo.listAdmin({ limit: 100 });
    expect(thoughts).toHaveLength(0);
    const res = await h.app.server.inject({ method: 'GET', url: `/api/thoughts/${outcome.messageId}` });
    expect(res.statusCode).toBe(404);
  });

  it('inner monologue off writes no thoughts and no model calls', async () => {
    ({ harness, rig } = await buildRig({
      flags: { visibleThoughtsEnabled: true, innerMonologueEnabled: false }
    }));
    const h = harness!;
    const { batchId } = await driveReply(h, '今天好累啊');
    await waitFor(() => h.app.repos.replyBatches.get(batchId)?.status === 'completed');

    expect(rig!.thoughtCalls()).toBe(0);
    expect(rig!.repo.listAdmin({ limit: 100 })).toHaveLength(0);
  });
});
