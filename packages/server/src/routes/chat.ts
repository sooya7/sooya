import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import type { SooyaApp } from '../app.js';
import { requireChatToken } from './auth.js';
import { SendMessageSchema, type ChatMessage } from '../core/types.js';
import { parseUserDirectives } from '../core/directives.js';
import { maintenanceCoordinator } from '../core/maintenance.js';

const HistoryQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.coerce.number().int().min(0).optional(), since: z.coerce.number().int().min(0).optional() });

export function registerChatRoutes(app: SooyaApp): void {
  const { server, repos, services, env } = app;
  const auth = requireChatToken(app);

  server.get('/api/conversation', { preHandler: auth }, async () => {
    const persona = app.config.getPersona();
    return { conversationId: 'main', persona: { name: persona.name, avatar: persona.avatar, userAvatar: persona.userAvatar, tagline: persona.tagline }, messageCount: repos.messages.count(), lastSeq: repos.messages.maxSeq(), lastEventSeq: services.bus.lastSeq() };
  });

  server.get('/api/messages', { preHandler: auth }, async (req, reply) => {
    const parsed = HistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const { limit, before, since } = parsed.data;
    const cursorBefore = services.bus.lastSeq();
    if (since !== undefined) {
      const catchUp = repos.messages.pageSince(since, limit);
      return {
        messages: catchUp.messages,
        hasMore: catchUp.hasMore,
        nextSince: catchUp.nextSince,
        lastEventSeq: cursorBefore,
        lastMessageSeq: repos.messages.maxSeq(),
      };
    }
    const page = repos.messages.page(limit, before ?? null);
    return { messages: page.messages, hasMore: page.hasMore, lastEventSeq: cursorBefore, lastMessageSeq: repos.messages.maxSeq(), oldestSeq: page.messages[0]?.seq ?? null };
  });

  server.get('/api/messages/:id', { preHandler: auth }, async (req, reply) => {
    const msg = repos.messages.get((req.params as { id: string }).id);
    if (!msg) { reply.code(404); return { error: 'not_found' }; }
    return { message: msg };
  });

  server.post('/api/messages', { preHandler: auth }, async (req, reply) => {
    const blocked = rejectBlockedWrite(reply);
    if (blocked) return blocked;
    const parsed = SendMessageSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const input = parsed.data;
    const validation = validateInput(app, input.content, input.replyTo);
    if (validation) { reply.code(400); return validation; }
    const text = input.content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
    const directives = { ...parseUserDirectives(text), ...(input.directives ?? {}) };
    const tx = app.db.transaction(() => {
      const created = repos.messages.createInTransaction({
        role: 'user', status: 'sent', clientMsgId: input.clientMsgId, replyTo: input.replyTo ?? null,
        parts: input.content.map((part) => ({ type: part.type, text: part.type === 'text' ? part.text : null, mediaId: 'mediaId' in part ? part.mediaId : null, status: 'sent', duration: null, transcript: null })),
        meta: { directives }
      });
      const event = created.created ? services.bus.persist('message.received', { message: created.message }) : null;
      const batch = created.created ? repos.replyBatches.addMessage(created.message.id, services.replyCoordinator.dueAt()) : null;
      return { ...created, event, batch };
    });
    const { message, created, event, batch } = tx();
    if (!created) return { message, duplicate: true, replyPending: false };
    services.bus.fanout(event!);
    void services.replyCoordinator.enqueue(batch!.id, { recentMessages: env.CONTEXT_RECENT_MESSAGES, memoryLimit: env.CONTEXT_MEMORY_LIMIT }).catch((error) => {
      repos.errors.add('reply-coordinator', (error as Error).message);
    });
    return { message, duplicate: false, replyPending: true };
  });

  server.post('/api/messages/sync', { preHandler: auth }, async (req, reply) => {
    const blocked = rejectBlockedWrite(reply);
    if (blocked) return blocked;
    const parsed = SendMessageSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const input = parsed.data;
    const validation = validateInput(app, input.content, input.replyTo);
    if (validation) { reply.code(400); return validation; }
    const text = input.content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
    const directives = { ...parseUserDirectives(text), ...(input.directives ?? {}) };
    const tx = app.db.transaction(() => {
      const created = repos.messages.createInTransaction({
        role: 'user', status: 'sent', clientMsgId: input.clientMsgId, replyTo: input.replyTo ?? null,
        parts: input.content.map((part) => ({ type: part.type, text: part.type === 'text' ? part.text : null, mediaId: 'mediaId' in part ? part.mediaId : null, status: 'sent', duration: null, transcript: null })),
        meta: { directives }
      });
      const event = created.created ? services.bus.persist('message.received', { message: created.message }) : null;
      const batch = created.created ? repos.replyBatches.addMessage(created.message.id, services.replyCoordinator.dueAt()) : null;
      return { ...created, event, batch };
    });
    const { message, created, event, batch } = tx();
    if (!created) return { message, duplicate: true, reply: findReply(app, message.id) };
    services.bus.fanout(event!);
    const outcome = await services.replyCoordinator.enqueue(batch!.id, { recentMessages: env.CONTEXT_RECENT_MESSAGES, memoryLimit: env.CONTEXT_MEMORY_LIMIT });
    return { message, duplicate: false, reply: repos.messages.get(outcome.messageId), outcome };
  });

  server.post('/api/messages/:id/withdraw', { preHandler: auth }, async (req, reply) => {
    const blocked = rejectBlockedWrite(reply);
    if (blocked) return blocked;
    const id = (req.params as { id: string }).id;
    const now = Date.now();
    const windowMs = 5 * 60_000;
    // Coordinate eligibility, conditional state transition, parts replacement,
    // audit and the durable message.updated event in one SQLite transaction.
    // Only the winning caller (kind === 'withdrawn') persists an event; the
    // live fanout happens strictly after the transaction commits.
    const tx = app.db.transaction(() => {
      const result = repos.messages.withdraw(id, now, windowMs);
      if (result.kind === 'withdrawn') {
        repos.audit.add('message', 'withdrawn', id, { preservedPlaceholder: true });
        const event = services.bus.persist('message.updated', { message: result.message });
        return { result, event };
      }
      return { result, event: null };
    });
    const { result, event } = tx();
    if (result.kind === 'not_found') { reply.code(404); return { error: 'not_found' }; }
    if (result.kind === 'not_withdrawable') { reply.code(409); return { error: 'not_withdrawable' }; }
    if (result.kind === 'expired') { reply.code(409); return { error: 'withdraw_window_expired', message: '只能撤回五分钟内发送的消息' }; }
    if (result.kind === 'already_withdrawn') { return { duplicate: true, message: result.message }; }
    services.bus.fanout(event!);
    return { message: result.message };
  });

  server.get('/api/stickers', { preHandler: auth }, async () => ({ stickers: stickerList(app) }));

  /*
   * 首屏合并请求：会话信息 + 最新消息页 + 贴纸 + 生活状态一次返回，
   * 客户端不必再为同一块首屏串行打四个回源请求。只取最新一页消息，
   * 翻旧消息与断线追赶仍走 /api/messages。
   */
  server.get('/api/bootstrap', { preHandler: auth }, async (req, reply) => {
    const parsed = HistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const persona = app.config.getPersona();
    const lastEventSeq = services.bus.lastSeq();
    const page = repos.messages.page(parsed.data.limit, null);
    return {
      conversation: { conversationId: 'main', persona: { name: persona.name, avatar: persona.avatar, userAvatar: persona.userAvatar, tagline: persona.tagline }, messageCount: repos.messages.count(), lastSeq: repos.messages.maxSeq(), lastEventSeq },
      messages: { messages: page.messages, hasMore: page.hasMore, lastEventSeq, lastMessageSeq: repos.messages.maxSeq(), oldestSeq: page.messages[0]?.seq ?? null },
      stickers: stickerList(app),
      life: services.life.snapshot(),
    };
  });
}

