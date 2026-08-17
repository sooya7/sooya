import { z } from 'zod';
import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';
import { qqCredentialStatus } from '../channels/qq/config.js';
import { QQ_CHANNEL_NAME } from '../channels/qq/types.js';

/*
 * QQ 通道管理（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §17 / §30）。
 * 只暴露状态摘要与投递队列：绝不显示 App Secret / Access Token / 签名 Secret，
 * 错误只保留 event/message id + 错误码 + 摘要。
 */
const DeliveryQuerySchema = z.object({ status: z.enum(['pending', 'sending', 'retry', 'sent', 'failed']).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
const RetryParamsSchema = z.object({ id: z.string().min(1).max(80) });
const TestSendSchema = z.object({ content: z.string().trim().min(1).max(2000) });

export function registerQqAdminRoutes(app: SooyaApp): void {
  const { server, repos, services } = app;
  const guard = { preHandler: requireAdminToken(app) };
  const qq = services.qq;
  const deliveries = repos.channelDeliveries;

  server.get('/api/admin/qq/status', guard, async () => {
    const status = qqCredentialStatus(qq.config);
    const owner = repos.channelIdentities.findOwner(QQ_CHANNEL_NAME);
    return {
      ...status,
      owner: owner ? { externalUserId: owner.external_user_id, boundAt: owner.created_at, lastSeenAt: owner.last_seen_at } : null,
      counts: {
        pending: deliveries.countByStatus(QQ_CHANNEL_NAME, 'pending'),
        retry: deliveries.countByStatus(QQ_CHANNEL_NAME, 'retry'),
        sending: deliveries.countByStatus(QQ_CHANNEL_NAME, 'sending'),
        failed: deliveries.countByStatus(QQ_CHANNEL_NAME, 'failed'),
        sent: deliveries.countByStatus(QQ_CHANNEL_NAME, 'sent')
      },
      metrics: services.metrics.aggregates(7).filter((row) => row.category === "qq")
    };
  });

  server.get('/api/admin/qq/events', guard, async () => {
    const events = repos.channelEvents.recent(QQ_CHANNEL_NAME, 30).map((event) => ({
      eventId: event.event_id,
      eventType: event.event_type,
      status: event.status,
      errorCode: event.error_code,
      messageId: event.message_id,
      receivedAt: event.received_at,
      processedAt: event.processed_at
    }));
    return { events };
  });

  server.get('/api/admin/qq/deliveries', guard, async (req, reply) => {
    const parsed = DeliveryQuerySchema.safeParse(req.query);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const rows = deliveries.recent(QQ_CHANNEL_NAME, parsed.data.limit);
    const filtered = parsed.data.status ? rows.filter((row) => row.status === parsed.data.status) : rows;
    return {
      deliveries: filtered.map((row) => ({
        id: row.id,
        messageId: row.message_id,
        externalConversationId: row.external_conversation_id,
        status: row.status,
        attempts: row.attempts,
        nextRetryAt: row.next_retry_at,
        remoteMessageId: row.remote_message_id,
        lastErrorCode: row.last_error_code,
        lastErrorSummary: row.last_error_summary,
        createdAt: row.created_at,
        deliveredAt: row.delivered_at
      }))
    };
  });

  server.post('/api/admin/qq/deliveries/:id/retry', guard, async (req, reply) => {
    const parsed = RetryParamsSchema.safeParse(req.params);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const row = deliveries.getById(parsed.data.id);
    if (!row || row.channel !== QQ_CHANNEL_NAME) { reply.code(404); return { error: 'not_found' }; }
    if (!deliveries.resetForRetry(row.id)) {
      reply.code(409);
      return { error: 'not_retryable', message: '只有失败或退避中的投递可以手动重试' };
    }
    repos.jobs.enqueue('qq.deliver', { messageId: row.message_id, conversationId: row.external_conversation_id }, { maxAttempts: 1 });
    return { deliveryId: row.id, status: 'pending' };
  });

  server.post('/api/admin/qq/test-send', guard, async (req, reply) => {
    if (!qq.config.enabled) { reply.code(409); return { error: 'qq_disabled' }; }
    const parsed = TestSendSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const result = await services.qqDelivery.testSendToOwner(parsed.data.content);
    return result;
  });

  server.get('/api/admin/qq/errors', guard, async () => {
    const rows = app.repos.errors.list(100).filter((row) => row.scope.startsWith('qq.'));
    return {
      errors: rows.map((row) => ({ scope: row.scope, message: row.message, detail: row.detail, createdAt: row.createdAt }))
    };
  });
}