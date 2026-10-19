import type { MessageRepo } from '../db/repos/message.repo.js';
import type { ProactiveAttemptRepo, ProactiveMode } from '../db/repos/proactive.repo.js';
import type { ReplyBatchRepo } from '../db/repos/reply-batch.repo.js';
import type { LifeLogRow } from '../db/repos/life.repo.js';
import type { MomentRepo } from '../db/repos/moment.repo.js';
import type { JobRepo, SummaryRepo } from '../db/repos/misc.repo.js';
import type { ChannelDeliveryRepo } from '../db/repos/channel-delivery.repo.js';
import { QQ_CHANNEL_NAME } from '../channels/qq/types.js';
import type { CapabilityRegistry } from './capabilities.js';
import type { ConfigStore } from '../config/store.js';
import type { LifeRuntime } from './life.js';
import type { MediaStore } from '../media/store.js';
import type { EventBus } from '../events/bus.js';
import type { ChatMessage } from './types.js';
import type { ReplyCoordinator, ProactiveDeliveryTask } from './reply-coordinator.js';
import type { LifeLocationRepo, LifeLocationRow } from '../db/repos/location.repo.js';
import type { WorldSnapshot } from './world-context.js';
import type { ToolCallRuntime } from '../agent/tool-runtime.js';
import type { ChatRequest } from '../providers/types.js';
import type { CommitmentRepo } from '../db/repos/commitment.repo.js';
import { arbitrate, commitmentCandidates, type ProactiveCandidate } from './proactive-candidates.js';
import { z } from 'zod';
import { extractJsonObject } from '../util/json-extract.js';
import { resolveVisualTime, type VisualTimeContext } from './visual-time.js';
import type { FlowTraceService } from './flow-trace.js';
import type { FutureContextService } from './future/context.js';
import type { RelationshipContextService } from './relationship/service.js';

export type { ProactiveMode } from '../db/repos/proactive.repo.js';

