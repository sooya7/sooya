import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import type { SooyaApp } from '../app.js';
import { requireChatToken } from './auth.js';
import { SendMessageSchema } from '../core/types.js';
import { MessageIngressValidationError, toIngressInput } from '../core/message-ingress.js';
import { maintenanceCoordinator } from '../core/maintenance.js';

const HistoryQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.coerce.number().int().min(0).optional(), since: z.coerce.number().int().min(0).optional() });
const MessageContextQuerySchema = z.object({ before: z.coerce.number().int().min(0).max(100).default(20), after: z.coerce.number().int().min(0).max(100).default(20) });
const MessageSearchQuerySchema = z.object({ q: z.string().trim().min(1).max(200), limit: z.coerce.number().int().min(1).max(50).default(30), cursor: z.string().regex(/^\d+$/u).optional() });
const MessageDateQuerySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), timeZone: z.string().trim().min(1).max(100).default('Asia/Shanghai'), limit: z.coerce.number().int().min(1).max(500).default(200) });
const MessageIdParamsSchema = z.object({ id: z.string().min(1).max(80) });

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

  server.get('/api/messages/search', { preHandler: auth }, async (req, reply) => {
    const parsed = MessageSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    return repos.messages.search(parsed.data.q, parsed.data.limit, parsed.data.cursor);
  });

  server.get('/api/messages/by-date', { preHandler: auth }, async (req, reply) => {
    const parsed = MessageDateQuerySchema.safeParse(req.query);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    try {
      return { date: parsed.data.date, timeZone: parsed.data.timeZone, ...repos.messages.byDate(parsed.data.date, parsed.data.timeZone, parsed.data.limit) };
    } catch {
      reply.code(400);
      return { error: 'bad_request', message: '日期或时区无效' };
    }
  });

  server.get('/api/messages/:id', { preHandler: auth }, async (req, reply) => {
    const params = MessageIdParamsSchema.safeParse(req.params);
    if (!params.success) { reply.code(400); return { error: 'bad_request', issues: params.error.issues }; }
    const msg = repos.messages.get(params.data.id);
    if (!msg) { reply.code(404); return { error: 'not_found' }; }
    return { message: msg };
  });

  server.get('/api/messages/:id/context', { preHandler: auth }, async (req, reply) => {
    const params = MessageIdParamsSchema.safeParse(req.params);
    if (!params.success) { reply.code(400); return { error: 'bad_request', issues: params.error.issues }; }
    const parsed = MessageContextQuerySchema.safeParse(req.query);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const { id } = params.data;
    const context = repos.messages.context(id, parsed.data.before, parsed.data.after);
    if (!context) { reply.code(404); return { error: 'not_found' }; }
    return context;
  });

  server.post('/api/messages', { preHandler: auth }, async (req, reply) => {
    const blocked = rejectBlockedWrite(reply);
    if (blocked) return blocked;
    const parsed = SendMessageSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    try {
      const result = await services.ingress.accept(toIngressInput(parsed.data));
      const message = repos.messages.get(result.messageId)!;
      if (result.duplicate) {
        return { message, duplicate: true, replyPending: result.replyPending, ...(result.replyPending ? { batchId: result.batchId } : {}) };
      }
      return { message, duplicate: false, replyPending: true };
    } catch (error) {
      if (error instanceof MessageIngressValidationError) { reply.code(400); return error.details; }
      throw error;
    }
  });

  server.post('/api/messages/sync', { preHandler: auth }, async (req, reply) => {
    const blocked = rejectBlockedWrite(reply);
    if (blocked) return blocked;
    const parsed = SendMessageSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    try {
      const result = await services.ingress.acceptAndReply(toIngressInput(parsed.data));
      const message = repos.messages.get(result.messageId)!;
      if (result.duplicate) return { message, duplicate: true, reply: result.reply };
      return { message, duplicate: false, reply: result.reply, outcome: result.outcome };
    } catch (error) {
      if (error instanceof MessageIngressValidationError) { reply.code(400); return error.details; }
      throw error;
    }
  });

  server.post('/api/reply-batches/:id/retry', { preHandler: auth }, async (req, reply) => {
    const blocked = rejectBlockedWrite(reply);
    if (blocked) return blocked;
    const params = MessageIdParamsSchema.safeParse(req.params);
    if (!params.success) { reply.code(400); return { error: 'bad_request', issues: params.error.issues }; }
    const batch = await services.replyCoordinator.retryBatch(params.data.id);
    if (!batch) {
      reply.code(409);
      return { error: 'not_retryable', message: '只有失败或部分完成的回复可以重新生成' };
    }
    return { batchId: batch.id, revision: batch.revision, status: batch.status };
  });

  server.post('/api/messages/:id/withdraw', { preHandler: auth }, async (req, reply) => {
    const blocked = rejectBlockedWrite(reply);
    if (blocked) return blocked;
    const params = MessageIdParamsSchema.safeParse(req.params);
    if (!params.success) { reply.code(400); return { error: 'bad_request', issues: params.error.issues }; }
    const id = params.data.id;
    const now = Date.now();
    const windowMs = env.WITHDRAW_WINDOW_MS;
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

  server.get('/api/stickers', { preHandler: auth }, async (req, reply) => {
    const parsed = StickerQuerySchema.safeParse(req.query);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const result = stickerList(app, parsed.data);
    return { stickers: result.stickers, total: result.total, nextCursor: result.nextCursor };
  });

  server.patch('/api/stickers/:id/preferences', { preHandler: auth }, async (req, reply) => {
    const id = String((req.params as { id?: string }).id ?? '');
    const parsed = z.object({ favorite: z.boolean() }).safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const current = repos.stickers.get(id);
    const media = current ? repos.media.get(current.mediaId) : undefined;
    if (!current || !current.enabled || !media || !services.mediaStore.exists(media)) { reply.code(404); return { error: 'not_found' }; }
    const sticker = repos.stickers.setFavorite(id, parsed.data.favorite);
    if (!sticker) { reply.code(404); return { error: 'not_found' }; }
    services.bus.publish('sticker.updated', { stickerId: id, favorite: sticker.favorite });
    return { sticker: publicSticker(sticker) };
  });

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
      stickers: stickerList(app).stickers,
      life: services.life.snapshot(),
      presence: services.presence.current(),
    };
  });
}

