import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';
import type { CommitmentStatus } from '../core/future/types.js';

const StatusSchema = [
  'tentative',
  'pending',
  'due',
  'completed',
  'cancelled',
  'missed',
  'expired',
  'superseded'
] as const satisfies readonly CommitmentStatus[];

/**
 * Admin inspect for the Future engine (PR3 scope): see what the analyzer
 * extracted, how the lifecycle moved items, and clean up wrong extractions.
 * Panel UI lands with the later admin-pages phase.
 */
export function registerFutureAdminRoutes(app: SooyaApp): void {
  const { server, repos } = app;
  const guard = requireAdminToken(app);

  server.get('/api/admin/future/commitments', { preHandler: guard }, async (req) => {
    const query = req.query as { status?: string; limit?: string; archived?: string };
    const status = StatusSchema.includes(query.status as CommitmentStatus) ? (query.status as CommitmentStatus) : undefined;
    const commitments = repos.commitments.list({
      status,
      includeArchived: query.archived === 'true',
      limit: Math.max(1, Math.min(200, Number(query.limit ?? 50)))
    });
    return { commitments, counts: repos.commitments.countByStatus() };
  });

  server.get('/api/admin/future/context', { preHandler: guard }, async () => {
    const service = app.services.futureContext;
    return { lines: service ? service.contextLines() : [] };
  });

  server.post('/api/admin/future/commitments/:id/resolve', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { action?: string; outcome?: string };
    if (body.action !== 'completed' && body.action !== 'cancelled') {
      return reply.code(400).send({ error: 'action must be completed or cancelled' });
    }
    try {
      const commitment = repos.commitments.resolve(id, body.action, { outcome: body.outcome });
      return { commitment };
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  server.post('/api/admin/future/commitments/:id/archive', { preHandler: guard }, async (req) => {
    const { id } = req.params as { id: string };
    return { ok: repos.commitments.archive(id) };
  });

  server.post('/api/admin/future/commitments/:id/reschedule', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { startsAt?: string; dueAt?: string; title?: string };
    const current = repos.commitments.get(id);
    if (!current) return reply.code(404).send({ error: 'not found' });
    const { previous, replacement } = repos.commitments.supersede(id, {
      kind: current.kind,
      subject: current.subject,
      title: body.title ?? current.title,
      startsAt: body.startsAt ?? current.startsAt,
      dueAt: body.dueAt ?? current.dueAt,
      timePrecision: current.timePrecision,
      sourceMessageId: current.sourceMessageId,
      followUpPolicy: current.followUpPolicy
    });
    return { previous, replacement };
  });

  server.delete('/api/admin/future/commitments/:id', { preHandler: guard }, async (req) => {
    const { id } = req.params as { id: string };
    return { ok: repos.commitments.delete(id) };
  });
}
