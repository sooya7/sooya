import type { MessageRepo, CreatePartInput } from '../db/repos/message.repo.js';
import type { ProactiveAttemptRepo, ProactiveMode } from '../db/repos/proactive.repo.js';
import type { JobRepo } from '../db/repos/misc.repo.js';
import type { ReplyBatchRepo } from '../db/repos/reply-batch.repo.js';
import type { LifeLogRow } from '../db/repos/life.repo.js';
import type { CapabilityRegistry } from './capabilities.js';
import type { ConfigStore } from '../config/store.js';
import type { LifeRuntime } from './life.js';
import type { MediaStore } from '../media/store.js';
import type { StickerLibrary } from '../media/stickers.js';
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
  /** Test/admin seam; production uses the configured mode policy. */
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
  messageId: string | null;
  requestedMode: ProactiveMode | null;
  finalMode: ProactiveMode | null;
  fallbackReason: string | null;
  sendSuccess: boolean;
}

interface PreparedMedia {
  part: CreatePartInput | null;
  finalMode: ProactiveMode;
  fallbackReason: string | null;
  stickerId: string | null;
  detail?: Record<string, unknown>;
}

const ProactiveSharePlanSchema = z.object({
  // Keep the schema permissive enough for the quality guard to repair obvious
  // fragments such as “刚刚” instead of classifying them as transport errors.
  text: z.string().trim().min(1).max(80),
  image: z.object({
    kind: z.enum(['pov', 'selfie']),
    scene: z.string().trim().min(4).max(300),
    action: z.string().trim().max(160).optional(),
    mood: z.string().trim().max(80).optional(),
    framing: z.enum(['front', 'side', 'full-body', 'environment']).optional()
  }).nullable()
});

type ProactiveSharePlan = z.infer<typeof ProactiveSharePlanSchema>;

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
 * Owns the complete proactive reach-out transaction. Rules are evaluated before
 * a model call; media is persisted before the candidate is marked shared; and
 * push is only enqueued after the sent assistant message exists.
 */
export class ProactiveComposer {
  constructor(
    private readonly deps: {
      attempts: ProactiveAttemptRepo;
      jobs: JobRepo;
      messages: MessageRepo;
      life: LifeRuntime;
      replyBatches: ReplyBatchRepo;
      capabilities: CapabilityRegistry;
      config: ConfigStore;
      media: MediaStore;
      stickers: StickerLibrary;
      bus: EventBus;
      /** D5: proactive voice runs through the full voice pipeline. */
      voice?: import('./voice/service.js').VoiceService | null;
      /** P0-1: proactive deliveries are scheduled by the reply coordinator. */
      coordinator: ReplyCoordinator;
      /** Next-phase privacy-safe metrics (METRICS_DASHBOARD_ENABLED). */
      metrics?: import('./metrics.js').MetricsService;
      mediaDirector: MediaDirector;
      personaReferences: PersonaReferenceLoader;
      locations: LifeLocationRepo;
      worldSnapshot: () => WorldSnapshot;
    }
  ) {}

  /** True when a user message arrived after the evaluation snapshot. */
  private userAppearedSince(lastUserAt: string | null): boolean {
    if (!lastUserAt) return false;
    const recent = this.deps.messages.recent(20);
    for (const message of recent) {
      if (message.role !== 'user') continue;
      if (Date.parse(message.createdAt) > Date.parse(lastUserAt)) return true;
    }
    return false;
  }

