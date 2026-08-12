import type { SooyaApp } from '../app.js';
import { checkIntegrity } from '../db/index.js';

/**
 * Health endpoints are intentionally NOT behind WEB_CHAT_TOKEN so deployment
 * scripts and container probes can call them on localhost without a secret.
 * They expose no chat content and no secrets.
 */
export function registerHealthRoutes(app: SooyaApp): void {
  const { server } = app;

  server.get('/health/live', async () => ({
    status: 'live',
    version: app.state.version,
    startedAt: app.state.startedAt,
    uptimeSec: Math.round(process.uptime())
  }));

  server.get('/health/ready', async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      const row = app.db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number };
      checks.database = { ok: typeof row.c === 'number' };
    } catch (err) {
      checks.database = { ok: false, detail: (err as Error).message };
    }
    try {
      checks.mediaDir = { ok: true, detail: app.env.mediaDir };
    } catch (err) {
      checks.mediaDir = { ok: false, detail: (err as Error).message };
    }
    checks.stickers = { ok: true, detail: `${app.services.stickerLibrary.count()} available` };
    checks.jobs = { ok: true, detail: `${app.repos.jobs.pendingCount()} pending` };

    const ready = Object.values(checks).every((c) => c.ok);
    if (!ready) reply.code(503);
    return {
      status: ready ? 'ready' : 'degraded',
      version: app.state.version,
      dbRecovered: app.state.dbRecovered,
      dbRecoveredFrom: app.state.dbRecoveredFrom ?? null,
      checks
    };
  });

  /** Capability status: which model features are usable right now. */
  server.get('/api/capabilities', { preHandler: [] }, async () => {
    const statuses = await app.services.capabilities.statuses();
    return {
      capabilities: statuses,
      stickers: { available: app.services.stickerLibrary.count(), total: app.services.stickerLibrary.all().length },
      memory: app.env.MEMORY_BACKEND === 'ombre'
        ? app.services.ombreMemory.health()
        : { backend: 'legacy', ...app.services.memory.stats() },
      mcp: app.services.mcpManager.health(),
      agent: { active: app.services.agents.active, tools: app.services.tools.size() }
    };
  });

  server.get('/health/deep', async (_req, reply) => {
    const integrity = checkIntegrity(app.db.raw);
    const statuses = await app.services.capabilities.statuses();
    if (integrity) reply.code(503);
    return {
      status: integrity ? 'unhealthy' : 'healthy',
      integrity: integrity ?? 'ok',
      memory: app.env.MEMORY_BACKEND === 'ombre' ? app.services.ombreMemory.health() : { backend: 'legacy' },
      mcp: app.services.mcpManager.health(),
      capabilities: Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k, { configured: v.configured, ok: v.ok }]))
    };
  });
}