export interface ProactiveRunOptions {
  /** Legacy seam: every proactive message is text now, so the mode is ignored. */
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
  /** Her proactive messages since the user last spoke. */
  unansweredProactive: number;
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

// Raw model output. A proactive message is text: every picture it used to
// carry put her in frame, and she does not send pictures of herself. Older
// prompt habits may still add an "image" field; it is dropped by the parse.
const RawMomentSharePlanSchema = z.object({
  text: z.string().trim().min(1).max(120)
});

type MomentSharePlan = z.infer<typeof RawMomentSharePlanSchema>;

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
/** After this many unanswered proactive messages she waits for the user. */
const MAX_UNANSWERED_PROACTIVE = 2;
/** How much of the chat she rereads before speaking first. */
const RELATION_RECENT_MESSAGES = 30;
const RELATION_LINE_CHARS = 150;
const RELATION_SUMMARIES = 4;
const RELATION_SUMMARY_CHARS = 400;
const RELATION_MEMORY_CHARS = 1500;
/** Memory is an enhancement: a slow recall must not hold up the message. */
const RELATION_MEMORY_TIMEOUT_MS = 8_000;

/**
 * What she knows about the user when she decides to speak first — the same
 * sources a normal reply sees: recent chat, stage summaries, long-term memory,
 * ongoing threads and upcoming plans.
 */
interface RelationContext {
  conversation: string[];
  hoursSinceUser: number | null;
  unanswered: number;
  recentProactive: string[];
  summaries: string[];
  memory: string | null;
  threads: string[];
  upcoming: string[];
}

/**
 * Historical name kept for compatibility. Every proactive message is a private
 * one-to-one message to the user — there is no audience besides them. A Life
 * event is only a possible reason to speak; the Moment row is her internal
 * record of it, and with QQ enabled the same text is delivered as a chat
 * message.
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
      /** Background she carries into a proactive message; each source is optional. */
      summaries?: SummaryRepo;
      relationship?: RelationshipContextService;
      future?: FutureContextService;
      /** Long-term memory about the user (Ombre or legacy), already rendered as text. */
      recallMemory?: (query: string, signal: AbortSignal) => Promise<string | null>;
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
    const unanswered = unansweredProactiveCount(recent);
    const base = {
      lastUserAt: lastUser?.createdAt ?? null,
      lastAssistantAt: lastAssistant?.createdAt ?? null,
      unansweredProactive: unanswered
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
    // A person's rhythm, not a grid: the gap stretches by a stable per-message
    // jitter, and doubles while her last message is still unanswered.
    const latest = this.deps.moments.latest();
    if (latest) {
      const elapsed = this.deps.life.now().getTime() - Date.parse(latest.created_at);
      const gap = this.deps.life.settings.quietGapMinutes * 60_000
        * gapJitter(latest.id)
        * (unanswered > 0 ? 2 : 1);
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
    // Ignored twice: she stops sharing her day and waits until the user is
    // back. Commitments the user cares about may still come through.
    const awaitingReply = unanswered >= MAX_UNANSWERED_PROACTIVE;
    if (decision.reach && decision.candidate && !awaitingReply) {
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
    if (candidates.length === 0) {
      return blockedEval(awaitingReply ? 'awaiting_reply' : decision.candidate ? 'recent_topic' : decision.reason);
    }

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

  async run(_options: ProactiveRunOptions = {}): Promise<ProactiveRunResult> {
    const evaluation = this.evaluate();
    const selected = evaluation.selected;
    const requestedMode: ProactiveMode | null = selected ? 'text' : null;
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
    if (selected.source === 'commitment') return this.runCommitmentCandidate(selected, attempt.id, evaluation, flowTraceId);

    const candidate = selected.lifeCandidate;
    if (!candidate) return this.blocked('no_candidate', null, requestedMode, flowTraceId);

    let finalMode: ProactiveMode | null = null;
    const fallbackReason: string | null = null;
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
            signal,
            await this.relationContext(evaluation, world, signal),
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

        finalMode = 'text';
        if (signal.aborted) return { kind: 'discarded' };

        try {
          const persisted = this.deps.moments.inTransaction(() => {
            const moment = this.deps.moments.create({
              candidateId: candidate.id,
              text: sharePlan.text,
              imageMediaId: null,
              imageKind: null,
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
              finalMode: 'text',
              fallbackReason: null,
              messageId: null,
              momentId: moment.id,
              sendSuccess: true,
              detail: {
                destination: 'moments',
                sharePlanVersion: 5,
                eventLocationId: eventContext.location?.id ?? null
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
              parts: [{ type: 'text', text: sharePlan.text, status: 'sent' }],
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
            detail: { destination: 'moments', proactiveMessageId }
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
            finalMode: 'text',
            fallbackReason: null,
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
  private async runCommitmentCandidate(candidate: ProactiveCandidate, attemptId: string, evaluation: ProactiveEvaluation, flowTraceId?: string): Promise<ProactiveRunResult> {
    const info = candidate.commitment!;
    try {
      const provider = this.deps.capabilities.chatProvider();
      this.deps.flowTrace?.stage(flowTraceId, 'proactive.composition.started', 'running');
      const persona = this.deps.config.getPersona();
      const world = this.deps.worldSnapshot();
      const relation = await this.relationContext(evaluation, world, new AbortController().signal);
      const result = await provider.complete({
        system: [
          persona.systemPrompt.trim(),
          ...relationBackgroundLines({ ...relation, upcoming: [] }),
          '【你们最近的聊天，从旧到新】',
          relation.conversation.length ? relation.conversation.join('\n') : '（最近没有聊天记录）',
          relationStatusLine(relation),
          '你想在合适的时机自然地提起用户接下来的一件事，就像身边熟悉的人随口关心一句。',
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

  private async relationContext(evaluation: ProactiveEvaluation, world: WorldSnapshot, signal: AbortSignal): Promise<RelationContext> {
    const lastUserMs = evaluation.lastUserAt ? Date.parse(evaluation.lastUserAt) : NaN;
    const nowMs = Date.parse(world.now);
    const recent = this.deps.messages.recent(RELATION_RECENT_MESSAGES);
    return {
      conversation: recent.map((message) => conversationLine(message, world.timeZone)).filter(Boolean),
      hoursSinceUser: Number.isFinite(lastUserMs) && Number.isFinite(nowMs) ? Math.max(0, (nowMs - lastUserMs) / 3_600_000) : null,
      unanswered: evaluation.unansweredProactive,
      recentProactive: this.deps.moments.list(6).map((moment) => moment.text.replace(/\s+/gu, ' ').slice(0, 80)),
      summaries: optionalLines(() => (this.deps.summaries?.active(RELATION_SUMMARIES) ?? [])
        .slice()
        .sort((a, b) => a.from_seq - b.from_seq)
        .map((summary) => summary.content.trim().slice(0, RELATION_SUMMARY_CHARS))),
      memory: await this.recallMemory(recent, signal),
      threads: optionalLines(() => this.deps.relationship?.contextLines() ?? []),
      upcoming: optionalLines(() => this.deps.future?.contextLines() ?? [])
    };
  }

  private async recallMemory(recent: ChatMessage[], signal: AbortSignal): Promise<string | null> {
    if (!this.deps.recallMemory) return null;
    const query = recent.map(textOf).filter(Boolean).join('\n').slice(-500);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), RELATION_MEMORY_TIMEOUT_MS); });
      const text = await Promise.race([this.deps.recallMemory(query, signal), timeout]);
      return text?.trim() ? text.trim().slice(0, RELATION_MEMORY_CHARS) : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
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
  signal: AbortSignal,
  relation: RelationContext,
  toolRuntime?: ToolCallRuntime
): Promise<MomentSharePlan> {
  const request = async (repairReason?: string): Promise<MomentSharePlan> => {
    const request: ChatRequest = {
      system: [
        personaPrompt.trim(),
        ...lifeLines.map((line) => `【当前状态，仅用于语气连续性】${line}`),
        '你现在想主动给对方发一条私聊消息。你们是一对一的关系，这条消息只发给对方一个人，没有别的读者，你也没有朋友圈或动态要发。',
        ...relationBackgroundLines(relation),
        '【你们最近的聊天，从旧到新】',
        relation.conversation.length ? relation.conversation.join('\n') : '（最近没有聊天记录）',
        relationStatusLine(relation),
        '【你最近经历的一件小事——可以当作开口的由头，也可以完全不提】',
        JSON.stringify(eventContext),
        visualTime.mode === 'retrospective'
          ? `【时间】现在是 ${visualTime.currentLocalDate} ${visualTime.currentLocalTime}（${visualTime.currentDayPeriod}）；那件小事发生在 ${visualTime.depictedLocalDate} ${visualTime.depictedDayPeriod}，提起时要当成已经过去的事，不要说成正在发生。`
          : `【时间】现在是 ${visualTime.currentLocalDate} ${visualTime.currentLocalTime}（${visualTime.currentDayPeriod}），那件小事就发生在这个时段。`,
        relation.recentProactive.length
          ? `【你最近主动发过的消息，不要重复其中的内容、说法和意象】\n${relation.recentProactive.map((text) => `- ${text}`).join('\n')}`
          : '',
        '【规则】',
        '先想清楚此刻为什么想找对方：想对方了、接着上次没聊完的话、惦记对方说过的事或接下来的安排，或者想把这件小事讲给对方听。挑最自然的那一个，不必每次都讲自己的日常。',
        '摘要和记忆是你心里记着的事，可以自然地惦记起来，但不要一次翻出好几件，不要像在复述档案，也不要只盯着最近一条消息。',
        '对方好久没来，就先在意对方本身；你上一条对方还没回，就别再自顾自分享，轻轻问一句或撒个娇就好。',
        'text 就是你要发出去的那句话：短、口语、直接对着对方说，通常一两句、不超过 50 字，可以用换行分成两小句。',
        '禁止日记体和旁白式开头（如“昨天下午……”“折腾了一晚上……”），禁止写成朋友圈文案；不要标题、标签、冒号前缀、系统/Life/模型内容；不要编造没发生过的事。',
        repairReason ? `上一版未通过检查：${repairReason}。请只重新返回完整 JSON。` : '',
        '只输出 JSON：{"text":"..."}。'
      ].filter(Boolean).join('\n'),
      messages: [{ role: 'user', content: [{ type: 'text', text: '（对方没有说话，你主动开口）' }] }],
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
    return parsed.data;
  };

  let first: MomentSharePlan;
  try {
    first = await request();
  } catch (error) {
    // A reply that is not the JSON shape (null, prose, missing fields) is the
    // most common non-network failure; one repair turn usually fixes it.
    if (!(error instanceof Error && error.message.startsWith('invalid_share_plan'))) throw error;
    first = await request('没有返回合法的 JSON，或缺少 text 字段');
  }
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
  if (/^(在吗|睡了吗|干嘛呢)[？?。.]?$/u.test(normalized)) return { ok: false, reason: '只有一句空洞的呼叫，没有想说的内容' };
  if (/(因为|所以|然后|但是|不过|顺道|本来想|正准备|刚准备)$/u.test(normalized)) return { ok: false, reason: '句子以悬空连接词结尾' };
  return { ok: true };
}

function isUniqueConstraint(error: unknown): boolean {
  const code = (error as { code?: string }).code ?? '';
  return typeof code === 'string' && code.includes('SQLITE_CONSTRAINT');
}

function relationStatusLine(relation: RelationContext): string {
  const since = relation.hoursSinceUser === null
    ? '对方还没跟你说过话。'
    : relation.hoursSinceUser < 1
      ? '对方不到一小时前刚说过话。'
      : relation.hoursSinceUser < 48
        ? `对方上一次说话是约 ${Math.round(relation.hoursSinceUser)} 小时前。`
        : `对方已经 ${Math.floor(relation.hoursSinceUser / 24)} 天没说话了。`;
  const waiting = relation.unanswered > 0 ? '你上一条主动发的消息对方还没回。' : '';
  return `【对方的状态】${since}${waiting}`;
}

/** Her proactive messages after the user's latest message (recent is oldest-first). */
function unansweredProactiveCount(recent: ChatMessage[]): number {
  let count = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const message = recent[i]!;
    if (message.role === 'user') break;
    if (message.role === 'assistant' && message.meta?.proactive === true) count++;
  }
  return count;
}

/** Stable 1.0–1.6 multiplier so consecutive gaps are not the same length. */
function gapJitter(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 1 + (hash % 600) / 1000;
}

function conversationLine(message: ChatMessage, timeZone: string): string {
  const body = message.content
    .map((part) => part.type === 'text' ? part.text ?? ''
      : part.type === 'audio' ? part.transcript ?? '[语音]'
      : part.type === 'image' ? '[图片]'
      : part.type === 'sticker' ? '[表情]'
      : '')
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!body || message.role === 'system') return '';
  let at = '';
  try {
    at = new Intl.DateTimeFormat('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .format(new Date(message.createdAt));
  } catch { /* unknown zone: omit the timestamp */ }
  return `${at ? `${at} ` : ''}${message.role === 'user' ? '对方' : '你'}：${body.slice(0, RELATION_LINE_CHARS)}`;
}

/** Optional context source: a failure means the block is simply left out. */
function optionalLines(read: () => string[]): string[] {
  try {
    return read().map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Long-term background shared by every proactive prompt; empty blocks are dropped. */
function relationBackgroundLines(relation: RelationContext): string[] {
  return [
    relation.summaries.length ? `【你们以前聊过的重点（阶段摘要，从旧到新）】\n${relation.summaries.map((line) => `- ${line.replace(/^[-·]\s*/u, '')}`).join('\n')}` : '',
    relation.memory ? `【你记得的关于对方、关于你们的事（记忆系统浮现，可能不完整）】\n${relation.memory}` : '',
    relation.threads.length ? `【你们之间正在延续的事情】\n${relation.threads.join('\n')}` : '',
    relation.upcoming.length ? `【对方接下来的安排、你们说好的事】\n${relation.upcoming.join('\n')}` : ''
  ].filter(Boolean);
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
