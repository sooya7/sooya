import type { SooyaApp } from '../app.js';
import { requireChatToken } from './auth.js';
import type { VisibleThought } from '../core/thoughts/types.js';
import { thoughtQualityReason } from '../core/thoughts/safety.js';

/**
 * Read surface for the visible-thoughts layer. The ThoughtsService is wired
 * into `app.services.thoughts` by Integration (app.ts owns the service
 * construction); when it is absent (flags off / not yet wired) these routes
 * serve 404s and empty lists — the stable release behaviour.
 */
export interface ThoughtsApi {
  getUserThought(messageId: string): VisibleThought | null;
  getThoughtsForMessage(messageId: string): VisibleThought[];
}

function thoughtsOf(app: SooyaApp): ThoughtsApi | null {
  const service = (app.services as unknown as { thoughts?: ThoughtsApi }).thoughts;
  return service ?? null;
}

const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/u;

export function registerThoughtRoutes(app: SooyaApp): void {
  const { server, repos } = app;
  const auth = requireChatToken(app);

  /**
   * User-visible inner thought for a specific assistant message. Returns the
   * thought ONLY when the message exists and the thought is a completed,
   * user-visible inner monologue — admin-only decision summaries and
   * not-yet-published thoughts are never served here.
   *
   * The quality guard is repeated on read so malformed rows created by an older
   * release (for example `Won` or `(心`) disappear immediately after deploy;
   * fixing generation alone would leave those historical fragments visible.
   */
  server.get('/api/thoughts/:messageId', { preHandler: auth }, async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    if (!MESSAGE_ID_RE.test(messageId ?? '')) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const message = repos.messages.get(messageId);
    if (!message) {
      reply.code(404);
      return { error: 'not_found', message: '消息不存在' };
    }
    const thoughts = thoughtsOf(app);
    const thought = thoughts ? thoughts.getUserThought(messageId) : null;
    if (!thought || thoughtQualityReason(thought.text)) {
      reply.code(404);
      return { error: 'not_found', message: '该消息没有可见想法' };
    }
    return { thought };
  });
}