  evaluate(): ProactiveEvaluation {
    const recent = this.deps.messages.recent(40);
    const lastUser = [...recent].reverse().find((message) => message.role === 'user');
    const lastAssistant = [...recent].reverse().find((message) => message.role === 'assistant');
    const decision = this.deps.life.shouldReachOut(
      lastUser ? new Date(lastUser.createdAt) : null,
      lastAssistant ? new Date(lastAssistant.createdAt) : null
    );
    const base = {
      candidate: decision.candidate,
      lastUserAt: lastUser?.createdAt ?? null,
      lastAssistantAt: lastAssistant?.createdAt ?? null
    };
    if (!decision.reach || !decision.candidate) return { reach: false, reason: decision.reason, ...base };
    // §50.4: never reach out while a reply batch is open — the user is mid-
    // conversation and an unprompted message would stack on her reply.
    const openBatch = this.deps.replyBatches.openBatch();
    if (openBatch) return { reach: false, reason: 'reply_in_progress', ...base };
    if (this.recentlyDiscussed(decision.candidate, recent)) {
      return { reach: false, reason: 'recent_topic', ...base };
    }
    if (!this.deps.capabilities.has('chat')) {
      return { reach: false, reason: 'chat_unavailable', ...base };
    }
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
      detail: { evaluatedAt: new Date().toISOString() }
    });

    if (!evaluation.reach || !candidate) {
      return {
        status: 'blocked',
        blockedReason: evaluation.reason,
        candidateId: candidate?.id ?? null,
        messageId: null,
        requestedMode,
        finalMode: null,
        fallbackReason: null,
        sendSuccess: false
      };
    }

    // P0-1: the whole delivery (compose -> media -> persist) runs as a task on
    // the reply coordinator. The coordinator enforces user-reply priority,
    // aborts the task the moment a user message arrives (the signal reaches
    // the chat/TTS/image providers), and guarantees once-only scheduling.
    let finalMode: ProactiveMode | null = null;
    let fallbackReason: string | null = null;
    const task: ProactiveDeliveryTask = {
      candidateId: candidate.id,
      requestedMode: requestedMode ?? 'text',
      run: async (signal) => {
        const provider = this.deps.capabilities.chatProvider();
        const persona = this.deps.config.getPersona();
        const lifeLines = this.deps.life.contextLines(this.lastUserDate(evaluation));

        let sharePlan: ProactiveSharePlan;
        const eventContext = this.resolveEventContext(candidate);
        try {
          sharePlan = await composeProactiveSharePlan(
            provider,
            persona.systemPrompt,
            lifeLines,
            eventContext,
            requestedMode ?? 'text',
            signal
          );
        } catch (error) {
          if (signal.aborted) return { kind: 'discarded' };
          const reason = error instanceof Error && error.message === 'invalid_share_text'
            ? 'invalid_share_text'
            : 'compose_failed';
          this.deps.attempts.update(attempt.id, { status: 'failed', blockedReason: reason, detail: { error: safeError(error) } });
          throw new Error(reason);
        }

        let prepared: PreparedMedia;
        try {
          prepared = await this.prepareMedia(requestedMode ?? 'text', sharePlan, eventContext, candidate, signal);
        } catch (error) {
          if (signal.aborted) return { kind: 'discarded' };
          const reason = 'media_failed';
          this.deps.attempts.update(attempt.id, { status: 'failed', blockedReason: reason, detail: { error: safeError(error) } });
          throw new Error(reason);
        }
        finalMode = prepared.finalMode;
        fallbackReason = prepared.fallbackReason;

        // Final gate: the user may have appeared while we composed/prepared.
        if (signal.aborted || this.userAppearedSince(evaluation.lastUserAt)) {
          return { kind: 'discarded' };
        }

        const parts: CreatePartInput[] = [{ type: 'text', text: sharePlan.text, status: 'sent' }];
        if (prepared.part) parts.push(prepared.part);
        try {
          // P1-4: proactive messages are persisted ONLY through the reply
          // coordinator (publishProactiveMessage): the attempt is marked
          // 'sent' in the SAME transaction as the message, and the partial
          // unique index on (candidate_id) WHERE status='sent' rejects a
          // concurrent sender, rolling the message back with it.
          const persisted = this.deps.coordinator.publishProactiveMessage({
            parts,
            meta: {
              proactive: true,
              proactiveAttemptId: attempt.id,
              proactiveCandidateId: candidate.id,
              lifeLogId: candidate.id,
              activity: candidate.activity,
              proactiveMode: prepared.finalMode,
              ...(prepared.fallbackReason ? { fallbackReason: prepared.fallbackReason } : {})
            },
            onPersisted: (message) => {
              this.deps.attempts.update(attempt.id, {
                status: 'sent',
                blockedReason: null,
                finalMode: prepared.finalMode,
                fallbackReason: prepared.fallbackReason,
                messageId: message.id,
                sendSuccess: true,
                detail: {
                  sharePlanVersion: 2,
                  photoKind: sharePlan.image?.kind ?? null,
                  eventLocationId: eventContext.location?.id ?? null,
                  imageDirectorUsed: Boolean(prepared.detail?.imageDirectorUsed),
                  referenceUsed: Boolean(prepared.detail?.referenceUsed),
                  mediaPersisted: Boolean(prepared.part),
                  pushEnqueued: false
                }
              });
            }
          });
          if (!persisted) throw new Error('proactive message unexpectedly duplicated');
          if (prepared.stickerId) this.deps.stickers.markUsed(prepared.stickerId);
          this.deps.life.markShared(candidate.id);
          this.deps.bus.fanout(persisted.event);
          let pushEnqueued = false;
          try {
            this.deps.jobs.enqueue('push.reply', { messageId: persisted.message.id }, { maxAttempts: 3 });
            pushEnqueued = true;
          } catch (error) {
            this.deps.attempts.update(attempt.id, { detail: { pushError: safeError(error) } });
          }
          this.deps.attempts.update(attempt.id, {
            detail: { ...prepared.detail, mediaPersisted: Boolean(prepared.part), pushEnqueued }
          });
          return { kind: 'sent', messageId: persisted.message.id };
        } catch (error) {
          if (isUniqueConstraint(error)) {
            // Another sender won the race for this candidate (P1-4).
            this.deps.attempts.update(attempt.id, { status: 'blocked', blockedReason: 'candidate_already_sent' });
            return { kind: 'blocked', blockedReason: 'candidate_already_sent' };
          }
          const reason = 'message_persist_failed';
          this.deps.attempts.update(attempt.id, {
            status: 'failed',
            blockedReason: reason,
            finalMode: prepared.finalMode,
            fallbackReason: prepared.fallbackReason,
            detail: { error: safeError(error) }
          });
          throw new Error(`${reason}: ${(error as Error).message ?? String(error)}`);
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
        messageId: result.messageId,
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
      blockedReason: result.blockedReason ?? result.status,
      candidateId: candidate.id,
      messageId: null,
      requestedMode,
      finalMode,
      fallbackReason,
      sendSuccess: false
    };
  }

  private resolveMode(requested?: ProactiveMode): ProactiveMode {
    if (requested) return requested;
    const configured = this.deps.life.settings.proactiveMode ?? 'auto';
    if (configured !== 'auto') return configured;
    const persona = this.deps.config.getPersona();
    // Auto is deliberately text-first: proactive media is opt-in through a
    // high-frequency media policy, so a default deployment cannot surprise the
    // user with a large image or audio clip.
    if (persona.stickerPolicy.enabled && persona.stickerPolicy.frequency === 'high' && this.deps.stickers.count() > 0) return 'text_sticker';
    if (persona.voicePolicy.enabled && persona.voicePolicy.frequency === 'high' && this.deps.capabilities.has('tts')) return 'voice';
    if (persona.imagePolicy.enabled && persona.imagePolicy.frequency === 'high' && this.deps.capabilities.has('image')) return 'image';
    return 'text';
  }

  private async prepareMedia(mode: ProactiveMode, sharePlan: ProactiveSharePlan, eventContext: ProactiveEventContext, candidate: LifeLogRow, signal: AbortSignal): Promise<PreparedMedia> {
    const text = sharePlan.text;
    if (mode === 'text') return { part: null, finalMode: 'text', fallbackReason: null, stickerId: null };
    if (mode === 'text_sticker') {
      const selection = this.deps.stickers.select({
        hint: candidate.mood,
        text: `${candidate.activity}\n${text}`,
        requireMatch: false
      });
      if (!selection) return { part: null, finalMode: 'text', fallbackReason: 'text_sticker_failed', stickerId: null };
      return {
        part: {
          type: 'sticker',
          mediaId: selection.sticker.mediaId,
          status: 'sent',
          meta: { stickerId: selection.sticker.id, stickerName: selection.sticker.name, proactive: true }
        },
        finalMode: 'text_sticker',
        fallbackReason: null,
        stickerId: selection.sticker.id
      };
    }
    if (mode === 'voice') {
      if (!this.deps.capabilities.has('tts')) return { part: null, finalMode: 'text', fallbackReason: 'voice_unavailable', stickerId: null };
      // D5: proactive voice runs the full voice pipeline (script → guard →
      // delivery → TTS) through VoiceService — never a raw synthesize() call.
      if (!this.deps.voice) return { part: null, finalMode: 'text', fallbackReason: 'voice_unavailable', stickerId: null };
      try {
        const result = await this.deps.voice.synthesizeProactive(text, { candidateId: candidate.id, activity: candidate.activity }, signal);
        if (!result.ok || !result.mediaId) {
          return { part: null, finalMode: 'text', fallbackReason: result.fallbackReason ?? 'voice_failed', stickerId: null };
        }
        return {
          part: {
            type: 'audio',
            mediaId: result.mediaId,
            status: 'sent',
            transcript: result.transcript,
            meta: { proactive: true, candidateId: candidate.id, voiceGenerationId: result.generationId ?? undefined }
          },
          finalMode: 'voice',
          fallbackReason: null,
          stickerId: null
        };
      } catch {
        return { part: null, finalMode: 'text', fallbackReason: 'voice_failed', stickerId: null };
      }
    }
    if (!this.deps.capabilities.has('image')) return { part: null, finalMode: 'text', fallbackReason: 'image_unavailable', stickerId: null };
    try {
      if (signal.aborted) return { part: null, finalMode: 'text', fallbackReason: 'aborted', stickerId: null };
      const imagePlan = sharePlan.image;
      if (!imagePlan) return { part: null, finalMode: 'text', fallbackReason: 'image_plan_missing', stickerId: null };
      const groundedScene = buildGroundedScene(imagePlan, eventContext);
      const directed = await this.deps.mediaDirector.image({
        scene: groundedScene,
        action: imagePlan.action,
        mood: imagePlan.mood ?? candidate.mood,
        intent: imagePlan.kind === 'selfie'
          ? 'proactive private-chat selfie from the same real lived event'
          : 'proactive first-person smartphone snapshot of what Sooya actually saw during the same real lived event'
      }, { signal });
      const finalImagePrompt = directed.prompt.trim();
      if (!finalImagePrompt) return { part: null, finalMode: 'text', fallbackReason: 'image_director_failed', stickerId: null };
      const referenceImages = imagePlan.kind === 'selfie'
        ? await this.deps.personaReferences.load(finalImagePrompt)
        : [];
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
        filename: 'proactive.png',
        meta: {
          proactive: true,
          candidateId: candidate.id,
          sharePlanVersion: 2,
          photoKind: imagePlan.kind,
          sourceActivity: candidate.activity,
          sourceText: text.slice(0, 200),
          eventLocationId: eventContext.location?.id ?? null,
          directorPrompt: finalImagePrompt.slice(0, 1000),
          ...(imagePlan.kind === 'selfie' && !referenceUsed ? { referenceMissing: true } : {})
        }
      });
      return {
        part: {
          type: 'image',
          mediaId: media.id,
          status: 'sent',
          meta: {
            proactive: true,
            prompt: finalImagePrompt.slice(0, 1000),
            sharePlanVersion: 2,
            photoKind: imagePlan.kind,
            eventLocationId: eventContext.location?.id ?? null,
            referenceUsed
          }
        },
        finalMode: 'image',
        fallbackReason: null,
        stickerId: null,
        detail: { imageDirectorUsed: true, referenceUsed, referenceMissing: imagePlan.kind === 'selfie' && !referenceUsed }
      };
    } catch {
      return { part: null, finalMode: 'text', fallbackReason: 'image_failed', stickerId: null };
    }
  }

  private recentlyDiscussed(candidate: LifeLogRow, messages: ChatMessage[]): boolean {
    const now = this.deps.life.now().getTime();
    const candidateTopics = topicTokens(candidate.activity);
    if (candidateTopics.length === 0) return false;
    return messages.some((message) => {
      const created = Date.parse(message.createdAt);
      if (!Number.isFinite(created) || created > now || now - created > TOPIC_WINDOW_MS) return false;
      if (message.meta?.proactiveCandidateId === candidate.id) return true;
      const messageTopics = new Set(topicTokens(textOf(message)));
      const overlap = candidateTopics.filter((token) => messageTopics.has(token)).length;
      const required = candidateTopics.length <= 2 ? 1 : Math.max(2, Math.ceil(candidateTopics.length * 0.4));
      return overlap >= required;
    });
  }

  private resolveEventContext(candidate: LifeLogRow): ProactiveEventContext {
    let location: LifeLocationRow | undefined;
    try {
      const visit = this.deps.locations.visitOverlapping(candidate.started_at, candidate.ended_at);
      location = visit ? this.deps.locations.get(visit.location_id) : undefined;
    } catch { /* location is optional grounding */ }
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

  private lastUserDate(evaluation: ProactiveEvaluation): Date | null {
    return evaluation.lastUserAt ? new Date(evaluation.lastUserAt) : null;
  }

  private failed(
    candidateId: string,
    requestedMode: ProactiveMode | null,
    reason: string,
    finalMode: ProactiveMode | null = null,
    fallbackReason: string | null = null
  ): ProactiveRunResult {
    return { status: 'failed', blockedReason: reason, candidateId, messageId: null, requestedMode, finalMode, fallbackReason, sendSuccess: false };
  }
}

