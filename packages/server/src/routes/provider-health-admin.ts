import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';

/** §33 admin observability: per (capability, model) health and cooldowns. */
export function registerProviderHealthAdminRoutes(app: SooyaApp): void {
  const guard = requireAdminToken(app);
  app.server.get('/api/admin/providers/health', { preHandler: guard }, async () => {
    return { health: app.services.capabilities.health.all() };
  });
}
