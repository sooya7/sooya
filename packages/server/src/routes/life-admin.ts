import { z } from 'zod';
import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';

const ThreadCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(40).default('admin'),
  nextActions: z.array(z.string().min(1).max(80)).max(10).optional(),
  relatedActivityIds: z.array(z.string().min(1).max(40)).max(10).optional()
});

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

  /** E4: admin-created thread (creation source #4). */
  server.post('/api/admin/life/threads', { preHandler: guard }, async (req, reply) => {
    const parsed = ThreadCreateSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const { title, category, nextActions, relatedActivityIds } = parsed.data;
    const thread = repos.lifeV2.saveThread({
      title,
      category,
      status: 'open',
      progress: 0,
      importance: 0.5,
      heat: 0.4,
      nextActions: nextActions ?? [],
      meta: { relatedActivityIds: relatedActivityIds ?? [], source: 'admin' }
    });
    return { thread };
  });

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