async function composeProactiveSharePlan(
  provider: ReturnType<CapabilityRegistry['chatProvider']>,
  personaPrompt: string,
  lifeLines: string[],
  eventContext: ProactiveEventContext,
  requestedMode: ProactiveMode,
  signal: AbortSignal
): Promise<ProactiveSharePlan> {
  const request = async (repairReason?: string): Promise<ProactiveSharePlan> => {
    const result = await provider.complete({
      system: [
        personaPrompt.trim(),
        ...lifeLines.map((line) => `【当前状态，仅用于语气连续性】${line}`),
        '你是 SOOYA，在私人聊天里主动分享一件真实经历过的小事。',
        '【要分享的历史事件】',
        JSON.stringify(eventContext),
        `本次请求模式：${requestedMode}。只有 image 模式才规划图片，否则 image 必须为 null。`,
        '【规则】text 必须是一句完整、自然、可以直接发送的聊天消息；不要标题、标签、冒号前缀、系统/Life/模型内容。不要把当前状态改写成历史事件。',
        '如果有图片，必须与 text 是同一件具体小事：pov 是 SOOYA 手机第一视角且不出现本人，selfie 才出现 SOOYA。只选普通现实生活场景，不编造地标、幻想建筑或旅游海报。',
        repairReason ? `上一版未通过检查：${repairReason}。请只重新返回完整 JSON。` : '',
        '只输出 JSON：{"text":"...","image":null 或 {"kind":"pov|selfie","scene":"...","action":"...","mood":"...","framing":"front|side|full-body|environment"}}。'
      ].filter(Boolean).join('\n'),
      messages: [{ role: 'user', content: [{ type: 'text', text: '（没有人说话，你主动开口）' }] }],
      temperature: 0.8,
      maxTokens: 450,
      jsonMode: true,
      signal
    });
    const parsed = ProactiveSharePlanSchema.safeParse(extractJsonObject(result.text));
    if (!parsed.success) throw new Error(`invalid_share_plan: ${parsed.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.message).join('; ')}`);
    return parsed.data;
  };

  const first = await request();
  const firstValidation = validateProactiveText(first.text);
  if (firstValidation.ok) return first;
  const repaired = await request(firstValidation.reason);
  const secondValidation = validateProactiveText(repaired.text);
  if (!secondValidation.ok) throw new Error('invalid_share_text');
  return repaired;
}

