import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';

/** Admin inspect for Relationship threads (PR7): resolve / reopen / archive. */
export function registerRelationshipAdminRoutes(app: SooyaApp): void {
  const { server, repos } = app;
  const guard = requireAdminToken(app);

  server.get('/api/admin/relationship/threads', { preHandler: guard }, async (req) => {
    const query = req.query as { status?: string; limit?: string };
    const status =
      query.status === 'open' || query.status === 'cooling' || query.status === 'resolved' || query.status === 'archived'
        ? query.status
        : undefined;
    return {
      threads: repos.relationshipThreads.list({ status, limit: Math.max(1, Math.min(200, Number(query.limit ?? 50))) }),
      counts: repos.relationshipThreads.countByStatus()
    };
  });

  server.post('/api/admin/relationship/threads/:id/resolve', { preHandler: guard }, async (req) => {
    const { id } = req.params as { id: string };
    return { thread: repos.relationshipThreads.resolve(id) ?? null };
  });

  server.post('/api/admin/relationship/threads/:id/reopen', { preHandler: guard }, async (req) => {
    const { id } = req.params as { id: string };
    return { thread: repos.relationshipThreads.touch(id) ?? null };
  });

  server.post('/api/admin/relationship/threads/:id/archive', { preHandler: guard }, async (req) => {
    const { id } = req.params as { id: string };
    return { ok: repos.relationshipThreads.archive(id) };
  });

  server.get('/api/admin/relationship/context', { preHandler: guard }, async () => {
    return { lines: app.services.relationshipContext.contextLines() };
  });
}
