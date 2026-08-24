import type { SooyaApp } from '../app.js';
import { capabilityInspector } from '../config/capabilities.js';
import { requireAdminToken } from './auth.js';

export function registerCapabilityAdminRoutes(app: SooyaApp): void {
  app.server.get('/api/admin/capabilities/policy', { preHandler: requireAdminToken(app) }, async () => ({
    policy: capabilityInspector(app.services.capabilityPolicy)
  }));
}
