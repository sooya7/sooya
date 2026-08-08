import type { SooyaApp } from '../app.js';
import { requireAdminToken, requireChatToken } from './auth.js';
import type { DecisionTrace, VisibleThought } from '../core/thoughts/types.js';

/**
 * Read surface for the visible-thoughts layer. The ThoughtsService is wired
 * into `app.services.thoughts` by Integration (app.ts owns the service
 * construction); when it is absent (flags off / not yet wired) these routes
 * serve 404s and empty lists — the stable release behaviour.
 */
export interface ThoughtsApi {
  getUserThought(messageId: string): VisibleThought | null;
  getThoughtsForMessage(messageId: string): VisibleThought[];
  getTrace(batchId: string, revision: number): DecisionTrace | null;
  recentTraces(limit?: number): DecisionTrace[];
}

function thoughtsOf(app: SooyaApp): ThoughtsApi | null {
  const service = (app.services as unknown as { thoughts?: ThoughtsApi }).thoughts;
  return service ?? null;
}

const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/u;
const BATCH_ID_RE = /^[A-Za-z0-9_-]{1,80}$/u;

export function registerThoughtRoutes(app: SooyaApp): void {
  const { server, repos } = app;
  const auth = requireChatToken(app);

  /**
   * User-visible inner thought for a specific assistant message. Returns the
   * thought ONLY when the message exists and the thought is a completed,
   * user-visible inner monologue — admin-only decision summaries and
   * not-yet-published thoughts are never served here.
   */
  server.get('/api/thoughts/:messageId', { preHandler: auth }, async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    if (!MESSAGE_ID_RE.test(messageId ?? '')) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const message = repos.messages.get(messageId);
    if (!message) {
      reply.code(404);
      return { error: 'not_found', message: '消息不存在' };
    }
    const thoughts = thoughtsOf(app);
    const thought = thoughts ? thoughts.getUserThought(messageId) : null;
    if (!thought) {
      reply.code(404);
      return { error: 'not_found', message: '该消息没有可见想法' };
    }
    return { thought };
  });

  const admin = requireAdminToken(app);
  const guard = { preHandler: admin };

  /** Admin decision trace for one batch revision. */
  server.get('/api/admin/decision-trace', guard, async (req, reply) => {
    const query = (req.query ?? {}) as { batchId?: unknown; revision?: unknown };
    const batchId = typeof query.batchId === 'string' ? query.batchId : '';
    const revision = typeof query.revision === 'string' ? Number(query.revision) : Number.NaN;
    if (!BATCH_ID_RE.test(batchId) || !Number.isInteger(revision) || revision < 1) {
      reply.code(400);
      return { error: 'bad_request', message: 'batchId 与 revision 均为必填' };
    }
    const thoughts = thoughtsOf(app);
    const trace = thoughts ? thoughts.getTrace(batchId, revision) : null;
    if (!trace) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return { trace };
  });

  /** Admin decision traces, newest first. */
  server.get('/api/admin/decision-trace/recent', guard, async (req) => {
    const query = (req.query ?? {}) as { limit?: unknown };
    const limit = typeof query.limit === 'string' ? Math.min(Math.max(Number(query.limit) || 50, 1), 200) : 50;
    const thoughts = thoughtsOf(app);
    return { traces: thoughts ? thoughts.recentTraces(limit) : [] };
  });
}
