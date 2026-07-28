import { z } from 'zod';
import type { SooyaApp } from '../app.js';
import { requireChatToken } from './auth.js';
import { SendMessageSchema, type ChatMessage } from '../core/types.js';
import { parseUserDirectives } from '../core/directives.js';

const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.coerce.number().int().min(0).optional(),
  since: z.coerce.number().int().min(0).optional()
});

/**
 * Per-conversation send lock: SOOYA is single-user and single-conversation, so
 * two overlapping sends would corrupt the reply ordering. Concurrent requests
 * are serialized rather than rejected.
 */
class SendLock {
  private chain: Promise<unknown> = Promise.resolve();
  private depth = 0;

  get busy(): boolean {
    return this.depth > 0;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.depth++;
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined).finally(() => {
      this.depth--;
    });
    return next;
  }
}

export function registerChatRoutes(app: SooyaApp): void {
  const { server, repos, services, env } = app;
  const auth = requireChatToken(app);
  const lock = new SendLock();

  server.get('/api/conversation', { preHandler: auth }, async () => {
    const persona = app.config.getPersona();
    return {
      conversationId: 'main',
      persona: {
        name: persona.name,
        avatar: persona.avatar,
        userAvatar: persona.userAvatar,
        tagline: persona.tagline
      },
      messageCount: repos.messages.count(),
      lastSeq: repos.messages.maxSeq(),
      lastEventSeq: services.bus.lastSeq()
    };
  });

  server.get('/api/messages', { preHandler: auth }, async (req, reply) => {
    const parsed = HistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    const { limit, before, since } = parsed.data;
    // The event cursor is read BEFORE the rows so the caller can safely start
    // its stream from it: any event emitted between the two reads is then
    // replayed rather than lost. Reading it afterwards (or from a separate
    // request) opens a window in which a reply is written but never delivered.
    const cursorBefore = services.bus.lastSeq();

    if (since !== undefined) {
      const messages = repos.messages.since(since, limit);
      return {
        messages,
        hasMore: false,
        lastEventSeq: cursorBefore,
        lastMessageSeq: repos.messages.maxSeq()
      };
    }
    const page = repos.messages.page(limit, before ?? null);
    return {
      messages: page.messages,
      hasMore: page.hasMore,
      lastEventSeq: cursorBefore,
      lastMessageSeq: repos.messages.maxSeq(),
      oldestSeq: page.messages[0]?.seq ?? null
    };
  });

  server.get('/api/messages/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const msg = repos.messages.get(id);
    if (!msg) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return { message: msg };
  });

  server.post('/api/messages', { preHandler: auth }, async (req, reply) => {
    const parsed = SendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    const input = parsed.data;

    // Validate referenced media exists before storing anything.
    for (const part of input.content) {
      if ('mediaId' in part && part.mediaId) {
        const row = repos.media.get(part.mediaId);
        if (!row) {
          reply.code(400);
          return { error: 'unknown_media', mediaId: part.mediaId };
        }
      }
    }

    const text = input.content
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('\n');
    const directives = { ...parseUserDirectives(text), ...(input.directives ?? {}) };

    const { message, created } = repos.messages.create({
      role: 'user',
      status: 'sent',
      clientMsgId: input.clientMsgId,
      parts: input.content.map((p) => ({
        type: p.type,
        text: p.type === 'text' ? p.text : null,
        mediaId: 'mediaId' in p ? p.mediaId : null,
        status: 'sent',
        duration: p.type === 'audio' ? p.duration ?? null : null,
        transcript: p.type === 'audio' ? p.transcript ?? null : null
      })),
      meta: { directives }
    });

    if (!created) {
      // Idempotent replay: return the stored message, do not reply twice.
      return { message, duplicate: true, replyPending: false };
    }

    services.bus.publish('message.received', { message });

    // Reply asynchronously so the HTTP call returns immediately; the client
    // watches the SSE stream (and can always re-fetch from the database).
    void lock.run(async () => {
      const outcome = await services.replier.reply(message, {
        recentMessages: env.CONTEXT_RECENT_MESSAGES,
        memoryLimit: env.CONTEXT_MEMORY_LIMIT
      });
      try {
        if (!env.DISABLE_MEMORY_PIPELINE) {
          repos.jobs.enqueue('memory.extract', { userMessageId: message.id, assistantMessageId: outcome.messageId });
        }
        if (services.summarizer.needsSummary()) repos.jobs.enqueue('summary.build', {});
      } catch (err) {
        repos.errors.add('post-reply-jobs', (err as Error).message);
      }
    });

    return { message, duplicate: false, replyPending: true };
  });

  /** Synchronous variant used by tests and non-streaming clients. */
  server.post('/api/messages/sync', { preHandler: auth }, async (req, reply) => {
    const parsed = SendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    const input = parsed.data;
    for (const part of input.content) {
      if ('mediaId' in part && part.mediaId && !repos.media.get(part.mediaId)) {
        reply.code(400);
        return { error: 'unknown_media', mediaId: part.mediaId };
      }
    }
    const text = input.content
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('\n');
    const directives = { ...parseUserDirectives(text), ...(input.directives ?? {}) };

    const { message, created } = repos.messages.create({
      role: 'user',
      status: 'sent',
      clientMsgId: input.clientMsgId,
      parts: input.content.map((p) => ({
        type: p.type,
        text: p.type === 'text' ? p.text : null,
        mediaId: 'mediaId' in p ? p.mediaId : null,
        status: 'sent',
        duration: p.type === 'audio' ? p.duration ?? null : null,
        transcript: p.type === 'audio' ? p.transcript ?? null : null
      })),
      meta: { directives }
    });
    if (!created) {
      const existingReply = findReply(app, message.id);
      return { message, duplicate: true, reply: existingReply ?? null };
    }
    services.bus.publish('message.received', { message });
    const outcome = await lock.run(() =>
      services.replier.reply(message, {
        recentMessages: env.CONTEXT_RECENT_MESSAGES,
        memoryLimit: env.CONTEXT_MEMORY_LIMIT
      })
    );
    if (!env.DISABLE_MEMORY_PIPELINE) {
      repos.jobs.enqueue('memory.extract', { userMessageId: message.id, assistantMessageId: outcome.messageId });
    }
    if (services.summarizer.needsSummary()) repos.jobs.enqueue('summary.build', {});
    return { message, duplicate: false, reply: repos.messages.get(outcome.messageId), outcome };
  });

  server.get('/api/stickers', { preHandler: auth }, async () => ({
    stickers: services.stickerLibrary.available().map((s) => ({
      id: s.id,
      name: s.name,
      emotion: s.emotion,
      tags: s.tags,
      url: s.url,
      mediaId: s.mediaId
    }))
  }));
}

function findReply(app: SooyaApp, userMessageId: string): ChatMessage | null {
  const recent = app.repos.messages.recent(10);
  for (const m of recent.reverse()) {
    if (m.role === 'assistant' && m.replyTo === userMessageId) return m;
  }
  return null;
}