function validateProactiveText(text: string): { ok: boolean; reason?: string } {
  const normalized = text.trim().replace(/^["“”「」]|["“”「」]$/gu, '').trim();
  if (Array.from(normalized.replace(/\s/gu, '')).length < 6) return { ok: false, reason: '文本太短或只是残片' };
  if (/^(刚刚|刚才|刚发生的事|刚才发生的事|最近|今天)[：:]?$/u.test(normalized)) return { ok: false, reason: '只是标题或时间残片' };
  if (/(因为|所以|然后|但是|不过|顺道|本来想|正准备|刚准备)$/u.test(normalized)) return { ok: false, reason: '句子以悬空连接词结尾' };
  return { ok: true };
}

function buildGroundedScene(image: NonNullable<ProactiveSharePlan['image']>, context: ProactiveEventContext): string {
  const location = context.location
    ? `${context.location.city ?? ''}${context.location.region ?? ''}的${context.location.name}（${context.location.kind}）`
    : '事件地点未知的普通现实生活环境';
  const weather = context.recentWeatherHint
    ? `附近最近天气参考：${context.recentWeatherHint.condition}${context.recentWeatherHint.temperatureC == null ? '' : `，${context.recentWeatherHint.temperatureC}°C`}，仅作氛围参考，不是历史事实。`
    : '';
  return [
    `真实生活事件：${context.activity}。`,
    `实际地点：${location}。`,
    `这次要拍：${image.scene}。`,
    image.action ? `动作：${image.action}。` : '',
    `照片类型：${image.kind === 'selfie' ? 'SOOYA 在同一事件中的私人聊天自拍' : 'SOOYA 手机第一视角拍摄眼前所见，SOOYA 本人不入镜'}。`,
    weather,
    '必须是现实世界普通生活环境、自然手机照片；禁止幻想建筑、漂浮建筑、旅游海报、概念艺术、动漫世界和不可能的地理关系。'
  ].filter(Boolean).join('\n');
}

/** True for better-sqlite3 UNIQUE constraint violations (P1-4). */
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
