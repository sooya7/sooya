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

        let text: string;
        try {
          text = await composeProactiveText(provider, persona.systemPrompt, lifeLines, candidate.activity, signal);
        } catch (error) {
          if (signal.aborted) return { kind: 'discarded' };
          const reason = 'compose_failed';
          this.deps.attempts.update(attempt.id, { status: 'failed', blockedReason: reason, detail: { error: safeError(error) } });
          throw new Error(reason);
        }
        if (!text) {
          if (signal.aborted) return { kind: 'discarded' };
          const reason = 'empty_text';
          this.deps.attempts.update(attempt.id, { status: 'failed', blockedReason: reason });
          throw new Error(reason);
        }

        let prepared: PreparedMedia;
        try {
          prepared = await this.prepareMedia(requestedMode ?? 'text', text, candidate, signal);
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

        const parts: CreatePartInput[] = [{ type: 'text', text, status: 'sent' }];
        if (prepared.part) parts.push(prepared.part);
        try {
          // P1-4: the attempt is marked 'sent' in the SAME transaction as the
          // message; the partial unique index on (candidate_id) WHERE
          // status='sent' rejects a concurrent sender, rolling the message
          // back with it.
          const persisted = this.deps.messages.inTransaction(() => {
            const created = this.deps.messages.createInTransaction({
              role: 'assistant',
              status: 'sent',
              parts,
              meta: {
                proactive: true,
                proactiveAttemptId: attempt.id,
                proactiveCandidateId: candidate.id,
                lifeLogId: candidate.id,
                activity: candidate.activity,
                proactiveMode: prepared.finalMode,
                ...(prepared.fallbackReason ? { fallbackReason: prepared.fallbackReason } : {})
              }
            });
            if (!created.created) throw new Error('proactive message unexpectedly duplicated');
            this.deps.attempts.update(attempt.id, {
              status: 'sent',
              blockedReason: null,
              finalMode: prepared.finalMode,
              fallbackReason: prepared.fallbackReason,
              messageId: created.message.id,
              sendSuccess: true,
              detail: { mediaPersisted: Boolean(prepared.part), pushEnqueued: false }
            });
            return {
              message: created.message,
              event: this.deps.bus.persist('message.received', { message: created.message })
            };
          });
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
          this.deps.attempts.update(attempt.id, { detail: { mediaPersisted: Boolean(prepared.part), pushEnqueued } });
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
    this.deps.attempts.update(attempt.id, { status: result.status === 'failed' ? 'failed' : 'blocked', blockedReason: result.blockedReason ?? result.status });
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

  private async prepareMedia(mode: ProactiveMode, text: string, candidate: LifeLogRow, signal: AbortSignal): Promise<PreparedMedia> {
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
      const image = await this.deps.capabilities.imageProvider().generate(candidate.activity, { signal });
      const media = await this.deps.media.save({
        kind: 'image',
        origin: 'generated',
        data: image.data,
        declaredMime: image.mime,
        filename: 'proactive.png',
        meta: { proactive: true, candidateId: candidate.id, prompt: candidate.activity }
      });
      return {
        part: { type: 'image', mediaId: media.id, status: 'sent', meta: { prompt: candidate.activity, proactive: true } },
        finalMode: 'image',
        fallbackReason: null,
        stickerId: null
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

async function composeProactiveText(
  provider: ReturnType<CapabilityRegistry['chatProvider']>,
  personaPrompt: string,
  lifeLines: string[],
  activity: string,
  signal: AbortSignal
): Promise<string> {
  const result = await provider.complete({
    system: [
      personaPrompt.trim(),
      ...lifeLines,
      `你想主动跟用户说说刚刚${activity}的事。`,
      '写一条 40 字以内的自然消息，只说这一件事，不要开场寒暄，不要提系统、能力、设置或模型。',
      '直接输出消息正文，不要引号、前缀或任何媒体指令。'
    ].join('\n'),
    messages: [{ role: 'user', content: [{ type: 'text', text: '（没有人说话，你主动开口）' }] }],
    temperature: 0.9,
    maxTokens: 120,
    signal
  });
  return result.text.trim().replace(/^["“”「」]|["“”「」]$/gu, '').slice(0, 120);
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
