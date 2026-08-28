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
import type { ImageContinuityService, PreparedImageContinuity } from './image-continuity.js';
import type { PersonaReferenceLoader } from '../media/persona-references.js';
import type { LifeLocationRepo, LifeLocationRow } from '../db/repos/location.repo.js';
import type { WorldSnapshot } from './world-context.js';
import type { ToolCallRuntime } from '../agent/tool-runtime.js';
import type { ChatRequest } from '../providers/types.js';
import type { CommitmentRepo } from '../db/repos/commitment.repo.js';
import { arbitrate, commitmentCandidates, type ProactiveCandidate } from './proactive-candidates.js';
import { z } from 'zod';
import { extractJsonObject } from '../util/json-extract.js';
import { resolveVisualTime, visualTimeMetadata, type VisualTimeContext } from './visual-time.js';
import type { FlowTraceService } from './flow-trace.js';

export type { ProactiveMode } from '../db/repos/proactive.repo.js';

export interface ProactiveRunOptions {
  /** Test/admin seam; legacy voice/sticker choices are normalized to a text Moment. */
  mode?: ProactiveMode;
}

export interface ProactiveEvaluation {
  reach: boolean;
  reason: string;
  candidate: LifeLogRow | null;
  /** The arbiter's pick across all sources (§17); null when blocked. */
  selected: ProactiveCandidate | null;
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

// Raw model output. 'pov' is accepted only as a legacy value and is normalized
// to a lifestyle plan before anything reaches the image chain.
const RawMomentSharePlanSchema = z.object({
  text: z.string().trim().min(1).max(120),
  image: z.object({
    kind: z.enum(['pov', 'selfie', 'lifestyle']),
    scene: z.string().trim().min(4).max(300),
    action: z.string().trim().max(160).optional(),
    mood: z.string().trim().max(80).optional(),
    framing: z.enum(['front', 'side', 'full-body', 'environment']).optional()
  }).nullable()
});

type RawMomentSharePlan = z.infer<typeof RawMomentSharePlanSchema>;

/** The only image kinds new proactive generation may plan and persist. */
type ActiveMomentImageKind = 'selfie' | 'lifestyle';

type ActiveMomentImagePlan = Omit<NonNullable<RawMomentSharePlan['image']>, 'kind'> & {
  kind: ActiveMomentImageKind;
};

interface MomentSharePlan {
  text: string;
  image: ActiveMomentImagePlan | null;
  /** True when the model returned legacy kind=pov and it was normalized to lifestyle. */
  legacyPovNormalized: boolean;
}

/** Every proactive image kind puts SOOYA herself in frame. */
function isSooyaOnCamera(kind: ActiveMomentImageKind): boolean {
  return kind === 'selfie' || kind === 'lifestyle';
}

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
      imageContinuity?: ImageContinuityService;
      personaReferences: PersonaReferenceLoader;
      locations: LifeLocationRepo;
      worldSnapshot: () => WorldSnapshot;
      toolRuntime?: ToolCallRuntime;
      /** QQ 单通道：主动消息要成为可投递的 assistant 消息（§12.2）。 */
      jobs?: JobRepo;
      deliveries?: ChannelDeliveryRepo;
      qqDeliveryEnabled?: boolean;
      /** Future candidate source (§17); dark until both flags are on. */
      commitments?: CommitmentRepo;
      futureProactiveEnabled?: boolean;
      /** §22-26: learned preference multiplier, applied after hard gates only. */
      feedbackWeight?: (kind: string) => number;
      flowTrace?: FlowTraceService;
    }
  ) {}

  /**
   * Hard gates first, then one arbiter across every candidate source (§17/§19).
   * Life's sleep / silent-hour / daily-cap rules are global gates: no source,
   * learned weight or urgency may buy its way past them.
   */
  evaluate(): ProactiveEvaluation {
    const recent = this.deps.messages.recent(40);
    const lastUser = [...recent].reverse().find((message) => message.role === 'user');
    const lastAssistant = [...recent].reverse().find((message) => message.role === 'assistant');

    const decision = this.deps.life.shouldReachOut(null, null);
    const base = {
      lastUserAt: lastUser?.createdAt ?? null,
      lastAssistantAt: lastAssistant?.createdAt ?? null
    };
    const blockedEval = (reason: string): ProactiveEvaluation => ({
      reach: false, reason, candidate: decision.candidate, selected: null, ...base
    });
    // Gate-only verdicts from Life apply to every source. A non-gate verdict
    // (nothing worth sharing) just means Life contributes no candidate — the
    // Future source may still have one. shouldReachOut(null, null) never
    // returns the chat-gap reasons, which Moments deliberately ignore.
    const LIFE_GATES = new Set(['disabled', 'daily_cap', 'silent_hours', 'asleep']);
    if (!decision.reach && LIFE_GATES.has(decision.reason)) {
      return blockedEval(decision.reason);
    }

    // Same hard gates for every candidate source.
    const latest = this.deps.moments.latest();
    if (latest) {
      const elapsed = this.deps.life.now().getTime() - Date.parse(latest.created_at);
      const gap = this.deps.life.settings.quietGapMinutes * 60_000;
      if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < gap) {
        return blockedEval('moment_gap');
      }
    }
    if (this.deps.replyBatches.openBatch()) return blockedEval('reply_in_progress');
    // §12.3：QQ 通道还有待投递（用户回复/上一条主动消息尚未发出）时，不插队。
    if (this.deps.qqDeliveryEnabled && this.deps.deliveries && this.deps.deliveries.hasInFlight(QQ_CHANNEL_NAME)) {
      return blockedEval('qq_delivery_in_flight');
    }
    if (!this.deps.capabilities.has('chat')) return blockedEval('chat_unavailable');

    // ---- Candidate collection ----
    const candidates: ProactiveCandidate[] = [];
    if (decision.reach && decision.candidate) {
      const lifeCandidate = decision.candidate;
      if (!this.recentlyDiscussed(lifeCandidate, recent) && !this.recentlyShared(lifeCandidate)) {
        candidates.push({
          source: 'life',
          key: `life:${lifeCandidate.id}`,
          reason: 'life_share_candidate',
          urgency: 0.5,
          salience: 0.6,
          lifeCandidate
        });
      } else {
        return blockedEval('recent_topic');
      }
    }
    if (this.deps.commitments && this.deps.futureProactiveEnabled) {
      candidates.push(...commitmentCandidates(this.deps.commitments.upcoming(12), this.deps.life.now()));
    }
    // Preserve Life's own verdict (e.g. nothing_worth_saying) when no source
    // contributed a candidate — the admin panel surfaces this reason as-is.
    if (candidates.length === 0) return blockedEval(decision.candidate ? 'recent_topic' : decision.reason);

    const recentlySentKeys = new Set(
      this.deps.attempts
        .list(50)
        .filter((attempt) => attempt.status === 'sent')
        .map((attempt) => attempt.candidateId)
        .filter((id): id is string => Boolean(id))
    );
    // Learned weights multiply salience AFTER every hard gate (§18/§20);
    // neutral 1.0 until enough samples exist.
    const weighted = this.deps.feedbackWeight
      ? candidates.map((c) => ({
          ...c,
          salience: c.salience * this.deps.feedbackWeight!(c.source === 'commitment' ? 'commitment' : 'life')
        }))
      : candidates;
    const selected = arbitrate(weighted, recentlySentKeys);
    if (!selected) return blockedEval('already_sent');
    return { reach: true, reason: 'ok', candidate: selected.lifeCandidate ?? null, selected, ...base };
  }

  async run(options: ProactiveRunOptions = {}): Promise<ProactiveRunResult> {
    const evaluation = this.evaluate();
    const selected = evaluation.selected;
    const requestedMode = selected ? this.resolveMode(options.mode) : null;
    const attempt = this.deps.attempts.create({
      candidateId: selected?.key ?? null,
      candidateKind: selected?.source === 'commitment' ? selected.commitment!.kind : selected?.lifeCandidate?.kind ?? null,
      candidateActivity: selected?.source === 'commitment' ? selected.commitment!.title : selected?.lifeCandidate?.activity ?? null,
      requestedMode,
      status: 'blocked',
      blockedReason: evaluation.reach ? null : evaluation.reason,
      detail: { evaluatedAt: this.deps.life.now().toISOString(), destination: selected?.source === 'commitment' ? 'qq' : 'moments' }
    });
    const flowTrace = this.deps.flowTrace?.start('proactive', attempt.id, 'proactive.evaluated', {
      reason: evaluation.reason,
      selected: selected?.source ?? null
    });
    const flowTraceId = flowTrace?.traceId;
    this.deps.attempts.update(attempt.id, { detail: flowTraceId ? { flowTraceId } : undefined });

    if (!evaluation.reach || !selected) return this.blocked(evaluation.reason, evaluation.candidate?.id ?? null, requestedMode, flowTraceId);

    // Commitment care is a chat message, not a Moment (§1.7): semantic
    // candidate in, model-worded message out, one durable QQ delivery.
    if (selected.source === 'commitment') return this.runCommitmentCandidate(selected, attempt.id, flowTraceId);

    const candidate = selected.lifeCandidate;
    if (!candidate) return this.blocked('no_candidate', null, requestedMode, flowTraceId);

    let finalMode: ProactiveMode | null = null;
    let fallbackReason: string | null = null;
    let deliveryQueued = false;
    const task: ProactiveDeliveryTask = {
      candidateId: candidate.id,
      requestedMode: requestedMode ?? 'text',
      run: async (signal) => {
        this.deps.flowTrace?.stage(flowTraceId, 'proactive.composition.started', 'running');
        const provider = this.deps.capabilities.chatProvider();
        const persona = this.deps.config.getPersona();
        const lifeLines = this.deps.life.contextLines(evaluation.lastUserAt ? new Date(evaluation.lastUserAt) : null);
        // One world snapshot feeds event grounding, the publication clock and
        // media continuity; repeated reads could disagree mid-run.
        const world = this.deps.worldSnapshot();
        const eventContext = this.resolveEventContext(candidate, world);
        const visualTime = resolveVisualTime({
          now: world.now,
          timeZone: world.timeZone,
          eventAt: eventContext.startedAt
        });

        let sharePlan: MomentSharePlan;
        try {
          sharePlan = await composeMomentSharePlan(
            provider,
            persona.systemPrompt,
            lifeLines,
            eventContext,
            visualTime,
            requestedMode ?? 'text',
            signal,
            this.deps.toolRuntime
          );
          this.deps.flowTrace?.stage(flowTraceId, 'proactive.composition.completed', 'ok');
        } catch (error) {
          if (signal.aborted) return { kind: 'discarded' };
          const reason = error instanceof Error && error.message === 'invalid_share_text' ? 'invalid_share_text' : 'compose_failed';
          this.deps.attempts.update(attempt.id, { status: 'failed', blockedReason: reason, detail: { error: safeError(error) } });
          this.deps.flowTrace?.fail(flowTraceId, 'proactive.composition.failed', reason);
          throw new Error(reason);
        }

        let prepared: PreparedMedia;
        try {
          this.deps.flowTrace?.stage(flowTraceId, 'proactive.media.started', 'running');
          prepared = await this.prepareMedia(requestedMode ?? 'text', sharePlan, eventContext, visualTime, candidate, signal);
          this.deps.flowTrace?.stage(flowTraceId, 'proactive.media.completed', 'ok', { mode: prepared.finalMode, fallback: prepared.fallbackReason });
        } catch (error) {
          if (signal.aborted) return { kind: 'discarded' };
          this.deps.attempts.update(attempt.id, { status: 'failed', blockedReason: 'media_failed', detail: { error: safeError(error) } });
          this.deps.flowTrace?.fail(flowTraceId, 'proactive.media.failed', 'media_failed');
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
                sharePlanVersion: 4,
                photoKind: sharePlan.image?.kind ?? null,
                ...(sharePlan.legacyPovNormalized ? { legacyPovNormalized: true } : {}),
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
          this.deps.flowTrace?.stage(flowTraceId, 'proactive.persisted', 'ok', { momentId: persisted.moment.id });
          let proactiveMessageId: string | null = null;
          if (this.deps.qqDeliveryEnabled && this.deps.jobs) {
            // §12.2：Moments 仍是内部时间线；QQ 启用时再把同一内容发布成可投递的
            // assistant 消息并走 durable qq.deliver outbox。发布失败不影响 Moment
            // 已持久化（best-effort，Admin 仍可观察）。
            const published = this.deps.coordinator.publishProactiveMessage({
              parts: this.proactiveParts(sharePlan.text, prepared.imageMediaId),
              meta: {
                proactive: true,
                ...(flowTraceId ? { flowTraceId } : {}),
                candidateId: candidate.id,
                momentId: persisted.moment.id,
                activity: candidate.activity
              },
              onPersisted: () => undefined
            });
            if (published) {
              proactiveMessageId = published.message.id;
              deliveryQueued = true;
              this.deps.jobs.enqueue('qq.deliver', { messageId: published.message.id, ...(flowTraceId ? { flowTraceId } : {}) });
              this.deps.flowTrace?.stage(flowTraceId, 'qq.delivery.queued', 'running', { messageId: published.message.id });
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
            this.deps.flowTrace?.block(flowTraceId, 'proactive.duplicate', 'candidate_already_sent');
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
          this.deps.flowTrace?.fail(flowTraceId, 'proactive.persist_failed', reason);
          throw new Error(reason);
        }
      }
    };

    const result = await this.deps.coordinator.enqueueProactive(task);
    if (result.status === 'sent') {
      if (!deliveryQueued) this.deps.flowTrace?.finish(flowTraceId, 'ok', { destination: 'moments' });
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
    if (result.status === 'cancelled') this.deps.flowTrace?.cancel(flowTraceId, 'proactive.cancelled', blockedReason);
    else if (result.status === 'failed') this.deps.flowTrace?.fail(flowTraceId, 'proactive.failed', blockedReason);
    else this.deps.flowTrace?.block(flowTraceId, 'proactive.blocked', blockedReason);
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

  private blocked(reason: string, candidateId: string | null, requestedMode: ProactiveMode | null, flowTraceId?: string): ProactiveRunResult {
    this.deps.flowTrace?.block(flowTraceId, 'proactive.blocked', reason);
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

  /**
   * §1.7: the commitment hands the model a semantic candidate (event,
   * distance), never a canned "提醒：你今天面试" line. The wording stays hers.
   */
  private async runCommitmentCandidate(candidate: ProactiveCandidate, attemptId: string, flowTraceId?: string): Promise<ProactiveRunResult> {
    const info = candidate.commitment!;
    try {
      const provider = this.deps.capabilities.chatProvider();
      this.deps.flowTrace?.stage(flowTraceId, 'proactive.composition.started', 'running');
      const persona = this.deps.config.getPersona();
      const result = await provider.complete({
        system: [
          persona.systemPrompt.trim(),
          '你想在合适的时机自然地提起用户接下来的一件事，就像恋人随口关心一句。',
          JSON.stringify({ event: info.title, kind: info.kind, distance_minutes: info.distanceMinutes }),
          '写一条 40 字以内的消息：自然、带一点你自己的语气，可以顺带加油或好奇。',
          '禁止使用“提醒：”“备忘：”这类系统式开头；禁止暴露 JSON 或字段名；只输出这句话本身。'
        ].join('\n'),
        messages: [{ role: 'user', content: [{ type: 'text', text: '（无人说话，你主动开口）' }] }],
        temperature: 0.85,
        maxTokens: 120
      });
      const text = result.text.trim().replace(/^["“']|["”']$/g, '').slice(0, 120);
      if (text.length < 4) throw new Error('invalid_commitment_text');
      this.deps.flowTrace?.stage(flowTraceId, 'proactive.composition.completed', 'ok');

      if (!this.deps.qqDeliveryEnabled) {
        // No QQ channel (unit-test posture): record the attempt as composed.
        this.deps.attempts.update(attemptId, { status: 'sent', blockedReason: null, sendSuccess: true, detail: { destination: 'qq', text } });
        this.deps.flowTrace?.finish(flowTraceId, 'ok', { destination: 'qq_disabled' });
        return { status: 'sent', blockedReason: null, candidateId: candidate.key, messageId: null, momentId: null, requestedMode: 'text', finalMode: 'text', fallbackReason: null, sendSuccess: true };
      }

      const published = this.deps.coordinator.publishProactiveMessage({
        parts: [{ type: 'text', text, status: 'sent' }],
        meta: { proactive: true, ...(flowTraceId ? { flowTraceId } : {}), candidateId: candidate.key, commitmentId: info.id, reason: candidate.reason },
        onPersisted: () => undefined
      });
      if (!published) throw new Error('commitment_publish_failed');
      this.deps.jobs?.enqueue('qq.deliver', { messageId: published.message.id, ...(flowTraceId ? { flowTraceId } : {}) });
      this.deps.flowTrace?.stage(flowTraceId, 'qq.delivery.queued', 'running', { messageId: published.message.id });
      this.deps.attempts.update(attemptId, {
        status: 'sent',
        blockedReason: null,
        messageId: published.message.id,
        sendSuccess: true,
        detail: { destination: 'qq', commitmentId: info.id, text }
      });
      this.deps.metrics?.record('future', 'proactive.sent');
      return {
        status: 'sent',
        blockedReason: null,
        candidateId: candidate.key,
        messageId: published.message.id,
        momentId: null,
        requestedMode: 'text',
        finalMode: 'text',
        fallbackReason: null,
        sendSuccess: true
      };
    } catch (error) {
      const reason = safeError(error);
      this.deps.attempts.update(attemptId, { status: 'failed', blockedReason: reason, detail: { error: reason } });
      this.deps.flowTrace?.fail(flowTraceId, 'proactive.failed', reason);
      return {
        status: 'failed',
        blockedReason: reason,
        candidateId: candidate.key,
        messageId: null,
        momentId: null,
        requestedMode: 'text',
        finalMode: null,
        fallbackReason: null,
        sendSuccess: false
      };
    }
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
    visualTime: VisualTimeContext,
    candidate: LifeLogRow,
    signal: AbortSignal
  ): Promise<PreparedMedia> {
    if (mode !== 'image') return { imageMediaId: null, imageKind: null, finalMode: 'text', fallbackReason: null };
    if (!this.deps.capabilities.has('image')) return { imageMediaId: null, imageKind: null, finalMode: 'text', fallbackReason: 'image_unavailable' };
    if (signal.aborted) return { imageMediaId: null, imageKind: null, finalMode: 'text', fallbackReason: 'aborted' };
    const imagePlan = sharePlan.image;
    if (!imagePlan) return { imageMediaId: null, imageKind: null, finalMode: 'text', fallbackReason: 'image_plan_missing' };

    // Every proactive image kind is on-camera, so both share the persona
    // reference chain and the same daily visual continuity state.
    const onCamera = isSooyaOnCamera(imagePlan.kind);
    const continuityService = onCamera ? this.deps.imageContinuity : undefined;
    const generate = async (): Promise<PreparedMedia> => {
      if (signal.aborted) return { imageMediaId: null, imageKind: null, finalMode: 'text', fallbackReason: 'aborted' };
      const groundedScene = buildGroundedScene(imagePlan, eventContext);
      let continuity: PreparedImageContinuity | null = null;
      if (continuityService) {
        continuity = continuityService.prepare({
          scene: groundedScene,
          activity: eventContext.activity,
          activityKind: eventContext.kind,
          activityStartedAt: eventContext.startedAt,
          location: eventContext.location?.name ?? null,
          visualTime
        });
      }

      const directed = await this.deps.mediaDirector.image({
        scene: groundedScene,
        action: imagePlan.action,
        mood: imagePlan.mood ?? candidate.mood,
        intent: imagePlan.kind === 'selfie'
          ? 'casual Moments-feed selfie from the same real lived event'
          : 'candid daily-life photo of SOOYA visibly present and naturally performing the same real lived event'
      }, {
        signal,
        ...(continuity
          ? {
              continuity: {
                dateKey: continuity.dateKey,
                // Retrospective depictions must not borrow current Life facts
                // as if they were happening now; the event scene stands alone.
                currentActivity: continuity.visualTime.mode === 'current' ? continuity.currentActivity : null,
                currentLocation: continuity.visualTime.mode === 'current' ? continuity.currentLocation : null,
                previousOutfit: continuity.previousOutfit,
                outfitMode: continuity.outfitMode,
                changeReason: continuity.changeReason,
                explicitOutfitRequest: continuity.explicitOutfitRequest,
                visualTime: continuity.visualTime
              }
            }
          : {})
      });
      const directedPrompt = directed.prompt.trim();
      if (!directedPrompt) return { imageMediaId: null, imageKind: null, finalMode: 'text', fallbackReason: 'image_director_failed' };

      let finalImagePrompt = applyMomentCompositionConstraints(directedPrompt, imagePlan);
      let resolvedOutfit: string | null = null;
      let continuityMeta: Record<string, unknown> | null = null;
      if (continuity && continuityService) {
        resolvedOutfit = continuityService.resolveOutfit(directed.outfit, continuity);
        // Must remain the final prompt layer so no later director/framing pass
        // can weaken the authoritative activity, location, or outfit.
        finalImagePrompt = continuityService.applyToPrompt(finalImagePrompt, continuity, resolvedOutfit);
        const timeFacts = visualTimeMetadata(continuity.visualTime);
        continuityMeta = continuity.visualTime.mode === 'retrospective'
          ? {
              dateKey: continuity.dateKey,
              outfit: resolvedOutfit,
              outfitMode: continuity.outfitMode,
              changeReason: continuity.changeReason,
              ...timeFacts,
              // The commit below never touches same-day state for a
              // retrospective image; record that so the metadata explains the
              // absent outfit revision.
              commitState: 'skipped',
              commitReason: continuity.changeReason
            }
          : {
              dateKey: continuity.dateKey,
              outfit: resolvedOutfit,
              outfitMode: continuity.outfitMode,
              outfitRevision: continuity.outfitRevision,
              changeReason: continuity.changeReason,
              activity: continuity.currentActivity,
              activityKind: continuity.currentActivityKind,
              location: continuity.currentLocation,
              ...timeFacts
            };
      }

      const referenceImages = onCamera ? await this.deps.personaReferences.load(finalImagePrompt) : [];
      const referenceUsed = referenceImages.length > 0;
      if (onCamera && !referenceUsed) {
        // An on-camera Moment generated without her identity reference risks
        // "a person, but not her". Degrade to text rather than generate — and
        // never drift back toward a scenery photo to dodge the missing face.
        return { imageMediaId: null, imageKind: null, finalMode: 'text', fallbackReason: 'reference_missing' };
      }
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
          sharePlanVersion: 4,
          photoKind: imagePlan.kind,
          sourceActivity: candidate.activity,
          sourceText: sharePlan.text.slice(0, 200),
          eventLocationId: eventContext.location?.id ?? null,
          directorPrompt: finalImagePrompt.slice(0, 1000),
          ...(continuityMeta ? { continuity: continuityMeta } : {})
        }
      });

      if (continuity && resolvedOutfit && continuityService) {
        const committed = continuityService.commit(continuity, {
          outfit: resolvedOutfit,
          scene: groundedScene,
          mediaId: media.id
        });
        if (committed) {
          continuityMeta = {
            ...continuityMeta,
            outfit: committed.outfit.fullDescription,
            outfitRevision: committed.outfitRevision
          };
        }
      }

      return {
        imageMediaId: media.id,
        imageKind: imagePlan.kind,
        finalMode: 'image',
        fallbackReason: null,
        detail: {
          imageDirectorUsed: true,
          referenceUsed,
          ...(sharePlan.legacyPovNormalized ? { legacyPovNormalized: true } : {}),
          ...(continuityMeta ? { continuity: continuityMeta } : {})
        }
      };
    };

    try {
      return continuityService
        ? await continuityService.runExclusive(generate)
        : await generate();
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

  private resolveEventContext(candidate: LifeLogRow, world: WorldSnapshot): ProactiveEventContext {
    let location: LifeLocationRow | undefined;
    try {
      const visit = this.deps.locations.visitOverlapping(candidate.started_at, candidate.ended_at);
      location = visit ? this.deps.locations.get(visit.location_id) : undefined;
    } catch { /* optional grounding */ }
    const snapshot = world;
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
  visualTime: VisualTimeContext,
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
        visualTime.mode === 'retrospective'
          ? `【发布时间与事件时间】真实当前时间是 ${visualTime.currentLocalDate} ${visualTime.currentLocalTime}，当前发布时段是 ${visualTime.currentDayPeriod}；事件画面时间是 ${visualTime.depictedLocalDate}，事件画面时段是 ${visualTime.depictedDayPeriod}。正文和图片都必须表现为已经发生的事件，不得写成正在当前发生。`
          : `【发布时间与事件时间】真实当前时间是 ${visualTime.currentLocalDate} ${visualTime.currentLocalTime}，当前发布时段是 ${visualTime.currentDayPeriod}；事件画面与当前时段一致。`,
        `本次发布方式：${imageMode ? '图片动态' : '文字动态'}。${imageMode ? '请规划一张与正文同一事件的照片。' : 'image 必须为 null。'}`,
        '【规则】text 是一条自然、完整的动态正文，像随手记录生活，不要标题、标签、冒号前缀、系统/Life/模型内容。',
        '不要用“在吗”“睡了吗”“刚想跟你说”“发给你看看”这种私聊式呼叫，也不要为了发动态虚构新事件。',
        '如果有图片，必须与 text 是同一件具体小事，只能选择 lifestyle 或 selfie。',
        'lifestyle：SOOYA 本人清晰出现在画面中，自然进行这件真实生活事件对应的动作（吃饭、喝东西、看书、走路、摸猫等）。默认优先 lifestyle。不要把食物、风景、桌面或物件单独拍成主体；如果事件涉及吃东西，就拍 SOOYA 正在吃；如果事件涉及某个地点，就拍 SOOYA 在该地点进行当前活动。',
        'selfie：只有当这件事自然适合直接面对镜头分享自己时才选择。允许自然半身、侧脸、镜前或带环境的自拍。',
        '禁止第一视角 POV、纯风景、纯食物、纯桌面、纯物件和摄影者完全不出现的场景图。只选普通现实生活场景。',
        repairReason ? `上一版未通过检查：${repairReason}。请只重新返回完整 JSON。` : '',
        '只输出 JSON：{"text":"...","image":null 或 {"kind":"selfie|lifestyle","scene":"...","action":"...","mood":"...","framing":"front|side|full-body|environment"}}。'
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
    const parsed = RawMomentSharePlanSchema.safeParse(extractJsonObject(result.text));
    if (!parsed.success) throw new Error(`invalid_share_plan: ${parsed.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.message).join('; ')}`);
    return imageMode
      ? normalizeActiveImagePlan(parsed.data, eventContext)
      : { ...parsed.data, image: null, legacyPovNormalized: false };
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

/**
 * Legacy kind=pov must never reach the image provider. The model sometimes
 * still returns it out of old prompt habits, so rewrite it into the equivalent
 * lifestyle plan: SOOYA herself performing the event's real activity in the
 * same scene.
 */
function normalizeActiveImagePlan(raw: RawMomentSharePlan, context: ProactiveEventContext): MomentSharePlan {
  if (!raw.image) return { text: raw.text, image: null, legacyPovNormalized: false };
  const { kind, ...image } = raw.image;
  if (kind !== 'pov') return { text: raw.text, image: { ...image, kind }, legacyPovNormalized: false };
  return {
    text: raw.text,
    legacyPovNormalized: true,
    image: {
      ...image,
      kind: 'lifestyle',
      action: image.action?.trim() || context.activity,
      scene: `${image.scene}；SOOYA 本人在同一场景中自然进行“${context.activity}”`
    }
  };
}

function buildGroundedScene(image: ActiveMomentImagePlan, context: ProactiveEventContext): string {
  const location = context.location
    ? `${context.location.city ?? ''}${context.location.region ?? ''}的${context.location.name}（${context.location.kind}）`
    : '事件地点未知的普通现实生活环境';
  const weather = context.recentWeatherHint
    ? `附近最近天气参考：${context.recentWeatherHint.condition}${context.recentWeatherHint.temperatureC == null ? '' : `，${context.recentWeatherHint.temperatureC}°C`}，仅作氛围参考，不是历史事实。`
    : '';
  const photoType = image.kind === 'selfie'
    ? 'SOOYA 在同一真实事件中的自然生活自拍，SOOYA 本人入镜'
    : 'SOOYA 本人在同一真实生活场景中自然进行当前活动的生活照片，SOOYA 本人必须入镜，场景和物件作为生活环境';
  return [
    `真实生活事件：${context.activity}。`,
    `实际地点：${location}。`,
    `这条动态要拍：${image.scene}。`,
    image.action ? `动作：${image.action}。` : '',
    `照片类型：${photoType}。`,
    weather,
    '禁止第一视角 POV；禁止只拍风景、食物、桌面或物件而没有 SOOYA。',
    '必须是现实世界普通生活环境、自然手机照片；禁止幻想建筑、漂浮建筑、旅游海报、概念艺术、动漫世界和不可能的地理关系。'
  ].filter(Boolean).join('\n');
}

function applyMomentCompositionConstraints(prompt: string, image: ActiveMomentImagePlan): string {
  if (image.kind === 'selfie') {
    return [
      prompt,
      'SOOYA must be visibly present as the same person from the provided identity reference.',
      'Keep the image casual and naturally self-shot, not studio portraiture.'
    ].join('\n');
  }
  return [
    prompt,
    'LIFESTYLE COMPOSITION — HARD CONSTRAINTS:',
    'SOOYA herself must be visibly present in the frame.',
    'Show SOOYA naturally performing the real current activity described above.',
    'The environment, food, scenery, or objects are supporting context, not a replacement for SOOYA.',
    'Do not use first-person POV.',
    'Do not produce a scenery-only, food-only, tabletop-only, or object-only image.',
    'Use candid daily-life body language; do not turn the moment into a fashion pose, studio portrait, tourism poster, or commercial shoot.'
  ].join('\n');
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
