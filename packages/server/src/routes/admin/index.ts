import type { SooyaApp } from '../../app.js';
import { registerAdminRoutes as registerCoreAdminRoutes } from '../admin.js';
import { registerCapabilityAdminRoutes } from './capabilities.routes.js';
import { registerFutureAdminRoutes, registerLearningAdminRoutes, registerRelationshipAdminRoutes, registerTimelineAdminRoutes } from './continuity.routes.js';
import { registerFlowTraceAdminRoutes, registerHealthRoutes, registerMediaRoutes, registerProviderHealthAdminRoutes, registerTokenAdminRoutes } from './operations.routes.js';
import { registerLifeAdminRoutes, registerQqAdminRoutes, registerQqRoutes } from './channel.routes.js';

/**
 * Admin HTTP composition root. The core panel API remains compatible while
 * domain routes are owned by small modules and registered in one place.
 */
export function registerAdminModule(app: SooyaApp): void {
  registerHealthRoutes(app);
  registerQqRoutes(app);
  registerCoreAdminRoutes(app);
  registerFutureAdminRoutes(app);
  registerRelationshipAdminRoutes(app);
  registerTimelineAdminRoutes(app);
  registerLearningAdminRoutes(app);
  registerProviderHealthAdminRoutes(app);
  registerTokenAdminRoutes(app);
  registerQqAdminRoutes(app);
  registerMediaRoutes(app);
  registerLifeAdminRoutes(app);
  registerFlowTraceAdminRoutes(app);
  registerCapabilityAdminRoutes(app);
}
