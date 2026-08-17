import type { SooyaApp } from '../app.js';
import { QQ_OP_ACK, QQ_OP_DISPATCH, QQ_OP_VALIDATION, type QqPayload, type QqValidationData } from '../channels/qq/types.js';
import { qqAppIdSummary } from '../channels/qq/config.js';

/*
 * QQ 官方 Bot webhook 回调（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §5 / §30）。
 * 认证与 Web/Admin 完全分开：webhook 只认 Ed25519 签名，Admin token 不适用。
 * - POST /api/qq/callback  op 13 → URL 验证回签
 * - POST /api/qq/callback  op 0  → 事件推送（签名校验 → 幂等 → 入站）
 * 未启用（QQ_BOT_ENABLED=false）时一律 404，不暴露回调路径是否存在。
 */
export function registerQqRoutes(app: SooyaApp): void {
  const { server } = app;
  const qq = app.services.qq;

  server.post('/api/qq/callback', async (req, reply) => {
    if (!qq.config.enabled || !qq.config.callbackSecret) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const payload = req.body as QqPayload;

    if (payload.op === QQ_OP_VALIDATION) {
      const response = qq.handleValidation(payload.d as QqValidationData | undefined);
      if (!response) {
        reply.code(400);
        return { error: 'bad_request', message: '验证参数缺失' };
      }
      return response;
    }

    if (payload.op !== QQ_OP_DISPATCH) {
      reply.code(400);
      return { error: 'bad_request', message: '不支持的 opcode' };
    }

    const rawBody = (req as { rawBody?: Buffer }).rawBody;
    const timestamp = req.headers['x-signature-timestamp'];
    const signature = req.headers['x-signature-ed25519'];
    const eventId = typeof payload.id === 'string' ? payload.id : null;
    if (!qq.verifyEvent(timestamp, signature, rawBody)) {
      app.repos.errors.add('qq.verify', 'rejected event push', {
        eventId,
        appId: qqAppIdSummary(qq.config.appId),
        code: 'signature_invalid'
      });
      return reply.code(401).send({ error: 'unauthorized' });
    }

    await qq.handleDispatch(payload);
    // 无论事件是否真正被消费，都回 op 12 确认收到；未消费的重复事件走 channel_event 幂等。
    return { op: QQ_OP_ACK };
  });
}