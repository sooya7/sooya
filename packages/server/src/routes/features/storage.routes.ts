import { z } from 'zod';
import type { SooyaApp } from '../../app.js';
import { requireAdminToken } from '../auth.js';

export function registerStorageFeatureRoutes(app: SooyaApp): void {
  const { server, repos, services } = app;
  const admin = requireAdminToken(app);
  const adminGuard = { preHandler: admin };

  server.get('/api/admin/storage', adminGuard, async () => await services.storage.status());
  server.put('/api/admin/storage/policy', adminGuard, async (req, reply) => {
    const parsed = z.object({
      softLimitBytes: z.number().int().positive().optional(),
      hardLimitBytes: z.number().int().positive().optional(),
      trashRetentionDays: z.number().int().positive().optional(),
      tempRetentionHours: z.number().int().positive().optional(),
      backupKeep: z.number().int().positive().optional()
    }).safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    return { policy: services.storage.setPolicy(parsed.data) };
  });

  server.post('/api/admin/storage/cleanup', adminGuard, async (req, reply) => {
    const parsed = z.object({
      apply: z.boolean().default(false),
      categories: z.array(z.string()).max(10).optional(),
      reportId: z.string().regex(/^cleanup_[A-Za-z0-9_-]{10,80}$/u).optional()
    }).safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'bad_request' }; }
    if (parsed.data.apply && !parsed.data.reportId) {
      reply.code(409);
      return { error: 'cleanup_report_required', message: '请先生成并确认清理预览' };
    }
    try {
      return await services.storage.cleanup(parsed.data);
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      if (code === 'CLEANUP_REPORT_REQUIRED' || code === 'CLEANUP_REPORT_INVALID') {
        reply.code(409);
        return { error: 'cleanup_report_invalid', message: '清理预览不存在或已过期，请重新预览' };
      }
      throw error;
    }
  });

  server.get('/api/admin/audit', adminGuard, async (req) => ({ audit: repos.audit.list(Number((req.query as { limit?: string }).limit ?? 100)) }));
}
