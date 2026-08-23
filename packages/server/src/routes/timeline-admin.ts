import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';

/** Timeline admin view (§23): browse shared episodes by day/week. */
export function registerTimelineAdminRoutes(app: SooyaApp): void {
  const { server, repos } = app;
  const guard = requireAdminToken(app);

  server.get('/api/admin/timeline/episodes', { preHandler: guard }, async (req) => {
    const query = req.query as { from?: string; to?: string; limit?: string };
    const today = new Date().toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from ?? '') ? query.from! : today;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to ?? '') ? query.to! : from;
    return { episodes: repos.episodes.listByDateRange(from, to, Math.max(1, Math.min(200, Number(query.limit ?? 100)))) };
  });

  server.get('/api/admin/timeline/episodes/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const episode = repos.episodes.get(id);
    if (!episode) return reply.code(404).send({ error: 'not found' });
    return { episode };
  });
}
