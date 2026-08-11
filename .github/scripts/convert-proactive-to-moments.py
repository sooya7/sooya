from pathlib import Path

ROOT = Path('.')


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')


def replace(path: str, old: str, new: str) -> None:
    text = read(path)
    if old not in text:
        raise RuntimeError(f'expected block not found in {path}: {old[:120]!r}')
    write(path, text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# Database: a real Moments feed, independent from chat messages.
# ---------------------------------------------------------------------------
replace(
    'packages/server/src/db/migrations.ts',
    "  {\n    version: 33,\n    name: 'sticker_semantic_revision',\n    up: (db) => {\n      db.exec('ALTER TABLE stickers ADD COLUMN semantic_revision INTEGER NOT NULL DEFAULT 0;');\n    }\n  },\n];",
    "  {\n    version: 33,\n    name: 'sticker_semantic_revision',\n    up: (db) => {\n      db.exec('ALTER TABLE stickers ADD COLUMN semantic_revision INTEGER NOT NULL DEFAULT 0;');\n    }\n  },\n  {\n    version: 34,\n    name: 'moments_feed',\n    up: (db) => {\n      db.exec(`\n        CREATE TABLE moments (\n          id                TEXT PRIMARY KEY,\n          candidate_id      TEXT NOT NULL UNIQUE,\n          text              TEXT NOT NULL,\n          image_media_id    TEXT REFERENCES media(id) ON DELETE SET NULL,\n          image_kind        TEXT CHECK (image_kind IN ('pov','selfie')),\n          activity          TEXT NOT NULL,\n          location_id       TEXT,\n          location_name     TEXT,\n          city              TEXT,\n          weather_condition TEXT,\n          temperature_c     REAL,\n          liked             INTEGER NOT NULL DEFAULT 0,\n          created_at        TEXT NOT NULL\n        );\n        CREATE INDEX idx_moments_created ON moments(created_at DESC);\n        ALTER TABLE proactive_attempts ADD COLUMN moment_id TEXT REFERENCES moments(id) ON DELETE SET NULL;\n      `);\n    }\n  },\n];"
)

write('packages/server/src/db/repos/moment.repo.ts', r'''import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

export type MomentImageKind = 'pov' | 'selfie';

export interface MomentRow {
  id: string;
  candidate_id: string;
  text: string;
  image_media_id: string | null;
  image_kind: MomentImageKind | null;
  activity: string;
  location_id: string | null;
  location_name: string | null;
  city: string | null;
  weather_condition: string | null;
  temperature_c: number | null;
  liked: number;
  created_at: string;
}

export interface CreateMomentInput {
  candidateId: string;
  text: string;
  imageMediaId?: string | null;
  imageKind?: MomentImageKind | null;
  activity: string;
  locationId?: string | null;
  locationName?: string | null;
  city?: string | null;
  weatherCondition?: string | null;
  temperatureC?: number | null;
  createdAt?: string;
}

export class MomentRepo {
  constructor(private readonly db: DbLike) {}

  inTransaction<T>(work: () => T): T {
    return (this.db.transaction(work) as () => T)();
  }

  create(input: CreateMomentInput): MomentRow {
    const id = sortableId('moment');
    this.db.prepare(`
      INSERT INTO moments(
        id,candidate_id,text,image_media_id,image_kind,activity,
        location_id,location_name,city,weather_condition,temperature_c,liked,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      input.candidateId,
      input.text.trim(),
      input.imageMediaId ?? null,
      input.imageKind ?? null,
      input.activity,
      input.locationId ?? null,
      input.locationName ?? null,
      input.city ?? null,
      input.weatherCondition ?? null,
      input.temperatureC ?? null,
      0,
      input.createdAt ?? nowIso()
    );
    return this.get(id)!;
  }

  get(id: string): MomentRow | undefined {
    return this.db.prepare('SELECT * FROM moments WHERE id = ?').get(id) as MomentRow | undefined;
  }

  latest(): MomentRow | undefined {
    return this.db.prepare('SELECT * FROM moments ORDER BY created_at DESC LIMIT 1').get() as MomentRow | undefined;
  }

  list(limit = 50): MomentRow[] {
    return this.db.prepare('SELECT * FROM moments ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit))) as MomentRow[];
  }

  setLiked(id: string, liked: boolean): MomentRow | undefined {
    const changed = this.db.prepare('UPDATE moments SET liked = ? WHERE id = ?').run(liked ? 1 : 0, id).changes;
    return changed > 0 ? this.get(id) : undefined;
  }
}
''')

write('packages/server/src/db/repos/proactive.repo.ts', r'''import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

export type ProactiveMode = 'text' | 'text_sticker' | 'voice' | 'image';
export type ProactiveAttemptStatus = 'blocked' | 'sent' | 'failed';

export interface ProactiveAttempt {
  id: string;
  candidateId: string | null;
  candidateKind: string | null;
  candidateActivity: string | null;
  status: ProactiveAttemptStatus;
  blockedReason: string | null;
  requestedMode: ProactiveMode | null;
  finalMode: ProactiveMode | null;
  fallbackReason: string | null;
  messageId: string | null;
  momentId: string | null;
  sendSuccess: boolean;
  userResponseMessageId: string | null;
  userRespondedAt: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveAttemptInput {
  candidateId?: string | null;
  candidateKind?: string | null;
  candidateActivity?: string | null;
  status?: ProactiveAttemptStatus;
  blockedReason?: string | null;
  requestedMode?: ProactiveMode | null;
  finalMode?: ProactiveMode | null;
  fallbackReason?: string | null;
  messageId?: string | null;
  momentId?: string | null;
  sendSuccess?: boolean;
  detail?: Record<string, unknown>;
}

export interface ProactiveAttemptPatch {
  status?: ProactiveAttemptStatus;
  blockedReason?: string | null;
  requestedMode?: ProactiveMode | null;
  finalMode?: ProactiveMode | null;
  fallbackReason?: string | null;
  messageId?: string | null;
  momentId?: string | null;
  sendSuccess?: boolean;
  detail?: Record<string, unknown>;
}

interface ProactiveAttemptRow {
  id: string;
  candidate_id: string | null;
  candidate_kind: string | null;
  candidate_activity: string | null;
  status: ProactiveAttemptStatus;
  blocked_reason: string | null;
  requested_mode: ProactiveMode | null;
  final_mode: ProactiveMode | null;
  fallback_reason: string | null;
  message_id: string | null;
  moment_id: string | null;
  send_success: number;
  user_response_message_id: string | null;
  user_responded_at: string | null;
  detail_json: string;
  created_at: string;
  updated_at: string;
}

export class ProactiveAttemptRepo {
  constructor(private readonly db: DbLike) {}

  create(input: ProactiveAttemptInput = {}): ProactiveAttempt {
    const id = sortableId('proactive');
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO proactive_attempts(
        id,candidate_id,candidate_kind,candidate_activity,status,blocked_reason,
        requested_mode,final_mode,fallback_reason,message_id,moment_id,send_success,
        detail_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      input.candidateId ?? null,
      input.candidateKind ?? null,
      input.candidateActivity ?? null,
      input.status ?? 'blocked',
      input.blockedReason ?? null,
      input.requestedMode ?? null,
      input.finalMode ?? null,
      input.fallbackReason ?? null,
      input.messageId ?? null,
      input.momentId ?? null,
      input.sendSuccess ? 1 : 0,
      JSON.stringify(input.detail ?? {}),
      timestamp,
      timestamp
    );
    return this.get(id)!;
  }

  get(id: string): ProactiveAttempt | undefined {
    const row = this.db.prepare('SELECT * FROM proactive_attempts WHERE id = ?').get(id) as ProactiveAttemptRow | undefined;
    return row ? toAttempt(row) : undefined;
  }

  update(id: string, patch: ProactiveAttemptPatch): ProactiveAttempt | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const detail = patch.detail ? { ...current.detail, ...patch.detail } : current.detail;
    this.db.prepare(`
      UPDATE proactive_attempts SET
        status=?, blocked_reason=?, requested_mode=?, final_mode=?, fallback_reason=?,
        message_id=?, moment_id=?, send_success=?, detail_json=?, updated_at=?
      WHERE id=?
    `).run(
      patch.status ?? current.status,
      patch.blockedReason === undefined ? current.blockedReason : patch.blockedReason,
      patch.requestedMode === undefined ? current.requestedMode : patch.requestedMode,
      patch.finalMode === undefined ? current.finalMode : patch.finalMode,
      patch.fallbackReason === undefined ? current.fallbackReason : patch.fallbackReason,
      patch.messageId === undefined ? current.messageId : patch.messageId,
      patch.momentId === undefined ? current.momentId : patch.momentId,
      patch.sendSuccess === undefined ? (current.sendSuccess ? 1 : 0) : (patch.sendSuccess ? 1 : 0),
      JSON.stringify(detail),
      nowIso(),
      id
    );
    return this.get(id);
  }

  list(limit = 50): ProactiveAttempt[] {
    const rows = this.db.prepare('SELECT * FROM proactive_attempts ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit))) as ProactiveAttemptRow[];
    return rows.map(toAttempt);
  }

  /** Legacy history hook. New Moments posts no longer bind the next chat message as a response. */
  recordUserResponse(messageId: string, messageCreatedAt: string): boolean {
    const parsed = Date.parse(messageCreatedAt);
    if (!Number.isFinite(parsed)) return false;
    const cutoff = new Date(parsed - 7 * 24 * 60 * 60 * 1000).toISOString();
    const row = this.db.prepare(`
      SELECT id FROM proactive_attempts
      WHERE status='sent' AND send_success=1
        AND moment_id IS NULL
        AND user_response_message_id IS NULL
        AND created_at <= ? AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(messageCreatedAt, cutoff) as { id: string } | undefined;
    if (!row) return false;
    const changed = this.db.prepare(`
      UPDATE proactive_attempts
      SET user_response_message_id=?, user_responded_at=?, updated_at=?
      WHERE id=? AND user_response_message_id IS NULL
    `).run(messageId, messageCreatedAt, nowIso(), row.id).changes;
    return changed > 0;
  }
}

function toAttempt(row: ProactiveAttemptRow): ProactiveAttempt {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    candidateKind: row.candidate_kind,
    candidateActivity: row.candidate_activity,
    status: row.status,
    blockedReason: row.blocked_reason,
    requestedMode: row.requested_mode,
    finalMode: row.final_mode,
    fallbackReason: row.fallback_reason,
    messageId: row.message_id,
    momentId: row.moment_id,
    sendSuccess: row.send_success === 1,
    userResponseMessageId: row.user_response_message_id,
    userRespondedAt: row.user_responded_at,
    detail: parseDetail(row.detail_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseDetail(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
''')

# Moments count as durable media references.
replace(
    'packages/server/src/db/repos/media.repo.ts',
    "export interface MediaReferences {\n  messageParts: number;\n  stickers: number;\n  total: number;\n}",
    "export interface MediaReferences {\n  messageParts: number;\n  stickers: number;\n  moments: number;\n  total: number;\n}"
)
replace(
    'packages/server/src/db/repos/media.repo.ts',
    "  references(id: string): MediaReferences {\n    const messageParts = (this.db.prepare('SELECT COUNT(*) c FROM message_parts WHERE media_id = ?').get(id) as { c: number }).c;\n    const stickers = (this.db.prepare('SELECT COUNT(*) c FROM stickers WHERE media_id = ?').get(id) as { c: number }).c;\n    return { messageParts, stickers, total: messageParts + stickers };\n  }",
    "  references(id: string): MediaReferences {\n    const messageParts = (this.db.prepare('SELECT COUNT(*) c FROM message_parts WHERE media_id = ?').get(id) as { c: number }).c;\n    const stickers = (this.db.prepare('SELECT COUNT(*) c FROM stickers WHERE media_id = ?').get(id) as { c: number }).c;\n    const moments = (this.db.prepare('SELECT COUNT(*) c FROM moments WHERE image_media_id = ?').get(id) as { c: number }).c;\n    return { messageParts, stickers, moments, total: messageParts + stickers + moments };\n  }"
)
replace(
    'packages/server/src/db/repos/media.repo.ts',
    "        AND NOT EXISTS (SELECT 1 FROM stickers s WHERE s.media_id = m.id)\n      ORDER BY m.created_at LIMIT ?",
    "        AND NOT EXISTS (SELECT 1 FROM stickers s WHERE s.media_id = m.id)\n        AND NOT EXISTS (SELECT 1 FROM moments mo WHERE mo.image_media_id = m.id)\n      ORDER BY m.created_at LIMIT ?"
)
replace(
    'packages/server/src/db/repos/media.repo.ts',
    "        AND NOT EXISTS (SELECT 1 FROM stickers s WHERE s.media_id = m.id)\n      ORDER BY m.created_at LIMIT ?\n    `).all(cutoff, limit)",
    "        AND NOT EXISTS (SELECT 1 FROM stickers s WHERE s.media_id = m.id)\n        AND NOT EXISTS (SELECT 1 FROM moments mo WHERE mo.image_media_id = m.id)\n      ORDER BY m.created_at LIMIT ?\n    `).all(cutoff, limit)"
)

# ---------------------------------------------------------------------------
# Public Moments API.
# ---------------------------------------------------------------------------
write('packages/server/src/routes/moments.ts', r'''import { z } from 'zod';
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
''')

# ---------------------------------------------------------------------------
# Composer: Life events now publish Moments, never assistant chat messages.
# ---------------------------------------------------------------------------
write('packages/server/src/core/proactive.ts', r'''import type { MessageRepo } from '../db/repos/message.repo.js';
import type { ProactiveAttemptRepo, ProactiveMode } from '../db/repos/proactive.repo.js';
import type { ReplyBatchRepo } from '../db/repos/reply-batch.repo.js';
import type { LifeLogRow } from '../db/repos/life.repo.js';
import type { MomentRepo, MomentImageKind } from '../db/repos/moment.repo.js';
import type { CapabilityRegistry } from './capabilities.js';
import type { ConfigStore } from '../config/store.js';
import type { LifeRuntime } from './life.js';
import type { MediaStore } from '../media/store.js';
import type { EventBus } from '../events/bus.js';
import type { ChatMessage } from './types.js';
import type { ReplyCoordinator, ProactiveDeliveryTask } from './reply-coordinator.js';
import type { MediaDirector } from './mediaDirector.js';
import type { PersonaReferenceLoader } from '../media/persona-references.js';
import type { LifeLocationRepo, LifeLocationRow } from '../db/repos/location.repo.js';
import type { WorldSnapshot } from './world-context.js';
import { z } from 'zod';
import { extractJsonObject } from '../util/json-extract.js';

export type { ProactiveMode } from '../db/repos/proactive.repo.js';

export interface ProactiveRunOptions {
  /** Test/admin seam; legacy voice/sticker choices are normalized to a text Moment. */
  mode?: ProactiveMode;
}

export interface ProactiveEvaluation {
  reach: boolean;
  reason: string;
  candidate: LifeLogRow | null;
  lastUserAt: string | null;
  lastAssistantAt: string | null;
}

export interface ProactiveRunResult {
  status: 'blocked' | 'sent' | 'failed';
  blockedReason: string | null;
  candidateId: string | null;
  /** Deprecated: proactive Life sharing no longer creates a chat message. */
  messageId: string | null;
  momentId: string | null;
  requestedMode: ProactiveMode | null;
  finalMode: ProactiveMode | null;
  fallbackReason: string | null;
  sendSuccess: boolean;
}

interface PreparedMedia {
  imageMediaId: string | null;
  imageKind: MomentImageKind | null;
  finalMode: ProactiveMode;
  fallbackReason: string | null;
  detail?: Record<string, unknown>;
}

const MomentSharePlanSchema = z.object({
  text: z.string().trim().min(1).max(120),
  image: z.object({
    kind: z.enum(['pov', 'selfie']),
    scene: z.string().trim().min(4).max(300),
    action: z.string().trim().max(160).optional(),
    mood: z.string().trim().max(80).optional(),
    framing: z.enum(['front', 'side', 'full-body', 'environment']).optional()
  }).nullable()
});

type MomentSharePlan = z.infer<typeof MomentSharePlanSchema>;

interface ProactiveEventContext {
  activity: string;
  kind: string;
  mood: string;
  startedAt: string;
  endedAt: string;
  location: {
    id: string;
    name: string;
    kind: string;
    city?: string | null;
    region?: string | null;
    country?: string | null;
  } | null;
  recentWeatherHint: { condition: string; temperatureC?: number | null } | null;
}

const TOPIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Historical name kept for compatibility. This service now turns shareable
 * Life events into a private Moments feed. It never writes assistant messages
 * and never enqueues reply push notifications.
 */
export class ProactiveComposer {
  constructor(
    private readonly deps: {
      attempts: ProactiveAttemptRepo;
      messages: MessageRepo;
      moments: MomentRepo;
      life: LifeRuntime;
      replyBatches: ReplyBatchRepo;
      capabilities: CapabilityRegistry;
      config: ConfigStore;
      media: MediaStore;
      bus: EventBus;
      coordinator: ReplyCoordinator;
      metrics?: import('./metrics.js').MetricsService;
      mediaDirector: MediaDirector;
      personaReferences: PersonaReferenceLoader;
      locations: LifeLocationRepo;
      worldSnapshot: () => WorldSnapshot;
    }
  ) {}

  evaluate(): ProactiveEvaluation {
    const recent = this.deps.messages.recent(40);
    const lastUser = [...recent].reverse().find((message) => message.role === 'user');
    const lastAssistant = [...recent].reverse().find((message) => message.role === 'assistant');

    // A Moment is not a chat interruption. Reuse Life's candidate, sleep,
    // silent-hour and daily-cap rules, but deliberately remove chat-gap gates.
    const decision = this.deps.life.shouldReachOut(null, null);
    const base = {
      candidate: decision.candidate,
      lastUserAt: lastUser?.createdAt ?? null,
      lastAssistantAt: lastAssistant?.createdAt ?? null
    };
    if (!decision.reach || !decision.candidate) return { reach: false, reason: decision.reason, ...base };

    const latest = this.deps.moments.latest();
    if (latest) {
      const elapsed = this.deps.life.now().getTime() - Date.parse(latest.created_at);
      const gap = this.deps.life.settings.quietGapMinutes * 60_000;
      if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < gap) {
        return { reach: false, reason: 'moment_gap', ...base };
      }
    }

    // User replies still get model/provider priority. The candidate remains
    // unshared and will be retried on a later Life tick.
    if (this.deps.replyBatches.openBatch()) return { reach: false, reason: 'reply_in_progress', ...base };
    if (this.recentlyDiscussed(decision.candidate, recent) || this.recentlyShared(decision.candidate)) {
      return { reach: false, reason: 'recent_topic', ...base };
    }
    if (!this.deps.capabilities.has('chat')) return { reach: false, reason: 'chat_unavailable', ...base };
    return { reach: true, reason: 'ok', ...base };
  }

  async run(options: ProactiveRunOptions = {}): Promise<ProactiveRunResult> {
    const evaluation = this.evaluate();
    const candidate = evaluation.candidate;
    const requestedMode = candidate ? this.resolveMode(options.mode) : null;
    const attempt = this.deps.attempts.create({
      candidateId: candidate?.id ?? null,
      candidateKind: candidate?.kind ?? null,
      candidateActivity: candidate?.activity ?? null,
      requestedMode,
      status: 'blocked',
      blockedReason: evaluation.reach ? null : evaluation.reason,
      detail: { evaluatedAt: this.deps.life.now().toISOString(), destination: 'moments' }
    });

    if (!evaluation.reach || !candidate) return this.blocked(evaluation.reason, candidate?.id ?? null, requestedMode);

    let finalMode: ProactiveMode | null = null;
    let fallbackReason: string | null = null;
    const task: ProactiveDeliveryTask = {
      candidateId: candidate.id,
      requestedMode: requestedMode ?? 'text',
      run: async (signal) => {
        const provider = this.deps.capabilities.chatProvider();
        const persona = this.deps.config.getPersona();
        const lifeLines = this.deps.life.contextLines(evaluation.lastUserAt ? new Date(evaluation.lastUserAt) : null);
        const eventContext = this.resolveEventContext(candidate);

        let sharePlan: MomentSharePlan;
        try {
          sharePlan = await composeMomentSharePlan(
            provider,
            persona.systemPrompt,
            lifeLines,
            eventContext,
            requestedMode ?? 'text',
            signal
          );
        } catch (error) {
          if (signal.aborted) return { kind: 'discarded' };
          const reason = error instanceof Error && error.message === 'invalid_share_text' ? 'invalid_share_text' : 'compose_failed';
          this.deps.attempts.update(attempt.id, { status: 'failed', blockedReason: reason, detail: { error: safeError(error) } });
          throw new Error(reason);
        }

        let prepared: PreparedMedia;
        try {
          prepared = await this.prepareMedia(requestedMode ?? 'text', sharePlan, eventContext, candidate, signal);
        } catch (error) {
          if (signal.aborted) return { kind: 'discarded' };
          this.deps.attempts.update(attempt.id, { status: 'failed', blockedReason: 'media_failed', detail: { error: safeError(error) } });
          throw new Error('media_failed');
        }
        finalMode = prepared.finalMode;
        fallbackReason = prepared.fallbackReason;
        if (signal.aborted) return { kind: 'discarded' };

        try {
          const persisted = this.deps.moments.inTransaction(() => {
            const moment = this.deps.moments.create({
              candidateId: candidate.id,
              text: sharePlan.text,
              imageMediaId: prepared.imageMediaId,
              imageKind: prepared.imageKind,
              activity: candidate.activity,
              locationId: eventContext.location?.id ?? null,
              locationName: eventContext.location?.name ?? null,
              city: eventContext.location?.city ?? null,
              weatherCondition: eventContext.recentWeatherHint?.condition ?? null,
              temperatureC: eventContext.recentWeatherHint?.temperatureC ?? null,
              createdAt: this.deps.life.now().toISOString()
            });
            const updated = this.deps.attempts.update(attempt.id, {
              status: 'sent',
              blockedReason: null,
              finalMode: prepared.finalMode,
              fallbackReason: prepared.fallbackReason,
              messageId: null,
              momentId: moment.id,
              sendSuccess: true,
              detail: {
                destination: 'moments',
                sharePlanVersion: 3,
                photoKind: sharePlan.image?.kind ?? null,
                eventLocationId: eventContext.location?.id ?? null,
                imageDirectorUsed: Boolean(prepared.detail?.imageDirectorUsed),
                referenceUsed: Boolean(prepared.detail?.referenceUsed),
                mediaPersisted: Boolean(prepared.imageMediaId)
              }
            });
            if (!updated) throw new Error('proactive attempt disappeared');
            this.deps.life.markShared(candidate.id);
            const event = this.deps.bus.persist('moment.created', { momentId: moment.id, activity: moment.activity });
            return { moment, event };
          });
          this.deps.bus.fanout(persisted.event);
          this.deps.attempts.update(attempt.id, { detail: { ...prepared.detail, destination: 'moments' } });
          return { kind: 'sent', messageId: persisted.moment.id };
        } catch (error) {
          if (isUniqueConstraint(error)) {
            this.deps.attempts.update(attempt.id, { status: 'blocked', blockedReason: 'candidate_already_sent' });
            return { kind: 'blocked', blockedReason: 'candidate_already_sent' };
          }
          const reason = 'moment_persist_failed';
          this.deps.attempts.update(attempt.id, {
            status: 'failed',
            blockedReason: reason,
            finalMode: prepared.finalMode,
            fallbackReason: prepared.fallbackReason,
            detail: { error: safeError(error) }
          });
          throw new Error(reason);
        }
      }
    };

    const result = await this.deps.coordinator.enqueueProactive(task);
    if (result.status === 'sent') {
      this.deps.metrics?.record('proactive', 'sent');
      return {
        status: 'sent',
        blockedReason: null,
        candidateId: candidate.id,
        messageId: null,
        momentId: result.messageId,
        requestedMode,
        finalMode,
        fallbackReason,
        sendSuccess: true
      };
    }
    const blockedReason = result.blockedReason ?? result.status;
    this.deps.metrics?.record('proactive', blockedReason === 'user_appeared' ? 'user_appeared_cancel'
      : blockedReason === 'reply_in_progress' ? 'reply_conflict'
      : blockedReason === 'candidate_already_sent' || blockedReason === 'candidate_already_queued' ? 'duplicate'
      : result.status === 'failed' ? 'failed' : 'blocked');
    this.deps.attempts.update(attempt.id, { status: result.status === 'failed' ? 'failed' : 'blocked', blockedReason });
    return {
      status: result.status === 'failed' ? 'failed' : 'blocked',
      blockedReason,
      candidateId: candidate.id,
      messageId: null,
      momentId: null,
      requestedMode,
      finalMode,
      fallbackReason,
      sendSuccess: false
    };
  }

  private blocked(reason: string, candidateId: string | null, requestedMode: ProactiveMode | null): ProactiveRunResult {
    return {
      status: 'blocked',
      blockedReason: reason,
      candidateId,
      messageId: null,
      momentId: null,
      requestedMode,
      finalMode: null,
      fallbackReason: null,
      sendSuccess: false
    };
  }

  private resolveMode(requested?: ProactiveMode): ProactiveMode {
    const normalize = (mode: ProactiveMode): ProactiveMode => mode === 'image' ? 'image' : 'text';
    if (requested) return normalize(requested);
    const configured = this.deps.life.settings.proactiveMode ?? 'auto';
    if (configured !== 'auto') return normalize(configured);
    const persona = this.deps.config.getPersona();
    if (persona.imagePolicy.enabled && persona.imagePolicy.frequency === 'high' && this.deps.capabilities.has('image')) return 'image';
    return 'text';
  }

  private async prepareMedia(
    mode: ProactiveMode,
    sharePlan: MomentSharePlan,
    eventContext: ProactiveEventContext,
    candidate: LifeLogRow,
    signal: AbortSignal
  ): Promise<PreparedMedia> {
    if (mode !== 'image') return { imageMediaId: null, imageKind: null, finalMode: 'text', fallbackReason: null };
    if (!this.deps.capabilities.has('image')) return { imageMediaId: null, imageKind: null, finalMode: 'text', fallbackReason: 'image_unavailable' };
    try {
      if (signal.aborted) return { imageMediaId: null, imageKind: null, finalMode: 'text', fallbackReason: 'aborted' };
      const imagePlan = sharePlan.image;
      if (!imagePlan) return { imageMediaId: null, imageKind: null, finalMode: 'text', fallbackReason: 'image_plan_missing' };
      const groundedScene = buildGroundedScene(imagePlan, eventContext);
      const directed = await this.deps.mediaDirector.image({
        scene: groundedScene,
        action: imagePlan.action,
        mood: imagePlan.mood ?? candidate.mood,
        intent: imagePlan.kind === 'selfie'
          ? 'casual Moments-feed selfie from the same real lived event'
          : 'casual first-person smartphone photo for a Moments feed from the same real lived event'
      }, { signal });
      const finalImagePrompt = directed.prompt.trim();
      if (!finalImagePrompt) return { imageMediaId: null, imageKind: null, finalMode: 'text', fallbackReason: 'image_director_failed' };
      const referenceImages = imagePlan.kind === 'selfie' ? await this.deps.personaReferences.load(finalImagePrompt) : [];
      const referenceUsed = referenceImages.length > 0;
      const image = await this.deps.capabilities.imageProvider().generate(finalImagePrompt, {
        signal,
        ...(referenceUsed ? { referenceImages } : {})
      });
      const media = await this.deps.media.save({
        kind: 'image',
        origin: 'generated',
        data: image.data,
        declaredMime: image.mime,
        filename: 'moment.png',
        meta: {
          moment: true,
          proactive: true,
          candidateId: candidate.id,
          sharePlanVersion: 3,
          photoKind: imagePlan.kind,
          sourceActivity: candidate.activity,
          sourceText: sharePlan.text.slice(0, 200),
          eventLocationId: eventContext.location?.id ?? null,
          directorPrompt: finalImagePrompt.slice(0, 1000),
          ...(imagePlan.kind === 'selfie' && !referenceUsed ? { referenceMissing: true } : {})
        }
      });
      return {
        imageMediaId: media.id,
        imageKind: imagePlan.kind,
        finalMode: 'image',
        fallbackReason: null,
        detail: { imageDirectorUsed: true, referenceUsed, referenceMissing: imagePlan.kind === 'selfie' && !referenceUsed }
      };
    } catch {
      return { imageMediaId: null, imageKind: null, finalMode: 'text', fallbackReason: 'image_failed' };
    }
  }

  private recentlyDiscussed(candidate: LifeLogRow, messages: ChatMessage[]): boolean {
    const now = this.deps.life.now().getTime();
    const candidateTopics = topicTokens(candidate.activity);
    if (candidateTopics.length === 0) return false;
    return messages.some((message) => {
      const created = Date.parse(message.createdAt);
      if (!Number.isFinite(created) || created > now || now - created > TOPIC_WINDOW_MS) return false;
      const messageTopics = new Set(topicTokens(textOf(message)));
      const overlap = candidateTopics.filter((token) => messageTopics.has(token)).length;
      const required = candidateTopics.length <= 2 ? 1 : Math.max(2, Math.ceil(candidateTopics.length * 0.4));
      return overlap >= required;
    });
  }

  private recentlyShared(candidate: LifeLogRow): boolean {
    const now = this.deps.life.now().getTime();
    const candidateTopics = topicTokens(candidate.activity);
    if (candidateTopics.length === 0) return false;
    return this.deps.moments.list(20).some((moment) => {
      const created = Date.parse(moment.created_at);
      if (!Number.isFinite(created) || created > now || now - created > TOPIC_WINDOW_MS) return false;
      const topics = new Set(topicTokens(`${moment.activity}\n${moment.text}`));
      const overlap = candidateTopics.filter((token) => topics.has(token)).length;
      const required = candidateTopics.length <= 2 ? 1 : Math.max(2, Math.ceil(candidateTopics.length * 0.4));
      return overlap >= required;
    });
  }

  private resolveEventContext(candidate: LifeLogRow): ProactiveEventContext {
    let location: LifeLocationRow | undefined;
    try {
      const visit = this.deps.locations.visitOverlapping(candidate.started_at, candidate.ended_at);
      location = visit ? this.deps.locations.get(visit.location_id) : undefined;
    } catch { /* optional grounding */ }
    const snapshot = this.deps.worldSnapshot();
    const eventEnd = Date.parse(candidate.ended_at);
    const now = Date.parse(snapshot.now);
    const sameCity = Boolean(location?.city && snapshot.city?.name && location.city === snapshot.city.name);
    const recent = Number.isFinite(eventEnd) && Number.isFinite(now) && now >= eventEnd && now - eventEnd <= 90 * 60_000;
    const recentWeatherHint = recent && sameCity && snapshot.weather
      ? { condition: snapshot.weather.condition, temperatureC: snapshot.weather.temperatureC ?? null }
      : null;
    return {
      activity: candidate.activity,
      kind: candidate.kind,
      mood: candidate.mood,
      startedAt: candidate.started_at,
      endedAt: candidate.ended_at,
      location: location ? {
        id: location.id,
        name: location.name,
        kind: location.kind,
        city: location.city,
        region: location.region,
        country: location.country
      } : null,
      recentWeatherHint
    };
  }
}

async function composeMomentSharePlan(
  provider: ReturnType<CapabilityRegistry['chatProvider']>,
  personaPrompt: string,
  lifeLines: string[],
  eventContext: ProactiveEventContext,
  requestedMode: ProactiveMode,
  signal: AbortSignal
): Promise<MomentSharePlan> {
  const imageMode = requestedMode === 'image';
  const request = async (repairReason?: string): Promise<MomentSharePlan> => {
    const result = await provider.complete({
      system: [
        personaPrompt.trim(),
        ...lifeLines.map((line) => `【当前状态，仅用于语气连续性】${line}`),
        '你是 SOOYA，要把一件真实经历过的小事发到只对用户可见的朋友圈。这里不是私人聊天窗口。',
        '【要发布的历史事件】',
        JSON.stringify(eventContext),
        `本次发布方式：${imageMode ? '图片动态' : '文字动态'}。${imageMode ? '请规划一张与正文同一事件的照片。' : 'image 必须为 null。'}`,
        '【规则】text 是一条自然、完整的朋友圈正文，像随手记录生活，不要标题、标签、冒号前缀、系统/Life/模型内容。',
        '不要用“在吗”“睡了吗”“刚想跟你说”“发给你看看”这种私聊式呼叫，也不要为了发动态虚构新事件。',
        '如果有图片，必须与 text 是同一件具体小事：pov 是 SOOYA 手机第一视角且不出现本人，selfie 才出现 SOOYA。只选普通现实生活场景。',
        repairReason ? `上一版未通过检查：${repairReason}。请只重新返回完整 JSON。` : '',
        '只输出 JSON：{"text":"...","image":null 或 {"kind":"pov|selfie","scene":"...","action":"...","mood":"...","framing":"front|side|full-body|environment"}}。'
      ].filter(Boolean).join('\n'),
      messages: [{ role: 'user', content: [{ type: 'text', text: '为这件真实经历写一条朋友圈动态。' }] }],
      temperature: 0.8,
      maxTokens: 450,
      jsonMode: true,
      signal
    });
    const parsed = MomentSharePlanSchema.safeParse(extractJsonObject(result.text));
    if (!parsed.success) throw new Error(`invalid_share_plan: ${parsed.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.message).join('; ')}`);
    return imageMode ? parsed.data : { ...parsed.data, image: null };
  };

  const first = await request();
  const firstValidation = validateMomentText(first.text);
  if (firstValidation.ok) return first;
  const repaired = await request(firstValidation.reason);
  const secondValidation = validateMomentText(repaired.text);
  if (!secondValidation.ok) throw new Error('invalid_share_text');
  return repaired;
}

function validateMomentText(text: string): { ok: boolean; reason?: string } {
  const normalized = text.trim().replace(/^["“”「」]|["“”「」]$/gu, '').trim();
  if (Array.from(normalized.replace(/\s/gu, '')).length < 6) return { ok: false, reason: '文本太短或只是残片' };
  if (/^(刚刚|刚才|刚发生的事|刚才发生的事|最近|今天)[：:]?$/u.test(normalized)) return { ok: false, reason: '只是标题或时间残片' };
  if (/^(在吗|睡了吗|干嘛呢)[？?。.]?$/u.test(normalized)) return { ok: false, reason: '像私聊呼叫，不像朋友圈正文' };
  if (/(因为|所以|然后|但是|不过|顺道|本来想|正准备|刚准备)$/u.test(normalized)) return { ok: false, reason: '句子以悬空连接词结尾' };
  return { ok: true };
}

function buildGroundedScene(image: NonNullable<MomentSharePlan['image']>, context: ProactiveEventContext): string {
  const location = context.location
    ? `${context.location.city ?? ''}${context.location.region ?? ''}的${context.location.name}（${context.location.kind}）`
    : '事件地点未知的普通现实生活环境';
  const weather = context.recentWeatherHint
    ? `附近最近天气参考：${context.recentWeatherHint.condition}${context.recentWeatherHint.temperatureC == null ? '' : `，${context.recentWeatherHint.temperatureC}°C`}，仅作氛围参考，不是历史事实。`
    : '';
  return [
    `真实生活事件：${context.activity}。`,
    `实际地点：${location}。`,
    `这条朋友圈要拍：${image.scene}。`,
    image.action ? `动作：${image.action}。` : '',
    `照片类型：${image.kind === 'selfie' ? 'SOOYA 在同一真实事件中的自然生活自拍' : 'SOOYA 手机第一视角拍摄眼前所见，SOOYA 本人不入镜'}。`,
    weather,
    '必须是现实世界普通生活环境、自然手机照片；禁止幻想建筑、漂浮建筑、旅游海报、概念艺术、动漫世界和不可能的地理关系。'
  ].filter(Boolean).join('\n');
}

function isUniqueConstraint(error: unknown): boolean {
  const code = (error as { code?: string }).code ?? '';
  return typeof code === 'string' && code.includes('SQLITE_CONSTRAINT');
}

function textOf(message: ChatMessage): string {
  return message.content
    .map((part) => part.type === 'text' ? part.text ?? '' : part.type === 'audio' ? part.transcript ?? '' : '')
    .filter(Boolean)
    .join('\n');
}

function topicTokens(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const tokens: string[] = [];
  const cjk = normalized.match(/[\u3400-\u9fff]+/gu) ?? [];
  for (const sequence of cjk) {
    const chars = [...sequence];
    if (chars.length === 1) tokens.push(chars[0]!);
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars.slice(i, i + 2).join(''));
  }
  const latin = normalized.match(/[a-z0-9]{3,}/gu) ?? [];
  tokens.push(...latin);
  return [...new Set(tokens)];
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}
''')

# Chat messages are no longer treated as replies to Moments.
replace(
    'packages/server/src/routes/chat.ts',
    "      if (created.created) {\n        repos.proactive.recordUserResponse(created.message.id, created.message.createdAt);\n        enqueueStickerMeaningJobs(app, parts);\n      }",
    "      if (created.created) {\n        enqueueStickerMeaningJobs(app, parts);\n      }"
)
replace(
    'packages/server/src/routes/chat.ts',
    "      if (created.created) {\n        repos.proactive.recordUserResponse(created.message.id, created.message.createdAt);\n        enqueueStickerMeaningJobs(app, parts);\n      }",
    "      if (created.created) {\n        enqueueStickerMeaningJobs(app, parts);\n      }"
)

# App wiring.
replace(
    'packages/server/src/app.ts',
    "import { ProactiveAttemptRepo } from './db/repos/proactive.repo.js';",
    "import { ProactiveAttemptRepo } from './db/repos/proactive.repo.js';\nimport { MomentRepo } from './db/repos/moment.repo.js';"
)
replace(
    'packages/server/src/app.ts',
    "import { registerThoughtRoutes } from './routes/thoughts.js';",
    "import { registerThoughtRoutes } from './routes/thoughts.js';\nimport { registerMomentRoutes } from './routes/moments.js';"
)
replace(
    'packages/server/src/app.ts',
    "    proactive: ProactiveAttemptRepo;\n    voice: VoiceGenerationRepo;",
    "    proactive: ProactiveAttemptRepo;\n    moments: MomentRepo;\n    voice: VoiceGenerationRepo;"
)
replace(
    'packages/server/src/app.ts',
    "    proactive: new ProactiveAttemptRepo(dbHandle),\n    voice: new VoiceGenerationRepo(dbHandle),",
    "    proactive: new ProactiveAttemptRepo(dbHandle),\n    moments: new MomentRepo(dbHandle),\n    voice: new VoiceGenerationRepo(dbHandle),"
)
replace(
    'packages/server/src/app.ts',
    "  const proactive = new ProactiveComposer({\n    attempts: repos.proactive,\n    replyBatches: repos.replyBatches,\n    jobs: repos.jobs,\n    messages: repos.messages,\n    life,\n    capabilities,\n    config,\n    media: mediaStore,\n    stickers: stickerLibrary,\n    bus,\n    voice: voiceService,\n    coordinator: replyCoordinator,\n    metrics,\n    mediaDirector,\n    personaReferences,\n    locations: repos.locations,\n    worldSnapshot: () => world.snapshot()\n  });",
    "  const proactive = new ProactiveComposer({\n    attempts: repos.proactive,\n    replyBatches: repos.replyBatches,\n    messages: repos.messages,\n    moments: repos.moments,\n    life,\n    capabilities,\n    config,\n    media: mediaStore,\n    bus,\n    coordinator: replyCoordinator,\n    metrics,\n    mediaDirector,\n    personaReferences,\n    locations: repos.locations,\n    worldSnapshot: () => world.snapshot()\n  });"
)
replace(
    'packages/server/src/app.ts',
    "  registerThoughtRoutes(app);\n  registerAdminRoutes(app);",
    "  registerThoughtRoutes(app);\n  registerMomentRoutes(app);\n  registerAdminRoutes(app);"
)

# ---------------------------------------------------------------------------
# Frontend route/API/feed.
# ---------------------------------------------------------------------------
replace(
    'packages/web/src/lib/navigation.ts',
    "export type AppRouteKind = 'chat' | 'gallery' | 'admin';",
    "export type AppRouteKind = 'chat' | 'moments' | 'gallery' | 'admin';"
)
replace(
    'packages/web/src/lib/navigation.ts',
    "  if (normalized === '/gallery') return 'gallery';",
    "  if (normalized === '/moments') return 'moments';\n  if (normalized === '/gallery') return 'gallery';"
)

replace(
    'packages/web/src/AppShell.tsx',
    "import GalleryPage from './components/GalleryPage.js';",
    "import GalleryPage from './components/GalleryPage.js';\nimport MomentsPage from './components/MomentsPage.js';"
)
replace(
    'packages/web/src/AppShell.tsx',
    "    {route === 'chat' && <ImageViewerHost />}\n    {route === 'gallery' && <GalleryPage />}",
    "    {(route === 'chat' || route === 'moments') && <ImageViewerHost />}\n    {route === 'moments' && <MomentsPage />}\n    {route === 'gallery' && <GalleryPage />}"
)

replace(
    'packages/web/src/components/ChatHeader.tsx',
    "        <NotificationBridge />\n        <button type=\"button\" className=\"history-tool-button\"",
    "        <NotificationBridge />\n        <AppLink className=\"topbar-admin-entry topbar-moments-entry\" href=\"/moments\" aria-label=\"打开朋友圈\" title=\"朋友圈\" data-testid=\"moments-entry\">\n          <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\"><rect x=\"4\" y=\"5\" width=\"16\" height=\"14\" rx=\"3\" /><circle cx=\"9\" cy=\"10\" r=\"1.5\" /><path d=\"m6.5 17 4.2-4 2.8 2.4 2.2-2 2.3 2.1\" /></svg>\n        </AppLink>\n        <button type=\"button\" className=\"history-tool-button\""
)

# User API types + endpoints.
replace(
    'packages/web/src/lib/api.ts',
    "export interface MessageSearchHit { message: ChatMessage; snippet: string; matchedPartId: string | null; }",
    "export interface MessageSearchHit { message: ChatMessage; snippet: string; matchedPartId: string | null; }\nexport interface Moment {\n  id: string;\n  text: string;\n  activity: string;\n  image: { id: string; url: string; kind: 'pov' | 'selfie' | null } | null;\n  location: { id: string | null; name: string | null; city: string | null } | null;\n  weather: { condition: string; temperatureC: number | null } | null;\n  liked: boolean;\n  createdAt: string;\n}"
)
replace(
    'packages/web/src/lib/api.ts',
    "export const api = {\n  bootstrap: () => request<BootstrapInfo>('/api/bootstrap'),",
    "export const api = {\n  bootstrap: () => request<BootstrapInfo>('/api/bootstrap'),\n  conversation: () => request<ConversationInfo>('/api/conversation'),\n  moments: (limit = 50) => request<{ moments: Moment[]; hasMore: boolean }>(`/api/moments?limit=${Math.max(1, Math.min(100, limit))}`),\n  likeMoment: (id: string, liked: boolean) => request<{ moment: Moment }>(`/api/moments/${encodeURIComponent(id)}/like`, { method: 'PATCH', body: JSON.stringify({ liked }) }),"
)

write('packages/web/src/components/MomentsPage.tsx', r'''import { useCallback, useEffect, useState } from 'react';
import { api, type ConversationInfo, type Moment } from '../lib/api.js';
import { mediaThumbnailPath } from '../lib/authenticatedMedia.js';
import { useAuthenticatedMedia } from '../lib/useAuthenticatedMedia.js';
import { weatherConditionLabel } from '../lib/worldDisplay.js';
import { AppLink } from './AppLink.js';

const MOMENT_IMAGE_CSS_WIDTH = 560;

function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const diff = Math.max(0, Date.now() - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function MomentPhoto({ moment }: { moment: Moment }) {
  const image = moment.image;
  const media = useAuthenticatedMedia(image ? mediaThumbnailPath(image.url, MOMENT_IMAGE_CSS_WIDTH) : null, 'user', 'image');
  if (!image) return null;
  if (media.error) return <div className="moment-photo-error">图片暂时加载失败{media.retriable && <button type="button" onClick={media.retry}>重试</button>}</div>;
  if (!media.url) return <div className="moment-photo-skeleton" aria-label="正在加载图片" />;
  return (
    <button
      type="button"
      className="moment-photo image-part"
      data-media-id={image.id}
      data-src={media.url}
      data-alt={moment.text}
      onClick={() => window.dispatchEvent(new CustomEvent('sooya:open-image', { detail: { id: image.id } }))}
      aria-label="查看动态图片"
    >
      <img src={media.url} alt={moment.text} />
    </button>
  );
}

export default function MomentsPage() {
  const [conversation, setConversation] = useState<ConversationInfo | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const avatarPath = conversation?.persona.avatar ? mediaThumbnailPath(conversation.persona.avatar, 96) : null;
  const avatar = useAuthenticatedMedia(avatarPath, 'user', 'image');

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [nextConversation, nextMoments] = await Promise.all([api.conversation(), api.moments(60)]);
      setConversation(nextConversation);
      setMoments(nextMoments.moments);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '朋友圈加载失败');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(true); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const setLiked = async (moment: Moment) => {
    const liked = !moment.liked;
    setMoments((rows) => rows.map((row) => row.id === moment.id ? { ...row, liked } : row));
    try {
      const result = await api.likeMoment(moment.id, liked);
      setMoments((rows) => rows.map((row) => row.id === moment.id ? result.moment : row));
    } catch (cause) {
      setMoments((rows) => rows.map((row) => row.id === moment.id ? { ...row, liked: moment.liked } : row));
      setError(cause instanceof Error ? cause.message : '点赞失败');
    }
  };

  const personaName = conversation?.persona.name ?? 'SOOYA';
  const personaAvatar = avatar.url ?? '/avatars/sooya.svg';

  return (
    <main className="moments-page">
      <header className="moments-topbar">
        <AppLink href="/" className="moments-back" aria-label="返回聊天">‹</AppLink>
        <div><h1>朋友圈</h1><span>{personaName} 的生活动态</span></div>
        <button type="button" className="moments-refresh" onClick={() => void load()} aria-label="刷新朋友圈">↻</button>
      </header>

      <section className="moments-feed" aria-busy={loading}>
        {error && <div className="moments-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div>}
        {loading && moments.length === 0 && <div className="moments-loading"><span /><span /><span /></div>}
        {!loading && moments.length === 0 && !error && (
          <div className="moments-empty">
            <img src={personaAvatar} alt="" />
            <strong>这里还很安静</strong>
            <p>{personaName} 经历到值得记录的小事后，会自己发在这里。</p>
          </div>
        )}
        {moments.map((moment) => {
          const place = [moment.location?.city, moment.location?.name].filter(Boolean).join(' · ');
          const weather = moment.weather
            ? `${weatherConditionLabel(moment.weather.condition)}${moment.weather.temperatureC == null ? '' : ` · ${Math.round(moment.weather.temperatureC)}°C`}`
            : '';
          return (
            <article className="moment-card" key={moment.id} data-testid="moment-card">
              <img className="moment-avatar" src={personaAvatar} alt="" />
              <div className="moment-body">
                <div className="moment-author"><strong>{personaName}</strong><span>{moment.activity}</span></div>
                <p className="moment-text">{moment.text}</p>
                <MomentPhoto moment={moment} />
                {(place || weather) && <div className="moment-context">{place && <span>⌖ {place}</span>}{weather && <span>{weather}</span>}</div>}
                <div className="moment-footer">
                  <time dateTime={moment.createdAt}>{relativeTime(moment.createdAt)}</time>
                  <button type="button" className={`moment-like${moment.liked ? ' is-liked' : ''}`} aria-pressed={moment.liked} onClick={() => void setLiked(moment)}>
                    <span aria-hidden="true">{moment.liked ? '♥' : '♡'}</span>{moment.liked ? '已喜欢' : '喜欢'}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}
''')

# AppShell route lifecycle test now knows about Moments.
replace(
    'packages/web/src/AppShell.test.tsx',
    "  galleryMounts: 0,\n  galleryUnmounts: 0,\n  adminMounts: 0,",
    "  momentsMounts: 0,\n  momentsUnmounts: 0,\n  galleryMounts: 0,\n  galleryUnmounts: 0,\n  adminMounts: 0,"
)
replace(
    'packages/web/src/AppShell.test.tsx',
    "vi.mock('./components/GalleryPage.js', () => ({",
    "vi.mock('./components/MomentsPage.js', () => ({\n  default: () => {\n    useEffect(() => {\n      lifecycle.momentsMounts += 1;\n      return () => { lifecycle.momentsUnmounts += 1; };\n    }, []);\n    return <div data-testid=\"moments\">moments</div>;\n  }\n}));\n\nvi.mock('./components/GalleryPage.js', () => ({"
)
replace(
    'packages/web/src/AppShell.test.tsx',
    "    galleryMounts: 0,\n    galleryUnmounts: 0,\n    adminMounts: 0,",
    "    momentsMounts: 0,\n    momentsUnmounts: 0,\n    galleryMounts: 0,\n    galleryUnmounts: 0,\n    adminMounts: 0,"
)
replace(
    'packages/web/src/AppShell.test.tsx',
    "    await act(async () => { navigate('/gallery'); });\n\n    expect(lifecycle.chatMounts).toBe(1);",
    "    await act(async () => { navigate('/moments'); });\n\n    expect(lifecycle.chatMounts).toBe(1);\n    expect(lifecycle.chatUnmounts).toBe(0);\n    expect(host.querySelector('[data-testid=\"chat\"]')).toBeNull();\n    expect(host.querySelector('[data-testid=\"moments\"]')).not.toBeNull();\n    expect(host.querySelector('[data-testid=\"viewer\"]')).not.toBeNull();\n\n    await act(async () => { navigate('/gallery'); });\n\n    expect(lifecycle.momentsUnmounts).toBe(1);\n    expect(lifecycle.chatMounts).toBe(1);"
)

# Admin language: same persisted config keys, new product meaning.
write('packages/web/src/components/life/LifeContactBoundaryForm.tsx', r'''import { useEffect, useState, type FormEvent } from 'react';
import { featureApi, type LifeSettings } from '../../lib/features.js';
import { contactBoundaryPayload } from '../../lib/lifeObservation.js';

interface LifeContactBoundaryFormProps {
  initial: LifeSettings;
  onNotice: (message: string) => void;
}

function visibleMode(value: LifeSettings['proactiveMode']): 'auto' | 'text' | 'image' {
  if (value === 'image') return 'image';
  if (value === 'auto' || value === undefined) return 'auto';
  return 'text';
}

export function LifeContactBoundaryForm({ initial, onNotice }: LifeContactBoundaryFormProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LifeSettings>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(initial);
  }, [dirty, initial]);

  const change = (patch: Partial<LifeSettings>) => {
    setDraft((value) => ({ ...value, ...patch }));
    setDirty(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await featureApi.updateLifeSettings(contactBoundaryPayload(draft));
      setDraft(result.settings);
      setDirty(false);
      onNotice('朋友圈设置已保存');
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="life-disclosure life-boundaries" data-testid="life-boundaries">
      <button
        type="button"
        className="life-disclosure-toggle"
        aria-expanded={open}
        aria-controls="life-boundaries-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <span><strong>朋友圈发布</strong><small>决定她什么时候把生活分享到朋友圈</small></span>
        <span aria-hidden="true">{open ? '−' : '＋'}</span>
      </button>
      {open && (
        <form id="life-boundaries-panel" className="life-boundary-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>允许发朋友圈</span>
            <input name="reachOut" type="checkbox" checked={draft.reachOut} onChange={(event) => change({ reachOut: event.target.checked })} />
          </label>
          <label>
            <span>动态最小间隔（分钟）</span>
            <input name="quietGapMinutes" type="number" min={5} max={1440} value={draft.quietGapMinutes} onChange={(event) => change({ quietGapMinutes: Number(event.target.value) })} />
          </label>
          <label>
            <span>每日动态上限</span>
            <input name="maxReachOutsPerDay" type="number" min={0} max={20} value={draft.maxReachOutsPerDay} onChange={(event) => change({ maxReachOutsPerDay: Number(event.target.value) })} />
          </label>
          <fieldset>
            <legend>不发动态的时段</legend>
            <input aria-label="静默开始" name="silentFrom" type="number" min={0} max={23} value={draft.silentFrom} onChange={(event) => change({ silentFrom: Number(event.target.value) })} />
            <span>点至</span>
            <input aria-label="静默结束" name="silentTo" type="number" min={0} max={23} value={draft.silentTo} onChange={(event) => change({ silentTo: Number(event.target.value) })} />
            <span>点</span>
          </fieldset>
          <label>
            <span>发布方式</span>
            <select name="proactiveMode" value={visibleMode(draft.proactiveMode)} onChange={(event) => change({ proactiveMode: event.target.value as LifeSettings['proactiveMode'] })}>
              <option value="auto">自动</option>
              <option value="text">文字动态</option>
              <option value="image">图片动态</option>
            </select>
          </label>
          <p>朋友圈不会插进聊天记录。旧的“语音 / 文字＋表情包”主动模式会自动按文字动态处理。</p>
          <button type="submit" disabled={busy || !dirty}>{busy ? '正在保存…' : '保存朋友圈设置'}</button>
        </form>
      )}
    </section>
  );
}
''')

replace(
    'packages/web/src/lib/features.ts',
    "  messageId: string | null;\n  sendSuccess: boolean;",
    "  messageId: string | null;\n  momentId: string | null;\n  sendSuccess: boolean;"
)
replace(
    'packages/web/src/lib/features.ts',
    "  references?: { total: number; messages?: number; stickers?: number };",
    "  references?: { total: number; messages?: number; messageParts?: number; stickers?: number; moments?: number };"
)

replace(
    'packages/web/src/lib/lifeObservation.ts',
    "      title: attempt.candidateActivity ?? '主动联系尝试',\n      detail: attempt.status === 'sent'\n        ? '已经发送'\n        : attempt.status === 'blocked'\n          ? '没有打扰你'\n          : '发送失败'",
    "      title: attempt.candidateActivity ?? '朋友圈发布尝试',\n      detail: attempt.status === 'sent'\n        ? '已发布到朋友圈'\n        : attempt.status === 'blocked'\n          ? '暂未发布'\n          : '发布失败'"
)

# Replace the product-facing reason dictionaries and gap details.
replace(
    'packages/web/src/lib/lifeView.ts',
    "  ok: '条件满足，下一次 tick 就会开口',\n  disabled: '你在这个页面关掉了主动开口',\n  deployment_disabled: '部署层关掉了主动开口（改 .env 的 ENABLE_LIFE_REACH_OUT）',\n  silent_hours: '在静默时段里，她不打扰你',\n  asleep: '她在睡觉',\n  user_was_recently_here: '你刚说过话，她要等满安静间隔',\n  already_spoke: '上一条还是她说的，不叠着发',\n  daily_cap: '今天的主动条数已经用完',\n  nothing_worth_saying: '还没有做完、且没跟你说过的事',\n  share_candidate: '有值得分享的新动态'",
    "  ok: '条件满足，下一次 tick 可以发布动态',\n  disabled: '你在这个页面关掉了朋友圈发布',\n  deployment_disabled: '部署层关掉了朋友圈发布（沿用 .env 的 ENABLE_LIFE_REACH_OUT）',\n  silent_hours: '在这个时段里，她不发动态',\n  asleep: '她在睡觉',\n  user_was_recently_here: '旧版聊天间隔条件',\n  already_spoke: '旧版主动聊天条件',\n  daily_cap: '今天的动态条数已经用完',\n  nothing_worth_saying: '还没有值得发布的新动态',\n  share_candidate: '有值得分享的新动态',\n  moment_gap: '离上一条动态还没到最小间隔'"
)
replace(
    'packages/web/src/lib/lifeView.ts',
    "  reply_in_progress: '正在回复中',\n  recent_topic: '近期已经聊过这个话题',\n  chat_unavailable: '聊天服务暂不可用',\n  candidate_already_sent: '这件事已经分享过',\n  candidate_already_queued: '这件事已经在发送队列中',\n  user_appeared: '你刚刚回来了，已取消主动消息',",
    "  reply_in_progress: '正在回复聊天，动态稍后再发',\n  recent_topic: '这件事近期已经聊过或发过动态',\n  chat_unavailable: '朋友圈文案模型暂不可用',\n  candidate_already_sent: '这件事已经发布过',\n  candidate_already_queued: '这件事已经在发布队列中',\n  user_appeared: '聊天回复获得优先级，本次动态稍后重试',"
)
replace(
    'packages/web/src/lib/lifeView.ts',
    "  text_sticker_failed: '表情包准备失败，已回退为文字',\n  voice_unavailable: '语音能力不可用，已回退为文字',\n  voice_failed: '语音生成失败，已回退为文字',\n  image_unavailable: '图片能力不可用，已回退为文字',\n  image_failed: '图片生成失败，已回退为文字',\n  aborted: '任务已取消',\n  compose_failed: '主动消息生成失败',\n  empty_text: '模型没有生成可发送文字',\n  media_failed: '附加媒体准备失败',\n  message_persist_failed: '消息保存失败'",
    "  text_sticker_failed: '旧表情包模式已按文字动态发布',\n  voice_unavailable: '旧语音模式已按文字动态发布',\n  voice_failed: '旧语音模式已按文字动态发布',\n  image_unavailable: '图片能力不可用，已回退为文字动态',\n  image_failed: '图片生成失败，已回退为文字动态',\n  image_plan_missing: '没有合适的配图方案，已发布文字动态',\n  aborted: '发布任务已取消',\n  compose_failed: '朋友圈文案生成失败',\n  invalid_share_text: '朋友圈文案不完整，本次没有发布',\n  empty_text: '模型没有生成可发布文字',\n  media_failed: '动态图片准备失败',\n  message_persist_failed: '旧版消息保存失败',\n  moment_persist_failed: '动态保存失败'"
)
replace(
    'packages/web/src/lib/lifeView.ts',
    "  if (value.startsWith('message_persist_failed:')) return PROACTIVE_REASON_LABELS.message_persist_failed!;",
    "  if (value.startsWith('message_persist_failed:')) return PROACTIVE_REASON_LABELS.message_persist_failed!;\n  if (value.startsWith('moment_persist_failed:')) return PROACTIVE_REASON_LABELS.moment_persist_failed!;"
)
replace(
    'packages/web/src/lib/lifeView.ts',
    "  if (reachOut.reason === 'daily_cap') {",
    "  if (reachOut.reason === 'moment_gap') {\n    return `${base}（至少间隔 ${settings.quietGapMinutes} 分钟）`;\n  }\n  if (reachOut.reason === 'daily_cap') {"
)

# Moments visual language, appended after existing theme so it inherits variables.
styles = r'''

/* ------------------------------- Moments -------------------------------- */
.moments-page {
  min-height: 100dvh;
  max-width: 760px;
  margin: 0 auto;
  background: color-mix(in srgb, var(--bg) 94%, transparent);
}

.moments-topbar {
  min-height: calc(64px + env(safe-area-inset-top));
  padding: calc(8px + env(safe-area-inset-top)) 14px 8px;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 42px;
  align-items: center;
  gap: 8px;
  position: sticky;
  top: 0;
  z-index: 30;
  background: var(--surface-glass);
  backdrop-filter: saturate(140%) blur(16px);
  border-bottom: 1px solid var(--line);
}

.moments-topbar > div { text-align: center; min-width: 0; }
.moments-topbar h1 { margin: 0; font-size: 17px; line-height: 1.25; }
.moments-topbar span { display: block; margin-top: 1px; color: var(--ink-faint); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.moments-back,
.moments-refresh {
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--ink);
  text-decoration: none;
  font: inherit;
  font-size: 28px;
  line-height: 1;
}
.moments-refresh { font-size: 20px; }
.moments-back:hover,
.moments-refresh:hover { background: var(--surface-hover); }

.moments-feed { padding: 2px 16px calc(28px + env(safe-area-inset-bottom)); }
.moment-card {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  gap: 11px;
  padding: 20px 0;
  border-bottom: 1px solid var(--line);
}
.moment-avatar { width: 42px; height: 42px; border-radius: 10px; object-fit: cover; background: var(--panel-alt); }
.moment-body { min-width: 0; }
.moment-author { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.moment-author strong { color: var(--accent-deep); font-size: 15px; }
.moment-author span { color: var(--ink-faint); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.moment-text { margin: 7px 0 10px; color: var(--ink); font-size: 15px; line-height: 1.62; white-space: pre-wrap; overflow-wrap: anywhere; }
.moment-photo {
  display: block;
  width: min(100%, 540px);
  padding: 0;
  border: 0;
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel-alt);
  text-align: left;
}
.moment-photo img { display: block; width: 100%; max-height: 620px; object-fit: cover; }
.moment-photo-skeleton { width: min(100%, 540px); aspect-ratio: 4 / 3; border-radius: 12px; background: linear-gradient(110deg, var(--shimmer-base) 20%, var(--shimmer-highlight) 38%, var(--shimmer-base) 56%); background-size: 200% 100%; animation: momentShimmer 1.25s linear infinite; }
@keyframes momentShimmer { to { background-position-x: -200%; } }
.moment-photo-error { width: min(100%, 540px); padding: 16px; border-radius: 12px; background: var(--panel-alt); color: var(--ink-soft); font-size: 12px; }
.moment-photo-error button { margin-left: 8px; border: 0; background: transparent; color: var(--accent-deep); font-weight: 600; }
.moment-context { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 9px; color: var(--accent-deep); font-size: 11.5px; }
.moment-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
.moment-footer time { color: var(--ink-faint); font-size: 11.5px; }
.moment-like { min-height: 34px; padding: 0 10px; display: inline-flex; gap: 5px; align-items: center; border: 0; border-radius: 10px; background: transparent; color: var(--ink-soft); font-size: 12px; }
.moment-like span { font-size: 17px; line-height: 1; }
.moment-like:hover { background: var(--surface-hover); }
.moment-like.is-liked { color: var(--danger); }
.moments-error { margin: 14px 0; padding: 11px 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid var(--accent-line); border-radius: 12px; background: var(--panel); color: var(--ink-soft); font-size: 12px; }
.moments-error button { border: 0; background: transparent; color: var(--accent-deep); font-weight: 600; }
.moments-empty { padding: 90px 28px; display: flex; flex-direction: column; align-items: center; text-align: center; color: var(--ink-soft); }
.moments-empty img { width: 66px; height: 66px; border-radius: 16px; object-fit: cover; margin-bottom: 14px; }
.moments-empty strong { color: var(--ink); font-size: 16px; }
.moments-empty p { max-width: 320px; margin: 7px 0 0; font-size: 13px; }
.moments-loading { padding: 24px 0; display: grid; gap: 18px; }
.moments-loading span { display: block; height: 110px; border-radius: 14px; background: var(--panel-alt); }

@media (max-width: 560px) {
  .moments-feed { padding-left: 12px; padding-right: 12px; }
  .moment-card { grid-template-columns: 38px minmax(0, 1fr); gap: 9px; padding: 17px 0; }
  .moment-avatar { width: 38px; height: 38px; border-radius: 9px; }
  .moment-text { font-size: 14.5px; }
}
'''
css_path = 'packages/web/src/styles.css'
css = read(css_path)
if '/* ------------------------------- Moments -------------------------------- */' not in css:
    write(css_path, css + styles)

# ---------------------------------------------------------------------------
# Tests: new contract is Moments, not proactive assistant messages.
# ---------------------------------------------------------------------------
write('packages/server/test/proactive-composer.test.ts', r'''import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

function sharePlan(text: string, image: { kind: 'pov' | 'selfie'; scene: string } | null = { kind: 'pov', scene: '社区公园步道旁一只橘猫看向手机镜头' }): string {
  return JSON.stringify({ text, image });
}

function asSharePlan(chunk: string): string {
  try {
    const value = JSON.parse(chunk) as { text?: unknown; image?: unknown };
    if (typeof value.text === 'string' && 'image' in value) return chunk;
  } catch { /* plain test text */ }
  return sharePlan(chunk);
}

function stageCandidate(h: Harness): void {
  const oldUser = h.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '早上好' }] });
  h.app.db.raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(localTime('2026-07-31T09:00').toISOString(), oldUser.message.id);
  h.app.repos.life.advance({
    activity: '去公园看猫', kind: 'out', mood: '好奇',
    startedAt: localTime('2026-07-31T14:00').toISOString(),
    endsAt: localTime('2026-07-31T17:00').toISOString()
  });
  h.app.repos.life.advance({
    activity: '练琴', kind: 'play', mood: '专注',
    startedAt: localTime('2026-07-31T17:00').toISOString(),
    endsAt: localTime('2026-07-31T18:00').toISOString()
  });
}

async function withMoments(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  return await createHarness({
    ...options,
    env: {
      ENABLE_LIFE_ENGINE: 'true',
      ENABLE_LIFE_REACH_OUT: 'true',
      LIFE_QUIET_GAP_MINUTES: '60',
      ENABLE_BACKGROUND_JOBS: 'false',
      ADMIN_API_TOKEN: 'admin-test-token',
      ...options.env
    },
    chat: {
      ...options.chat,
      script: options.chat?.script?.map((chunks) => chunks.map(asSharePlan)) ?? [[sharePlan('公园那只橘猫今天格外黏人，踩着我的鞋不肯走。')]]
    },
    startWorkers: false,
    clock: () => localTime('2026-07-31T17:30')
  });
}

describe('ProactiveComposer -> Moments', () => {
  it('publishes a Life share as a Moment without inserting an assistant chat message or push job', async () => {
    harness = await withMoments();
    stageCandidate(harness);
    const beforeAssistant = harness.app.repos.messages.recent(50).filter((message) => message.role === 'assistant').length;

    const result = await harness.app.services.proactive.run({ mode: 'text' });

    expect(result.status).toBe('sent');
    expect(result.messageId).toBeNull();
    expect(result.momentId).toEqual(expect.stringMatching(/^moment_/));
    expect(harness.app.repos.moments.get(result.momentId!)).toMatchObject({
      activity: '去公园看猫',
      image_media_id: null
    });
    expect(harness.app.repos.messages.recent(50).filter((message) => message.role === 'assistant')).toHaveLength(beforeAssistant);
    expect(harness.app.repos.jobs.list(20).filter((job) => job.type === 'push.reply')).toHaveLength(0);
    expect(harness.app.repos.proactive.list(1)[0]).toMatchObject({ status: 'sent', messageId: null, momentId: result.momentId, sendSuccess: true });
    expect(harness.app.repos.life.events().some((event) => event.shared_at)).toBe(true);
  });

  it('does not require the user to have been quiet before posting a Moment', async () => {
    harness = await withMoments();
    stageCandidate(harness);
    const recent = harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '我回来啦' }] }).message;
    harness.app.db.raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(localTime('2026-07-31T17:20').toISOString(), recent.id);

    const evaluation = harness.app.services.proactive.evaluate();
    expect(evaluation.reach).toBe(true);
    expect(evaluation.reason).toBe('ok');
  });

  it('still yields to an active user reply batch so chat keeps provider priority', async () => {
    harness = await withMoments();
    stageCandidate(harness);
    const user = harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '连续输入' }] }).message;
    harness.app.repos.replyBatches.appendOrCreateMessage(user.id, new Date(Date.now() + 5000).toISOString(), new Date(Date.now() + 5000).toISOString());

    const result = await harness.app.services.proactive.run();
    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('reply_in_progress');
    expect(harness.app.repos.moments.list()).toHaveLength(0);
  });

  it.each(['voice', 'text_sticker'] as const)('normalizes legacy %s proactive mode to a text Moment', async (mode) => {
    harness = await withMoments();
    stageCandidate(harness);
    const result = await harness.app.services.proactive.run({ mode });
    expect(result.status).toBe('sent');
    expect(result.requestedMode).toBe('text');
    expect(result.finalMode).toBe('text');
    expect(harness.app.repos.moments.get(result.momentId!)?.image_media_id).toBeNull();
  });

  it('plans a grounded POV photo and stores it as a Moment media reference', async () => {
    harness = await withMoments({ image: 'ok' });
    stageCandidate(harness);
    const park = harness.app.repos.locations.create({ name: '社区公园', kind: 'park', city: '宁波', source: 'admin' });
    harness.app.repos.locations.recordVisit({ locationId: park.id, enteredAt: localTime('2026-07-31T14:00').toISOString(), leftAt: localTime('2026-07-31T17:00').toISOString() });

    const result = await harness.app.services.proactive.run({ mode: 'image' });
    expect(result.status).toBe('sent');
    expect(result.finalMode).toBe('image');
    const moment = harness.app.repos.moments.get(result.momentId!)!;
    expect(moment.location_name).toBe('社区公园');
    expect(moment.city).toBe('宁波');
    expect(moment.image_media_id).toBeTruthy();
    expect(harness.app.repos.media.references(moment.image_media_id!)).toMatchObject({ moments: 1, total: 1 });
    const prompt = JSON.stringify(harness.state.imageRequests[0]!.body);
    expect(prompt).toContain('社区公园');
    expect(prompt).toContain('橘猫');
    expect(harness.state.imageRequests[0]!.body.input_images).toBeUndefined();
  });

  it('uses persona references only for a selfie Moment', async () => {
    harness = await withMoments({
      image: 'anuma',
      chat: { script: [[sharePlan('窗边这杯咖啡意外地好喝，今天的光也很舒服。', { kind: 'selfie', scene: '咖啡店窗边的 SOOYA 举着咖啡杯看向手机' })]] }
    });
    stageCandidate(harness);
    const result = await harness.app.services.proactive.run({ mode: 'image' });
    expect(result.status).toBe('sent');
    expect(harness.state.imageRequests[0]!.body.input_images).toBeDefined();
    expect(harness.app.repos.proactive.list(1)[0]!.detail).toMatchObject({ photoKind: 'selfie', referenceUsed: true, destination: 'moments' });
  });

  it('repairs an incomplete Moment caption once and refuses a second invalid caption', async () => {
    harness = await withMoments({ chat: { script: [[JSON.stringify({ text: '刚刚', image: null })], [JSON.stringify({ text: '路边的猫盯了我好久，尾巴还扫到了鞋边。', image: null })]] } });
    stageCandidate(harness);
    const result = await harness.app.services.proactive.run({ mode: 'text' });
    expect(harness.app.repos.moments.get(result.momentId!)?.text).toContain('路边的猫');
    await harness.cleanup();
    harness = null;

    harness = await withMoments({ chat: { script: [[JSON.stringify({ text: '刚刚', image: null })], [JSON.stringify({ text: '刚发生的事：', image: null })]] } });
    stageCandidate(harness);
    const blocked = await harness.app.services.proactive.run({ mode: 'text' });
    expect(blocked.status).toBe('failed');
    expect(blocked.blockedReason).toBe('invalid_share_text');
    expect(harness.app.repos.moments.list()).toHaveLength(0);
  });

  it('exposes Moments through the chat-token API and supports liking', async () => {
    harness = await withMoments();
    stageCandidate(harness);
    const posted = await harness.app.services.proactive.run({ mode: 'text' });

    const list = await harness.app.server.inject({ method: 'GET', url: '/api/moments' });
    expect(list.statusCode).toBe(200);
    expect(list.json().moments[0]).toMatchObject({ id: posted.momentId, liked: false, activity: '去公园看猫' });

    const liked = await harness.app.server.inject({ method: 'PATCH', url: `/api/moments/${posted.momentId}/like`, payload: { liked: true } });
    expect(liked.statusCode).toBe(200);
    expect(liked.json().moment.liked).toBe(true);
  });

  it('aborts an in-flight Moment composition when a user reply takes provider priority, then leaves the candidate unshared', async () => {
    harness = await withMoments({ chat: { script: [['公园那只猫今天一直跟着我走。'], ['回复用户']], delayMs: 800 } });
    stageCandidate(harness);
    const pending = harness.app.services.proactive.run();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await harness.app.server.inject({ method: 'POST', url: '/api/messages', payload: { clientMsgId: 'user-appeared-1', content: [{ type: 'text', text: '在吗' }] } });
    const result = await pending;
    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('user_appeared');
    expect(harness.app.repos.moments.list()).toHaveLength(0);
    await vi.waitFor(() => expect(harness!.app.repos.replyBatches.openBatch()).toBeUndefined(), { timeout: 10_000 });
  });
});
''')

print('Moments conversion applied.')
