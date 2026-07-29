import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, StreamEvent } from '../src/core/types.js';
import { createHarness, type Harness } from './helpers/harness.js';

const WITHDRAW_WINDOW_MS = 5 * 60_000;

/** Create a user message directly in the database, optionally back-dating it. */
function userMessage(harness: Harness, text = 'withdraw me', opts: { createdAt?: string } = {}): ChatMessage {
  const created = harness.app.repos.messages.create({
    role: 'user',
    status: 'sent',
    parts: [{ type: 'text', text, status: 'sent' }]
  }).message;
  if (opts.createdAt) {
    harness.app.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(opts.createdAt, created.id);
    return harness.app.repos.messages.get(created.id)!;
  }
  return created;
}

/** Install a SQLite trigger that aborts INSERTs of a given event type. */
function abortEventType(harness: Harness, type: string): void {
  harness.app.db.exec(`
    CREATE TRIGGER abort_selected_event
    BEFORE INSERT ON events
    WHEN NEW.type = '${type}'
    BEGIN
      SELECT RAISE(ABORT, 'injected event failure');
    END
  `);
}

function withdrawEvents(harness: Harness): StreamEvent[] {
  return harness.app.services.bus.replay(0).filter((event) => event.type === 'message.updated');
}

function withdrawAudits(harness: Harness, id: string): Array<{ action: string; target: string | null }> {
  return harness.app.repos.audit
    .list(500)
    .filter((audit) => audit.category === 'message' && audit.action === 'withdrawn' && audit.target === id);
}

