import { z } from 'zod';
import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  messageId: z.string().trim().min(1).max(120).optional(),
  attemptId: z.string().trim().min(1).max(120).optional()
});

export function registerFlowTraceAdminRoutes(app: SooyaApp): void {
  const guard = { preHandler: requireAdminToken(app) };
  const list = (kind: 'user_reply' | 'proactive' | undefined, limit = 50, sourceId?: string) => {
    const traces = app.services.flowTrace.recent(200)
      .filter((trace) => !kind || trace.kind === kind)
      .filter((trace) => !sourceId || trace.sourceId === sourceId || trace.stages.some((stage) => stage.detail && Object.values(stage.detail).some((value) => value === sourceId)))
      .slice(0, limit);
    return { traces };
  };

  app.server.get('/api/admin/debug/flow-traces', guard, async (req, reply) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    return list(undefined, parsed.data.limit);
  });

  app.server.get('/api/admin/debug/message-flow', guard, async (req, reply) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    return list('user_reply', parsed.data.limit, parsed.data.messageId);
  });

  app.server.get('/api/admin/debug/proactive-flow', guard, async (req, reply) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    return list('proactive', parsed.data.limit, parsed.data.attemptId);
  });

  app.server.get('/api/admin/debug/flow-traces/:traceId', guard, async (req, reply) => {
    const { traceId } = req.params as { traceId: string };
    const trace = app.services.flowTrace.get(traceId);
    if (!trace) return reply.code(404).send({ error: 'not_found' });
    return { trace };
  });
}
