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
const VitalsAdjustSchema = z.object({
  field: z.enum(['energy','hunger','stress','social_need','loneliness','curiosity','comfort','focus']),
  delta: z.number().min(-50).max(50)
});
const PlanPatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  kind: z.string().trim().min(1).max(40).optional(),
  status: z.enum(['planned','active','paused','cancelled','skipped']).optional(),
  plannedStart: z.string().datetime().nullable().optional(),
  plannedEnd: z.string().datetime().nullable().optional(),
  priority: z.number().min(0).max(1).optional()
});
const ThreadPatchSchema = z.object({
  status: z.enum(['open','paused','resolved','abandoned'])
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

  // ---- P1: Life Admin management APIs ----

  /** Aggregated overview: where she is, what she is doing, and why. */
  server.get('/api/admin/life/overview', { preHandler: guard }, async () => {
    const snapshot = app.services.life.snapshot();
    const world = app.services.world.snapshot();
    const vitals = repos.lifeV2.getVitals() ?? null;
    const activePlan = repos.life.listPlans().find((p) => p.status === 'active') ?? null;
    const openThreads = repos.lifeV2.threads('open').slice(0, 3);
    const recentEvents = repos.life.events(8);
    const location = world.location;
    const weather = world.weatherCondition;
    return {
      snapshot,
      location: location ? { id: location.id, name: location.name, kind: location.kind } : null,
      weather,
      vitals,
      activePlan: activePlan ? { id: activePlan.id, title: activePlan.title, kind: activePlan.kind, status: activePlan.status } : null,
      openThreads: openThreads.map((t) => ({ id: t.id, title: t.title, progress: Math.round(t.progress * 100) })),
      recentEvents: recentEvents.map((e) => ({ id: e.id, eventType: e.event_type, description: e.description, happenedAt: e.happened_at }))
    };
  });

  server.get('/api/admin/life/proactive', { preHandler: guard }, async () => ({ attempts: repos.proactive.list(100) }));

  /** Small vitals adjustment — audited, clamped to 0..100. */
  server.post('/api/admin/life/vitals/adjust', { preHandler: guard }, async (req, reply) => {
    const parsed = VitalsAdjustSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const { field, delta } = parsed.data;
    let current = repos.lifeV2.getVitals();
    if (!current) {
      repos.lifeV2.upsertVitals({ energy: 72, hunger: 40, stress: 30, social_need: 35, loneliness: 30, curiosity: 55, comfort: 60, focus: 55, sleep_debt: 1.5, updated_at: new Date().toISOString(), meta_json: '{}' });
      current = repos.lifeV2.getVitals()!;
    }
    const next = { ...current, [field]: Math.max(0, Math.min(100, current[field] + delta)), updated_at: new Date().toISOString() };
    repos.lifeV2.upsertVitals(next);
    repos.audit.add('life.vitals', 'adjust', null, { field, delta });
    return { vitals: next };
  });

  server.post('/api/admin/life/vitals/reset', { preHandler: guard }, async () => {
    const defaults = { energy: 72, hunger: 40, stress: 30, social_need: 35, loneliness: 30, curiosity: 55, comfort: 60, focus: 55, sleep_debt: 1.5 };
    repos.lifeV2.upsertVitals({ ...defaults, updated_at: new Date().toISOString(), meta_json: '{}' });
    repos.audit.add('life.vitals', 'reset', null, {});
    return { ok: true };
  });

  /** Threads: pause / resolve / archive (keeps the active-thread cap). */
  server.patch('/api/admin/life/threads/:id', { preHandler: guard }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) { reply.code(400); return { error: 'bad_request', issues: params.error.issues }; }
    const parsed = ThreadPatchSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const thread = repos.lifeV2.getThread(params.data.id);
    if (!thread) { reply.code(404); return { error: 'not_found' }; }
    const status = parsed.data.status;
    const next = repos.lifeV2.saveThread({
      id: thread.id,
      title: thread.title,
      category: thread.category,
      status,
      progress: thread.progress,
      heat: thread.heat,
      nextActions: JSON.parse(thread.next_actions_json)
    });
    repos.audit.add('life.thread', 'update', thread.id, { status });
    return { thread: next };
  });

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

  // Cities / travel (next phase final, v25).
  server.get('/api/admin/life/cities', { preHandler: guard }, async () => ({ cities: app.services.location.listCities() }));
  server.post('/api/admin/life/cities', { preHandler: guard }, async (req, reply) => {
    // 产品范围：中国城市、统一 Asia/Shanghai。country/timeZone 由服务端
    // 固定（country=中国、timeZone=env.LIFE_TIME_ZONE），不作为用户可配置项。
    const body = (req.body ?? {}) as { name?: string; region?: string };
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      reply.code(400);
      return { error: 'bad_request', message: 'name is required' };
    }
    const city = app.services.location.createCity({
      name: body.name.trim(),
      ...(typeof body.region === 'string' && body.region.trim() ? { region: body.region.trim() } : {}),
      country: '中国',
      timeZone: app.env.LIFE_TIME_ZONE
    });
    repos.audit.add('life.city', 'created', city.id, { name: city.name });
    return { city };
  });
  server.patch('/api/admin/life/cities/:id', { preHandler: guard }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { name?: string; region?: string | null; active?: boolean };
    // 设为当前城市必须走 canonical 切换（清 movement、迁移归属、Weather 跟随）。
    if (body.active === true) {
      const switched = app.services.location.setActiveCity(id);
      if (!switched) {
        reply.code(404);
        return { error: 'not_found' };
      }
      repos.audit.add('life.city', 'activated', id);
      return { city: switched };
    }
    const city = app.services.location.updateCity(id, {
      ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}),
      ...(body.region !== undefined ? { region: body.region } : {}),
      ...(body.active === false ? { active: false } : {})
    });
    if (!city) {
      reply.code(404);
      return { error: 'not_found' };
    }
    repos.audit.add('life.city', 'updated', id, { patch: body });
    return { city };
  });
  server.get('/api/admin/life/travel', { preHandler: guard }, async () => ({ travel: app.services.location.currentTravel() }));
}