const StickerQuerySchema = z.object({
  scope: z.enum(['recent', 'favorite', 'all']).default('all'),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(60),
  cursor: z.string().regex(/^\d+$/u).optional()
});

function stickerList(app: SooyaApp, query: z.infer<typeof StickerQuerySchema> = { scope: 'all', limit: 60 }): { stickers: ReturnType<typeof publicSticker>[]; total: number; nextCursor: string | null } {
  const available = new Map(app.services.stickerLibrary.available().map((sticker) => [sticker.id, sticker]));
  const offset = Number(query.cursor ?? 0);
  // Cursor positions are over the stable repository result, not over the
  // filtered list of files that happen to exist on disk. Otherwise a missing
  // file shortens page N and `offset + visible.length` points back at the last
  // visible row, so the next request repeats it forever.
  const source = query.q
    ? app.repos.stickers.searchFts(query.q, { enabledOnly: true, scope: query.scope, limit: 500, offset: 0 })
    : app.repos.stickers.list({ enabledOnly: true, scope: query.scope });
  const stickers: ReturnType<typeof publicSticker>[] = [];
  let nextOffset = Math.min(offset, source.length);
  while (nextOffset < source.length && stickers.length < query.limit) {
    const row = source[nextOffset++];
    const item = row && available.get(row.id);
    if (item) stickers.push(publicSticker(item));
  }
  const total = source.filter((sticker) => available.has(sticker.id)).length;
  return { stickers, total, nextCursor: nextOffset < source.length ? String(nextOffset) : null };
}

function publicSticker(sticker: ReturnType<SooyaApp['services']['stickerLibrary']['available']>[number]) {
  return {
    id: sticker.id,
    mediaId: sticker.mediaId,
    name: sticker.name,
    emotion: sticker.emotion,
    description: sticker.description,
    imageText: sticker.imageText,
    tags: sticker.tags,
    favorite: sticker.favorite,
    userMeaning: sticker.userMeaning || null,
    assistantUseCount: sticker.assistantUseCount,
    assistantLastUsedAt: sticker.assistantLastUsedAt,
    userUseCount: sticker.userUseCount,
    analysisStatus: sticker.analysisStatus,
    userLastUsedAt: sticker.userLastUsedAt,
    url: sticker.url,
    animated: sticker.animated === true
  };
}

function rejectBlockedWrite(reply: FastifyReply): Record<string, unknown> | null {
  if (!maintenanceCoordinator.isWriteBlocked()) return null;
  const state = maintenanceCoordinator.state();
  reply.code(503).header('retry-after', '1');
  return { error: 'maintenance_in_progress', operation: state?.operation ?? 'maintenance', message: '系统正在执行恢复或清理，请稍后重试' };
}
