import { z } from 'zod';
import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';
import { toLifeLocation } from '../db/repos/location.repo.js';

const LocationKindSchema = z.enum(['home','neighborhood','cafe','restaurant','store','park','library','mall','transit','work','study','venue','outdoor','other']);
const LocationWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: LocationKindSchema,
  city: z.string().trim().max(80).nullable().optional(),
  region: z.string().trim().max(80).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  timeZone: z.string().trim().max(80).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  indoor: z.boolean().optional(),
  visitWeight: z.number().min(0).max(10).optional()
});
const LocationOverrideSchema = z.object({
  locationId: z.string().min(1).max(80),
  reason: z.string().trim().max(200).optional()
});
const IdParams = z.object({ id: z.string().min(1).max(80) });

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

  // ---- locations (next phase) ----

  server.get('/api/admin/life/locations', { preHandler: guard }, async () => ({ locations: app.services.location.list() }));

  server.post('/api/admin/life/locations', { preHandler: guard }, async (req, reply) => {
    const parsed = LocationWriteSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const row = repos.locations.create({ ...parsed.data, source: 'admin' });
    repos.audit.add('life.location', 'create', row.id, { name: row.name, kind: row.kind });
    return { location: toLifeLocation(row) };
  });

  server.patch('/api/admin/life/locations/:id', { preHandler: guard }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) { reply.code(400); return { error: 'bad_request', issues: params.error.issues }; }
    const parsed = LocationWriteSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const row = repos.locations.update(params.data.id, parsed.data);
    if (!row) { reply.code(404); return { error: 'not_found' }; }
    repos.audit.add('life.location', 'update', row.id, { name: row.name });
    return { location: toLifeLocation(row) };
  });

  server.delete('/api/admin/life/locations/:id', { preHandler: guard }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) { reply.code(400); return { error: 'bad_request', issues: params.error.issues }; }
    const row = repos.locations.get(params.data.id);
    if (!row) { reply.code(404); return { error: 'not_found' }; }
    repos.locations.deactivate(params.data.id);
    repos.locations.deleteEdgesTo(params.data.id);
    repos.audit.add('life.location', 'delete', params.data.id, { name: row.name });
    return { ok: true };
  });

  /** Explicit admin override — always audited; the admin cannot bypass the coordinator. */
  server.post('/api/admin/life/location/override', { preHandler: guard }, async (req, reply) => {
    const parsed = LocationOverrideSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const location = app.services.location.override(parsed.data.locationId, parsed.data.reason ?? 'admin override');
    if (!location) { reply.code(404); return { error: 'not_found' }; }
    return { location };
  });

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
