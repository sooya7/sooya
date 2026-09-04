import type { SooyaApp } from '../app.js';
import { checkIntegrity } from '../db/index.js';

/**
 * Health endpoints intentionally require no Admin token so deployment
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
    // Report reachability, not the absolute host path: probes only need ok/not-ok.
    checks.mediaDir = { ok: true };
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

  /**
   * Capability status: which model features are usable right now.
   *
   * Deliberately unauthenticated so deploy scripts and probes can call it on
   * localhost (docs/DEPLOYMENT.md), which is exactly why the payload must stay
   * genuinely non-sensitive. Stripped here, on purpose:
   *
   * - `provider` / `model` — fingerprints which vendor and model the deployment
   *   pays for. Nothing operational needs it from an unauthenticated caller.
   * - `detail` — free text. On an SSRF rejection it reads
   *   `private address blocked: <host> -> <ip>` (util/http.ts), i.e. it leaks
   *   internal hostnames and resolved private IPs straight to the caller.
   * - MCP / memory `lastError` — free text that normally carries the MCP server
   *   URL and port.
   *
   * The full, unredacted view lives behind the Admin token at
   * `GET /api/admin/capabilities`, which is what the web console actually uses.
   */
  server.get('/api/capabilities', { preHandler: [] }, async () => {
    const statuses = await app.services.capabilities.statuses();
    const publicStatuses = Object.fromEntries(
      Object.entries(statuses).map(([name, status]) => [name, {
        capability: status.capability,
        configured: status.configured,
        ok: status.ok,
        checkedAt: status.checkedAt
      }])
    );
    const memory = app.env.MEMORY_BACKEND === 'ombre'
      ? app.services.ombreMemory.health()
      : { backend: 'legacy' as const, ...app.services.memory.stats() };
    const { lastError: _memoryError, ...publicMemory } = memory as typeof memory & { lastError?: string };
    return {
      capabilities: publicStatuses,
      stickers: { available: app.services.stickerLibrary.count(), total: app.services.stickerLibrary.all().length },
      memory: publicMemory,
      mcp: app.services.mcpManager.health().map((snapshot) => ({
        id: snapshot.id,
        enabled: snapshot.enabled,
        state: snapshot.state,
        toolCount: snapshot.toolCount
      })),
      agent: { active: app.services.agents.active, tools: app.services.tools.size() }
    };
  });

  server.get('/health/deep', async (_req, reply) => {
    const integrity = checkIntegrity(app.db.raw);
    const statuses = await app.services.capabilities.statuses();
    if (integrity) reply.code(503);
    const ombre = app.services.ombreMemory.health();
    const { lastError: _ombreError, ...ombrepublic } = ombre as typeof ombre & { lastError?: string };
    return {
      status: integrity ? 'unhealthy' : 'healthy',
      integrity: integrity ?? 'ok',
      memory: app.env.MEMORY_BACKEND === 'ombre' ? ombrepublic : { backend: 'legacy' },
      // Same redaction as /api/capabilities: MCP `lastError` carries server URLs.
      mcp: app.services.mcpManager.health().map((snapshot) => ({
        id: snapshot.id,
        enabled: snapshot.enabled,
        state: snapshot.state,
        toolCount: snapshot.toolCount
      })),
      capabilities: Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k, { configured: v.configured, ok: v.ok }]))
    };
  });
}