function stickerList(app: SooyaApp) {
  return app.services.stickerLibrary.available().map((sticker) => ({ id: sticker.id, name: sticker.name, emotion: sticker.emotion, tags: sticker.tags, url: sticker.url, mediaId: sticker.mediaId }));
}

function rejectBlockedWrite(reply: FastifyReply): Record<string, unknown> | null {
  if (!maintenanceCoordinator.isWriteBlocked()) return null;
  const state = maintenanceCoordinator.state();
  reply.code(503).header('retry-after', '1');
  return { error: 'maintenance_in_progress', operation: state?.operation ?? 'maintenance', message: '系统正在执行恢复或清理，请稍后重试' };
}

function validateInput(app: SooyaApp, content: Array<{ type: string; mediaId?: string }>, replyTo?: string): Record<string, unknown> | null {
  for (const part of content) if (part.mediaId && !app.repos.media.get(part.mediaId)) return { error: 'unknown_media', mediaId: part.mediaId };
  if (replyTo && !app.repos.messages.get(replyTo)) return { error: 'unknown_reply_target', replyTo };
  return null;
}

function findReply(app: SooyaApp, userMessageId: string): ChatMessage | null {
  const batch = app.repos.replyBatches.findByMessage(userMessageId);
  if (batch?.assistant_message_id) return app.repos.messages.get(batch.assistant_message_id) ?? null;
  for (const message of app.repos.messages.recent(20).reverse()) {
    const batchMessageIds = message.meta?.batchMessageIds;
    if (message.role === 'assistant' && (message.replyTo === userMessageId || (Array.isArray(batchMessageIds) && batchMessageIds.includes(userMessageId)))) return message;
  }
  return null;
}
