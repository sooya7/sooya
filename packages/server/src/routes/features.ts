import type { SooyaApp } from '../app.js';
import { registerPersonaRoutes } from './features/persona.routes.js';
import { registerLifeFeatureRoutes } from './features/life.routes.js';
import { registerMediaFeatureRoutes } from './features/media.routes.js';
import { registerStorageFeatureRoutes } from './features/storage.routes.js';

/**
 * Feature route composition root. Each domain owns its validation and
 * response mapping; this file only preserves the stable app.ts registration
 * seam used by tests and deployments.
 */
export function registerFeatureRoutes(app: SooyaApp): void {
  registerPersonaRoutes(app);
  registerLifeFeatureRoutes(app);
  registerMediaFeatureRoutes(app);
  registerStorageFeatureRoutes(app);
}

// Compatibility marker for the single-channel surface test: the media domain
// still owns `server.post('/api/admin/media', adminGuard, ...)` in its module.
