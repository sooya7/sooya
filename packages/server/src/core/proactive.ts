import type { MessageRepo, CreatePartInput } from '../db/repos/message.repo.js';
import type { ProactiveAttemptRepo, ProactiveMode } from '../db/repos/proactive.repo.js';
import type { ReplyBatchRepo } from '../db/repos/reply-batch.repo.js';
import type { LifeLogRow } from '../db/repos/life.repo.js';
import type { MomentRepo, MomentImageKind } from '../db/repos/moment.repo.js';
import type { JobRepo } from '../db/repos/misc.repo.js';
import type { ChannelDeliveryRepo } from '../db/repos/channel-delivery.repo.js';
import { QQ_CHANNEL_NAME } from '../channels/qq/types.js';
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
import type { ToolCallRuntime } from '../agent/tool-runtime.js';
import type { ChatRequest } from '../providers/types.js';
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
      toolRuntime?: ToolCallRuntime;
      /** QQ 单通道：主动消息要成为可投递的 assistant 消息（§12.2）。 */
      jobs?: JobRepo;
      deliveries?: ChannelDeliveryRepo;
      qqDeliveryEnabled?: boolean;
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
    // §12.3：QQ 通道还有待投递（用户回复/上一条主动消息尚未发出）时，不插队。
    if (this.deps.qqDeliveryEnabled && this.deps.deliveries && this.deps.deliveries.hasInFlight(QQ_CHANNEL_NAME)) {
      return { reach: false, reason: 'qq_delivery_in_flight', ...base };
    }
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
            signal,
            this.deps.toolRuntime
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
          let proactiveMessageId: string | null = null;
          if (this.deps.qqDeliveryEnabled && this.deps.jobs) {
            // §12.2：Moments 仍是内部时间线；QQ 启用时再把同一内容发布成可投递的
            // assistant 消息并走 durable qq.deliver outbox。发布失败不影响 Moment
            // 已持久化（best-effort，Admin 仍可观察）。
            const published = this.deps.coordinator.publishProactiveMessage({
              parts: this.proactiveParts(sharePlan.text, prepared.imageMediaId),
              meta: {
                proactive: true,
                candidateId: candidate.id,
                momentId: persisted.moment.id,
                activity: candidate.activity
              },
              onPersisted: () => undefined
            });
            if (published) {
              proactiveMessageId = published.message.id;
              this.deps.jobs.enqueue('qq.deliver', { messageId: published.message.id });
              this.deps.metrics?.record('qq', 'proactive.sent');
            }
          }
          this.deps.attempts.update(attempt.id, {
            messageId: proactiveMessageId,
            detail: { ...prepared.detail, destination: 'moments', proactiveMessageId }
          });
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

  /** 主动消息内容段：文本（+ 可选图片）。走 coordinator.publishProactiveMessage 落库。 */
  private proactiveParts(text: string, imageMediaId: string | null): CreatePartInput[] {
    const parts: CreatePartInput[] = [{ type: 'text', text, status: 'sent' }];
    if (imageMediaId) parts.push({ type: 'image', mediaId: imageMediaId, status: 'sent' });
    return parts;
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
  signal: AbortSignal,
  toolRuntime?: ToolCallRuntime
): Promise<MomentSharePlan> {
  const imageMode = requestedMode === 'image';
  const request = async (repairReason?: string): Promise<MomentSharePlan> => {
    const request: ChatRequest = {
      system: [
        personaPrompt.trim(),
        ...lifeLines.map((line) => `【当前状态，仅用于语气连续性】${line}`),
        '你是 SOOYA，要把一件真实经历过的小事发到只对用户可见的动态。这里不是私人聊天窗口。',
        '【要发布的历史事件】',
        JSON.stringify(eventContext),
        `本次发布方式：${imageMode ? '图片动态' : '文字动态'}。${imageMode ? '请规划一张与正文同一事件的照片。' : 'image 必须为 null。'}`,
        '【规则】text 是一条自然、完整的动态正文，像随手记录生活，不要标题、标签、冒号前缀、系统/Life/模型内容。',
        '不要用“在吗”“睡了吗”“刚想跟你说”“发给你看看”这种私聊式呼叫，也不要为了发动态虚构新事件。',
        '如果有图片，必须与 text 是同一件具体小事：pov 是 SOOYA 手机第一视角且不出现本人，selfie 才出现 SOOYA。只选普通现实生活场景。',
        repairReason ? `上一版未通过检查：${repairReason}。请只重新返回完整 JSON。` : '',
        '只输出 JSON：{"text":"...","image":null 或 {"kind":"pov|selfie","scene":"...","action":"...","mood":"...","framing":"front|side|full-body|environment"}}。'
      ].filter(Boolean).join('\n'),
      messages: [{ role: 'user', content: [{ type: 'text', text: '为这件真实经历写一条生活动态。' }] }],
      temperature: 0.8,
      maxTokens: 450,
      jsonMode: true,
      signal
    };
    let finalRequest = request;
    if (toolRuntime?.hasAuthorizedTools('proactive')) {
      const prepared = await toolRuntime.prepare(provider, request, { phase: 'proactive', signal });
      finalRequest = prepared;
    }
    const result = await provider.complete(finalRequest);
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
  if (/^(在吗|睡了吗|干嘛呢)[？?。.]?$/u.test(normalized)) return { ok: false, reason: '像私聊呼叫，不像动态正文' };
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
    `这条动态要拍：${image.scene}。`,
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
