import { z } from 'zod';
import type { SooyaApp } from '../app.js';
import type { MomentRow } from '../db/repos/moment.repo.js';
import { requireChatToken } from './auth.js';

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50)
});
const MomentIdSchema = z.object({ id: z.string().min(1).max(100) });
const LikeSchema = z.object({ liked: z.boolean() });

export function registerMomentRoutes(app: SooyaApp): void {
  const auth = requireChatToken(app);

  app.server.get('/api/moments', { preHandler: auth }, async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    const rows = app.repos.moments.list(parsed.data.limit);
    return { moments: rows.map(toPublicMoment), hasMore: rows.length === parsed.data.limit };
  });

  app.server.patch('/api/moments/:id/like', { preHandler: auth }, async (req, reply) => {
    const params = MomentIdSchema.safeParse(req.params);
    const body = LikeSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      reply.code(400);
      return { error: 'bad_request' };
    }
    const moment = app.repos.moments.setLiked(params.data.id, body.data.liked);
    if (!moment) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return { moment: toPublicMoment(moment) };
  });
}

function toPublicMoment(row: MomentRow) {
  return {
    id: row.id,
    text: row.text,
    activity: row.activity,
    image: row.image_media_id ? {
      id: row.image_media_id,
      url: `/api/media/${row.image_media_id}`,
      kind: row.image_kind
    } : null,
    location: row.location_name || row.city ? {
      id: row.location_id,
      name: row.location_name,
      city: row.city
    } : null,
    weather: row.weather_condition ? {
      condition: row.weather_condition,
      temperatureC: row.temperature_c
    } : null,
    liked: row.liked === 1,
    createdAt: row.created_at
  };
}
