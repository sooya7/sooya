import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';

/** §12 Learning admin: outcome stats, learned weights, reset control. */
export function registerLearningAdminRoutes(app: SooyaApp): void {
  const { server } = app;
  const guard = requireAdminToken(app);

  server.get('/api/admin/learning/profile', { preHandler: guard }, async () => {
    return app.services.feedback.profile();
  });

  server.post('/api/admin/learning/reset', { preHandler: guard }, async () => {
    return { cleared: app.services.feedback.reset() };
  });
}
