import type { FastifyInstance } from 'fastify';
import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';

/** §37: rotatable admin tokens with a creation/revoke surface. */
export function registerTokenAdminRoutes(app: SooyaApp): void {
  const guard = requireAdminToken(app);

  app.server.get('/api/admin/tokens', { preHandler: guard }, async () => ({
    tokens: app.repos.authTokens.list()
  }));

  app.server.post('/api/admin/tokens', { preHandler: guard }, async (req) => {
    const body = (req.body ?? {}) as { label?: string };
    // The plaintext is returned exactly once; only its hash is stored.
    const created = app.repos.authTokens.create(String(body.label ?? 'rotated'));
    return { token: created.token, view: created.view };
  });

  app.server.post('/api/admin/tokens/:id/revoke', { preHandler: guard }, async (req) => {
    const { id } = req.params as { id: string };
    return { ok: app.repos.authTokens.revoke(id) };
  });
}