async function withdraw(harness: Harness, id: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await harness.app.server.inject({ method: 'POST', url: `/api/messages/${id}/withdraw` });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('message withdrawal atomicity, idempotency and concurrency', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({ skipStickerImport: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  // Requirements 1-5: two concurrent withdrawals on the same user message.
  it('two concurrent withdrawals both respond non-500 and mutate exactly once', async () => {
    const user = userMessage(harness);
    const live: StreamEvent[] = [];
    const unsubscribe = harness.app.services.bus.subscribe((event) => live.push(event));

    const [first, second] = await Promise.all([
      harness.app.server.inject({ method: 'POST', url: `/api/messages/${user.id}/withdraw` }),
      harness.app.server.inject({ method: 'POST', url: `/api/messages/${user.id}/withdraw` })
    ]);
    unsubscribe();

    // Requirement 2: neither response is a 500.
    expect(first.statusCode).not.toBe(500);
    expect(second.statusCode).not.toBe(500);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const bodies = [first.json(), second.json()] as Array<{ duplicate?: boolean; message: ChatMessage }>;
    // Exactly one is the idempotent duplicate (200, duplicate:true).
    expect(bodies.filter((body) => body.duplicate === true)).toHaveLength(1);

    // Requirement 3: exactly one withdrawn placeholder part in the final message.
    const stored = harness.app.repos.messages.get(user.id)!;
    expect(stored.content).toHaveLength(1);
    expect(stored.content[0]?.text).toBe('[消息已撤回]');
    expect(stored.meta?.withdrawnAt).toBeTruthy();

    // Requirement 4: exactly one persistent message.updated event and one live fanout.
    expect(withdrawEvents(harness)).toHaveLength(1);
    expect(live.filter((event) => event.type === 'message.updated')).toHaveLength(1);

    // Requirement 5: exactly one audit record.
    expect(withdrawAudits(harness, user.id)).toHaveLength(1);
  });

  // Requirement 6: withdrawing a user message must not touch the assistant reply.
  it('leaves the independent assistant reply content, parts, status and meta untouched', async () => {
    const res = await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: { clientMsgId: 'c_withdraw_assistant', content: [{ type: 'text', text: '请回复我' }] }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { message: ChatMessage; reply: ChatMessage };
    const assistantBefore = harness.app.repos.messages.get(body.reply.id)!;

    const result = await withdraw(harness, body.message.id);
    expect(result.statusCode).toBe(200);

    const assistantAfter = harness.app.repos.messages.get(assistantBefore.id)!;
    expect(assistantAfter).toEqual(assistantBefore);
  });

  // Requirement 7: non-existent message.
  it('returns 404 for a non-existent message and writes no event or audit', async () => {
    const result = await withdraw(harness, 'msg_does_not_exist');
    expect(result.statusCode).toBe(404);
    expect(result.body.error).toBe('not_found');
    expect(withdrawEvents(harness)).toHaveLength(0);
    expect(withdrawAudits(harness, 'msg_does_not_exist')).toHaveLength(0);
  });

  // Requirement 8: assistant messages are not withdrawable.
  it('returns 409 for an assistant message and leaves it untouched', async () => {
    const assistant = harness.app.repos.messages.create({
      role: 'assistant',
      status: 'sent',
      parts: [{ type: 'text', text: 'assistant reply', status: 'sent' }]
    }).message;

    const result = await withdraw(harness, assistant.id);
    expect(result.statusCode).toBe(409);
    expect(result.body.error).toBe('not_withdrawable');

    const stored = harness.app.repos.messages.get(assistant.id)!;
    expect(stored.content).toHaveLength(1);
    expect(stored.content[0]?.text).toBe('assistant reply');
    expect(stored.meta?.withdrawnAt).toBeUndefined();
    expect(withdrawEvents(harness)).toHaveLength(0);
    expect(withdrawAudits(harness, assistant.id)).toHaveLength(0);
  });

  // Requirement 9: messages older than five minutes cannot be withdrawn.
  it('returns 409 for a message past the five-minute window and leaves it untouched', async () => {
    const user = userMessage(harness, 'old message', {
      createdAt: new Date(Date.now() - 6 * 60_000).toISOString()
    });

    const result = await withdraw(harness, user.id);
    expect(result.statusCode).toBe(409);
    expect(result.body.error).toBe('withdraw_window_expired');

    const stored = harness.app.repos.messages.get(user.id)!;
    expect(stored.meta?.withdrawnAt).toBeUndefined();
    expect(stored.content).toHaveLength(1);
    expect(stored.content[0]?.text).toBe('old message');
    expect(withdrawEvents(harness)).toHaveLength(0);
    expect(withdrawAudits(harness, user.id)).toHaveLength(0);
  });

  // Requirement 10: an already-withdrawn message returns 200 with duplicate:true.
  it('returns 200 with duplicate:true for an already-withdrawn message without new side effects', async () => {
    const user = userMessage(harness);

    const first = await withdraw(harness, user.id);
    expect(first.statusCode).toBe(200);

    const second = await withdraw(harness, user.id);
    expect(second.statusCode).toBe(200);
    expect(second.body.duplicate).toBe(true);
    const message = second.body.message as ChatMessage;
    expect(message.content).toHaveLength(1);
    expect(message.content[0]?.text).toBe('[消息已撤回]');

    // Only the first withdrawal produced an event and an audit.
    expect(withdrawEvents(harness)).toHaveLength(1);
    expect(withdrawAudits(harness, user.id)).toHaveLength(1);
  });

  // Requirement 11: event persistence failure rolls back everything and suppresses fanout.
  it('rolls back parts, meta, audit and event when message.updated persistence fails, with no fanout', async () => {
    const user = userMessage(harness, 'rollback me');
    abortEventType(harness, 'message.updated');
    const live: StreamEvent[] = [];
    const unsubscribe = harness.app.services.bus.subscribe((event) => live.push(event));

    const result = await withdraw(harness, user.id);
    unsubscribe();

    expect(result.statusCode).toBe(500);

    // Requirement 12: assert final database state, not just HTTP status.
    const stored = harness.app.repos.messages.get(user.id)!;
    expect(stored.content).toHaveLength(1);
    expect(stored.content[0]?.text).toBe('rollback me');
    expect(stored.meta?.withdrawnAt).toBeUndefined();
    expect(withdrawEvents(harness)).toHaveLength(0);
    expect(withdrawAudits(harness, user.id)).toHaveLength(0);
    expect(live.filter((event) => event.type === 'message.updated')).toHaveLength(0);
  });
});
