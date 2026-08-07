import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';

/**
 * Admin read endpoints for the v2 life system (vitals / themes / threads /
 * activity usage / share candidates). Panel UI lives in the web app; these
 * expose the same data the engine reasons over.
 */
export function registerLifeAdminRoutes(app: SooyaApp): void {
  const { server, repos } = app;
  const guard = requireAdminToken(app);

  server.get('/api/admin/life/vitals', { preHandler: guard }, async () => {
    const row = repos.lifeV2.getVitals();
    return { vitals: row ?? null };
  });

  server.get('/api/admin/life/themes', { preHandler: guard }, async (req) => {
    const days = Math.max(1, Math.min(60, Number((req.query as { days?: string }).days ?? 14)));
    return { themes: repos.lifeV2.recentThemes(days) };
  });

  server.get('/api/admin/life/threads', { preHandler: guard }, async () => ({ threads: repos.lifeV2.threads() }));

  server.get('/api/admin/life/usage', { preHandler: guard }, async () => ({ usage: repos.lifeV2.recentActivityUsage(30) }));

  server.get('/api/admin/life/share-candidates', { preHandler: guard }, async (req) => {
    const status = (req.query as { status?: string }).status;
    return { candidates: repos.lifeV2.shareCandidates(status) };
  });

  server.get('/api/admin/life/plans', { preHandler: guard }, async () => ({ plans: repos.life.listPlans() }));

  server.get('/api/admin/life/events', { preHandler: guard }, async (req) => {
    const limit = Math.max(1, Math.min(200, Number((req.query as { limit?: string }).limit ?? 50)));
    return { events: repos.life.events(limit) };
  });
}
