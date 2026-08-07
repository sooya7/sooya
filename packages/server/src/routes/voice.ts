import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import type { SooyaApp } from '../app.js';
import { requireChatToken } from './auth.js';
import type { UserVoicePreferences } from '../core/voice/types.js';
import { DEFAULT_VOICE_PREFERENCES } from '../core/voice/types.js';

const MessageIdParamsSchema = z.object({ id: z.string().min(1).max(80) });
const ReadAloudSchema = z.object({ partId: z.string().min(1).max(80), voiceId: z.string().nullable().optional() });
const VoicePreferencesSchema = z.object({
  enabled: z.boolean().optional(),
  autoVoiceFrequency: z.enum(['never', 'rare', 'sometimes']).optional(),
  preferredModes: z.array(z.enum(['replace', 'complement', 'summary', 'read_aloud'])).optional(),
  maxVoiceSeconds: z.number().int().min(5).max(120).optional(),
  autoplay: z.boolean().optional(),
  showTranscript: z.enum(['always', 'collapsed', 'hidden']).optional(),
  preferredPace: z.number().min(0.75).max(1.25).optional(),
  quietHours: z.object({ from: z.number().int().min(0).max(23), to: z.number().int().min(0).max(23) }).nullable().optional()
});

export function registerVoiceRoutes(app: SooyaApp): void {
  const { server, repos, services } = app;
  const auth = requireChatToken(app);

  /** Re-read a specific text part aloud, attached to the text (no new bubble). */
  server.post('/api/messages/:id/read-aloud', { preHandler: auth }, async (req, reply) => {
    const params = MessageIdParamsSchema.safeParse(req.params);
    if (!params.success) { reply.code(400); return { error: 'bad_request', issues: params.error.issues }; }
    const body = ReadAloudSchema.safeParse(req.body ?? {});
    if (!body.success) { reply.code(400); return { error: 'bad_request', issues: body.error.issues }; }
    const message = repos.messages.get(params.data.id);
    if (!message) { reply.code(404); return { error: 'not_found' }; }
    try {
      const result = await services.voice.readAloud(params.data.id, body.data.partId);
      if (!result.ok) {
        reply.code(result.error === 'tts_not_configured' ? 503 : 400);
        return { error: result.error ?? 'read_aloud_failed' };
      }
      return { voiceGenerationId: result.generationId };
    } catch (err) {
      reply.code(502);
      return { error: 'tts_failed', message: (err as Error).message };
    }
  });

  /** Regenerate the voice for a message (manual retry after failure). */
  server.post('/api/messages/:id/voice/retry', { preHandler: auth }, async (req, reply) => {
    const params = MessageIdParamsSchema.safeParse(req.params);
    if (!params.success) { reply.code(400); return { error: 'bad_request', issues: params.error.issues }; }
    const message = repos.messages.get(params.data.id);
    if (!message) { reply.code(404); return { error: 'not_found' }; }
    try {
      const result = await services.voice.retryVoice(params.data.id);
      if (!result.ok) { reply.code(409); return { error: 'not_retryable' }; }
      return { voiceGenerationId: result.generationId };
    } catch (err) {
      reply.code(502);
      return { error: 'tts_failed', message: (err as Error).message };
    }
  });

  /** Cancel an in-flight, not-yet-published voice generation. */
  server.post('/api/voice-generations/:id/cancel', { preHandler: auth }, async (req, reply) => {
    const params = MessageIdParamsSchema.safeParse(req.params);
    if (!params.success) { reply.code(400); return { error: 'bad_request', issues: params.error.issues }; }
    const generation = repos.voice.get(params.data.id);
    if (!generation) { reply.code(404); return { error: 'not_found' }; }
    if (generation.status === 'published' || generation.status === 'failed' || generation.status === 'superseded') {
      reply.code(409);
      return { error: 'not_cancellable', message: '只有尚未发布的语音可以取消' };
    }
    const cancelled = services.voice.cancel(params.data.id);
    return { cancelled };
  });

  /** User voice preferences. */
  server.get('/api/settings/voice', { preHandler: auth }, async () => ({ preferences: services.voice.preferences }));

  server.patch('/api/settings/voice', { preHandler: auth }, async (req, reply) => {
    const parsed = VoicePreferencesSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const current: UserVoicePreferences = services.voice.preferences;
    const next: UserVoicePreferences = {
      ...current,
      ...parsed.data,
      // quietHours accepts explicit null to clear; the stored shape never holds null.
      quietHours: parsed.data.quietHours === null ? undefined : parsed.data.quietHours
    };
    repos.settings.set('voice.preferences', next);
    services.bus.publish('push.updated', { scope: 'voice.preferences' });
    return { preferences: next };
  });
}

export function voicePreferenceDefaults(): UserVoicePreferences {
  return { ...DEFAULT_VOICE_PREFERENCES };
}
