import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, StreamEvent } from '../src/core/types.js';
import { createHarness, type Harness } from './helpers/harness.js';

const sendPayload = (clientMsgId: string, text = 'atomic message') => ({
  clientMsgId,
  content: [{ type: 'text' as const, text }]
});

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

function userMessages(harness: Harness): ChatMessage[] {
  return harness.app.repos.messages.recent(100).filter((message) => message.role === 'user');
}

describe('message and durable event atomicity', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({ skipStickerImport: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  it.each(['/api/messages', '/api/messages/sync'])(
    'rolls back the user message and suppresses fanout when message.received persistence fails on %s',
    async (url) => {
      abortEventType(harness, 'message.received');
      const live: StreamEvent[] = [];
      const unsubscribe = harness.app.services.bus.subscribe((event) => live.push(event));

      const response = await harness.app.server.inject({
        method: 'POST',
        url,
        payload: sendPayload(`event_failure_${url.endsWith('sync') ? 'sync' : 'async'}`)
      });
      unsubscribe();

      expect(response.statusCode).toBe(500);
      expect(userMessages(harness)).toHaveLength(0);
      expect(harness.app.services.bus.replay(0).filter((event) => event.type === 'message.received')).toHaveLength(0);
      expect(live.filter((event) => event.type === 'message.received')).toHaveLength(0);
    }
  );

  it('does not persist or fan out message.received when message insertion fails', async () => {
    harness.app.db.exec(`
      CREATE TRIGGER abort_user_message
      BEFORE INSERT ON messages
      WHEN NEW.role = 'user'
      BEGIN
        SELECT RAISE(ABORT, 'injected message failure');
      END
    `);
    const live: StreamEvent[] = [];
    const unsubscribe = harness.app.services.bus.subscribe((event) => live.push(event));

    const response = await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: sendPayload('message_failure')
    });
    unsubscribe();

    expect(response.statusCode).toBe(500);
    expect(userMessages(harness)).toHaveLength(0);
    expect(harness.app.services.bus.replay(0).filter((event) => event.type === 'message.received')).toHaveLength(0);
    expect(live.filter((event) => event.type === 'message.received')).toHaveLength(0);
  });

  it('rolls back the user message and event when durable batch membership cannot be written', async () => {
    harness.app.db.exec(`
      CREATE TRIGGER abort_reply_batch_membership
      BEFORE INSERT ON reply_batch_messages
      BEGIN
        SELECT RAISE(ABORT, 'injected batch failure');
      END
    `);

    const response = await harness.app.server.inject({
      method: 'POST', url: '/api/messages', payload: sendPayload('batch_failure')
    });

    expect(response.statusCode).toBe(500);
    expect(userMessages(harness)).toHaveLength(0);
    expect(harness.app.services.bus.replay(0).filter((event) => event.type === 'message.received')).toHaveLength(0);
  });

  it('creates and fans out exactly one message.received event for a duplicate clientMsgId', async () => {
    const live: StreamEvent[] = [];
    const unsubscribe = harness.app.services.bus.subscribe((event) => live.push(event));

    const first = await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages',
      payload: sendPayload('duplicate_atomic')
    });
    const second = await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages',
      payload: sendPayload('duplicate_atomic')
    });
    unsubscribe();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(userMessages(harness).filter((message) => message.clientMsgId === 'duplicate_atomic')).toHaveLength(1);
    expect(harness.app.services.bus.replay(0).filter((event) => event.type === 'message.received')).toHaveLength(1);
    expect(live.filter((event) => event.type === 'message.received')).toHaveLength(1);
  });

  it('separates durable persistence from live fanout', () => {
    const live: StreamEvent[] = [];
    const unsubscribe = harness.app.services.bus.subscribe((event) => live.push(event));
    const bus = harness.app.services.bus as unknown as {
      persist: (type: 'system.notice', payload: Record<string, unknown>) => StreamEvent;
      fanout: (event: StreamEvent) => void;
    };

    const event = bus.persist('system.notice', { boundary: true });
    expect(harness.app.services.bus.replay(0)).toContainEqual(event);
    expect(live).toHaveLength(0);

    bus.fanout(event);
    expect(live).toEqual([event]);
    unsubscribe();
  });

  it('rolls back the assistant shell when reply.publishing.started cannot be persisted', async () => {
    // The shell and its first events commit in one transaction (the publish
    // barrier), so an event persistence failure rolls the shell back.
    abortEventType(harness, 'reply.publishing.started');
    const live: StreamEvent[] = [];
    const unsubscribe = harness.app.services.bus.subscribe((event) => live.push(event));

    const response = await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: sendPayload('pub_event_failure')
    });
    unsubscribe();

    // The publication failed outright, so the sync call surfaces the failure.
    expect(response.statusCode).toBe(500);
    expect(harness.app.repos.messages.recent(100).filter((message) => message.role === 'assistant')).toHaveLength(0);
    expect(harness.app.services.bus.replay(0).filter((event) => event.type === 'reply.publishing.started')).toHaveLength(0);
    expect(live.filter((event) => event.type === 'reply.publishing.started')).toHaveLength(0);
  });

  it('published content stays visible when reply.completed cannot be persisted', async () => {
    // The completion event commits atomically with the batch completion; on
    // persistence failure the reply falls back to the partial path — visible
    // content is never silently revoked (B2).
    abortEventType(harness, 'reply.completed');

    const response = await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: sendPayload('completed_event_failure')
    });
    const body = response.json() as { reply: { status: string } | null; outcome: { ok: boolean } };
    const completed = harness.app.services.bus.replay(0).filter((event) => event.type === 'reply.completed');

    expect(completed).toHaveLength(0);
    expect(body.outcome.ok).toBe(true);
    expect(body.reply?.status).toBe('sent');
    const user = harness.app.repos.messages.recent(100).find((m) => m.role === 'user')!;
    const batch = harness.app.repos.replyBatches.findByMessage(user.id)!;
    expect(JSON.parse(batch.meta_json) as { partial?: number }).toMatchObject({ partial: 1 });
  });

  it('fails the batch and resolves the caller when reply.failed cannot be persisted', async () => {
    vi.spyOn(harness.app.services.context, 'build').mockRejectedValueOnce(new Error('private context failure'));
    abortEventType(harness, 'reply.failed');

    const response = await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: sendPayload('failed_event_failure')
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { outcome: { ok: boolean } };
    expect(body.outcome.ok).toBe(false);
    // A hidden failure never creates an assistant message.
    expect(harness.app.repos.messages.recent(100).filter((message) => message.role === 'assistant')).toHaveLength(0);
    expect(harness.app.services.bus.replay(0).filter((event) => event.type === 'reply.failed')).toHaveLength(0);
  });

  it.each([
    { terminal: 'reply.completed' as const, chatError: null },
    { terminal: 'reply.failed' as const, chatError: new Error('private provider failure') }
  ])('$terminal carries the complete authoritative current message', async ({ terminal, chatError }) => {
    if (chatError) vi.spyOn(harness.app.services.context, 'build').mockRejectedValueOnce(chatError);
    const response = await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: sendPayload('authoritative-payload')
    });
    const outcome = (response.json() as { outcome: { messageId: string; ok: boolean } }).outcome;
    const event = harness.app.services.bus.replay(0).find((candidate) => candidate.type === terminal)!;

    expect(event).toBeDefined();
    // A completed reply carries the authoritative message; a hidden failure
    // has no message (null) but the structured failure object.
    expect(event.payload.message ?? null).toEqual(
      outcome.ok ? harness.app.repos.messages.get(outcome.messageId) : null
    );
  });
});
