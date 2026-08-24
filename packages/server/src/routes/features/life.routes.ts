import { z } from 'zod';
import type { SooyaApp } from '../../app.js';
import { requireAdminToken } from '../auth.js';
import { LifePolicySchema } from '../../config/schema.js';
import { IdSchema } from './shared.js';

export function registerLifeFeatureRoutes(app: SooyaApp): void {
  const { server, repos, services, config } = app;
  const admin = requireAdminToken(app);
  const adminGuard = { preHandler: admin };

  server.post('/api/admin/life/tick', adminGuard, async () => {
    const result = services.life.tick();
    const presence = services.presence.sync('admin.life.tick');
    return { ...result, snapshot: services.life.snapshot(), presence };
  });

  server.get('/api/admin/life', adminGuard, async () => {
    const evaluation = services.proactive.evaluate();
    const settings = services.life.settings;
    return {
      snapshot: services.life.snapshot(),
      log: repos.life.recent(24),
      plans: repos.life.listPlans().slice(0, 50),
      events: repos.life.events(50),
      proactive: repos.proactive.list(50),
      reachOut: {
        reach: evaluation.reach,
        reason: evaluation.reason,
        candidate: evaluation.candidate ? { id: evaluation.candidate.id, activity: evaluation.candidate.activity, endedAt: evaluation.candidate.ended_at } : null,
        sharedLastDay: repos.life.countSharedSince(new Date(Date.now() - 86_400_000).toISOString()),
        lastUserAt: evaluation.lastUserAt,
        lastAssistantAt: evaluation.lastAssistantAt,
        enabledByDeployment: app.env.ENABLE_LIFE_ENGINE && app.env.ENABLE_LIFE_REACH_OUT
      },
      settings: {
        reachOut: settings.reachOut,
        quietGapMinutes: settings.quietGapMinutes,
        maxReachOutsPerDay: settings.maxReachOutsPerDay,
        silentFrom: settings.silentHours.from,
        silentTo: settings.silentHours.to,
        tzOffsetMinutes: settings.tzOffsetMinutes,
        proactiveMode: settings.proactiveMode ?? 'auto'
      }
    };
  });

  server.post('/api/admin/life/plans', adminGuard, async (req, reply) => {
    const parsed = z.object({
      title: z.string().trim().min(1).max(200),
      kind: z.string().trim().min(1).max(40),
      plannedStart: z.string().trim().max(80).nullable().optional(),
      plannedEnd: z.string().trim().max(80).nullable().optional(),
      status: z.enum(['planned', 'active', 'paused', 'completed', 'cancelled', 'skipped']).optional(),
      source: z.enum(['routine', 'generated', 'admin', 'conversation']).optional(),
      priority: z.number().int().min(-100).max(100).optional()
    }).safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_life_plan', message: parsed.error.message.slice(0, 300) };
    }
    const plan = repos.life.createPlan(parsed.data);
    repos.audit.add('life', 'plan.created', plan.id, { title: plan.title, kind: plan.kind, status: plan.status });
    services.bus.publish('life.updated', { plan: plan.id });
    return { plan };
  });

  server.patch('/api/admin/life/plans/:id', adminGuard, async (req, reply) => {
    const id = String((req.params as { id: string }).id);
    if (!IdSchema.test(id)) {
      reply.code(400);
      return { error: 'bad_plan_id' };
    }
    const parsed = z.object({
      title: z.string().trim().min(1).max(200).optional(),
      kind: z.string().trim().min(1).max(40).optional(),
      plannedStart: z.string().trim().max(80).nullable().optional(),
      plannedEnd: z.string().trim().max(80).nullable().optional(),
      status: z.enum(['planned', 'active', 'paused', 'completed', 'cancelled', 'skipped']).optional(),
      priority: z.number().int().min(-100).max(100).optional()
    }).safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_life_plan', message: parsed.error.message.slice(0, 300) };
    }
    const existing = repos.life.getPlan(id);
    if (!existing) {
      reply.code(404);
      return { error: 'life_plan_not_found' };
    }
    if (existing.status === 'completed') {
      reply.code(409);
      return { error: 'immutable', message: '已完成计划的历史不允许直接篡改' };
    }
    const plan = repos.life.updatePlan(id, {
      ...parsed.data,
      planned_start: parsed.data.plannedStart,
      planned_end: parsed.data.plannedEnd
    });
    if (!plan) {
      reply.code(404);
      return { error: 'life_plan_not_found' };
    }
    repos.audit.add('life', 'plan.updated', plan.id, { status: plan.status });
    services.bus.publish('life.updated', { plan: plan.id });
    return { plan };
  });

  server.put('/api/admin/life/settings', adminGuard, async (req, reply) => {
    const parsed = LifePolicySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_life_policy', message: parsed.error.message.slice(0, 300) };
    }
    const persona = config.setPersona({ lifePolicy: { ...config.getPersona().lifePolicy, ...parsed.data } });
    repos.audit.add('life', 'settings', null, parsed.data as Record<string, unknown>);
    services.bus.publish('life.updated', { settings: true });
    const settings = services.life.settings;
    return {
      lifePolicy: persona.lifePolicy,
      settings: {
        reachOut: settings.reachOut,
        quietGapMinutes: settings.quietGapMinutes,
        maxReachOutsPerDay: settings.maxReachOutsPerDay,
        silentFrom: settings.silentHours.from,
        silentTo: settings.silentHours.to,
        tzOffsetMinutes: settings.tzOffsetMinutes,
        proactiveMode: settings.proactiveMode ?? 'auto'
      }
    };
  });
}
