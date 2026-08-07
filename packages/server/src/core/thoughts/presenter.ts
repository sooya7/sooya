/**
 * ThoughtPresenter — generates the visible inner monologue + decision summary
 * for a completed reply.
 *
 * SAFETY BOUNDARY (docs/NEXT-PHASE-CONTRACTS.md §1.6): this is NOT hidden
 * reasoning. Only the whitelisted inputs below may reach the model or the
 * thought text:
 *
 *   user message / final canonical reply / safe Life context /
 *   safe WorldContext / reply intent / voice mode / safe decision metadata
 *
 * Forbidden inputs: system prompt full text, hidden chain-of-thought, internal
 * safety rules, API keys, provider secrets, raw memory retrieval text, raw
 * tool results. The model call uses a FIXED generic instruction — never the
 * persona's real system prompt.
 *
 * A thought is best-effort: a model error, timeout or safety hit drops the
 * thought (status `failed`, no text) and can NEVER block or delay the reply.
 * The publish barrier is the atomic `generating → completed` transition in the
 * database (ThoughtRepo.completeThought) — a thought cancelled by a newer user
 * message can never become visible.
 */

import type { ChatProvider } from '../../providers/types.js';
import type { ThoughtRepo } from '../../db/repos/thought.repo.js';
import type { EventBus } from '../../events/bus.js';
import type { ErrorLogRepo } from '../../db/repos/misc.repo.js';
import type { VisibleThought } from './types.js';
import { ThoughtSafetyFilter, type SafetyRefs } from './safety.js';

export interface ThoughtPrepareInput {
  batchId: string;
  revision: number;
  messageId: string;
  /** Latest user message text (the user's own words). */
  userMessage: string;
  /** The final canonical reply text. */
  finalReply: string;
  /** Safe Life-context summary lines, e.g. ['location: cafe']. */
  safeLifeContext: string[];
  /** Safe World-context summary lines, e.g. ['now: 2026-08-07 14:00']. */
  safeWorldContext: string[];
  replyIntent: string | null;
  voiceMode: string | null;
  /** Safe decision metadata (admin-only, never raw tool output). */
  decisionMetadata?: {
    memoryRecallCount?: number;
    semanticGuard?: 'pass' | 'reject' | 'fallback' | null;
  } | null;
  /** Abort signal from the caller (newer user message / shutdown). */
  signal?: AbortSignal;
}

export interface ThoughtPresenterOptions {
  repo: ThoughtRepo;
  /** Provider for the thought model call. Integration injects capabilities.chatProvider(). */
  chat: ChatProvider | (() => ChatProvider | null);
  safety: ThoughtSafetyFilter;
  bus?: EventBus;
  errorLog?: ErrorLogRepo;
  /** Actual sensitive values for the safety filter (API keys, prompt fragments). */
  safetyRefs?: SafetyRefs;
  /** Per-thought model-call budget. */
  timeoutMs?: number;
  /** First-person name the monologue may use; also checked for prompt leakage. */
  personaName?: string | null;
}

export interface ThoughtPrepareResult {
  monologue: VisibleThought | null;
  summary: VisibleThought | null;
}

/** Fixed instruction for the thought model — NEVER the persona's system prompt. */
const THOUGHT_SYSTEM = [
  '你是一个 AI 陪伴机器人的“可见想法”生成器。',
  '根据提供的“我的消息、我的回复、背景、意图”写一句到三句简短的第一人称中文内心想法（像角色自己在想，不超过 60 字）。',
  '要求：只使用提供的信息；不要解释你的输出；不要提“系统”“上下文”“模型”“根据”“指令”这类字眼；不要复述消息原文；不要输出引号、标题或编号。'
].join('');

const MAX_MONOLOGUE_CHARS = 60;

export class ThoughtPresenter {
  private readonly safety: ThoughtSafetyFilter;
  private readonly timeoutMs: number;

  constructor(private readonly deps: ThoughtPresenterOptions) {
    this.safety = deps.safety;
    this.timeoutMs = deps.timeoutMs ?? 8_000;
  }

  private chatProvider(): ChatProvider | null {
    const chat = this.deps.chat;
    return typeof chat === 'function' ? chat() : chat;
  }

  /**
   * Creates the thought rows, generates the monologue, and publishes both
   * through the DB fence. Never throws for model/safety problems: the caller
   * treats the result as best-effort.
   */
  async prepare(input: ThoughtPrepareInput): Promise<ThoughtPrepareResult> {
    const monologue = this.deps.repo.create({
      messageId: input.messageId,
      batchId: input.batchId,
      revision: input.revision,
      kind: 'inner_monologue',
      visibility: 'user'
    });
    const summary = this.deps.repo.create({
      messageId: input.messageId,
      batchId: input.batchId,
      revision: input.revision,
      kind: 'decision_summary',
      visibility: 'admin'
    });
    this.emit(monologue);
    this.emit(summary);

    // Decision summary is derived from whitelisted inputs — no model call.
    const summaryText = this.composeDecisionSummary(input);
    if (!this.deps.repo.completeThought(summary.id, summaryText)) {
      // Cancelled by a newer user message while we were composing: keep it so.
      return { monologue: this.deps.repo.get(monologue.id) ?? monologue, summary: this.deps.repo.get(summary.id) ?? summary };
    }
    const completedSummary = this.deps.repo.get(summary.id) ?? { ...summary, text: summaryText, status: 'completed' as const };
    this.emit(completedSummary);

    const finalMonologue = await this.runMonologue(monologue.id, input);
    return { monologue: finalMonologue, summary: completedSummary };
  }

  private async runMonologue(thoughtId: string, input: ThoughtPrepareInput): Promise<VisibleThought | null> {
    const provider = this.chatProvider();
    if (!provider || !provider.configured) {
      this.deps.errorLog?.add('thoughts.present', 'provider_unavailable', {
        batchId: input.batchId, revision: input.revision, messageId: input.messageId
      });
      this.fail(thoughtId);
      return this.deps.repo.get(thoughtId) ?? null;
    }
    if (input.signal?.aborted) {
      this.fail(thoughtId);
      return this.deps.repo.get(thoughtId) ?? null;
    }

    const { signal, cleanup } = mergeSignals(input.signal, this.timeoutMs);
    try {
      const userTurn = this.composeUserTurn(input);
      const result = await provider.complete({
        system: THOUGHT_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: userTurn }] }],
        maxTokens: 100,
        temperature: 0.9,
        signal
      });
      if (signal.aborted) {
        this.settleAborted(thoughtId);
        return this.deps.repo.get(thoughtId) ?? null;
      }
      const cleaned = cleanMonologue(result.text);
      if (!cleaned) {
        this.deps.errorLog?.add('thoughts.present', 'empty_thought', {
          batchId: input.batchId, revision: input.revision, messageId: input.messageId
        });
        this.fail(thoughtId);
        return this.deps.repo.get(thoughtId) ?? null;
      }
      const verdict = this.safety.check(cleaned, this.deps.safetyRefs);
      if (!verdict.safe) {
        // Safety hit: drop the thought entirely, record the event, reply is untouched.
        this.deps.errorLog?.add('thoughts.safety', `thought dropped (${verdict.reason})`, {
          batchId: input.batchId,
          revision: input.revision,
          messageId: input.messageId
        });
        this.fail(thoughtId);
        return this.deps.repo.get(thoughtId) ?? null;
      }
      // Publish barrier: only wins while the thought is still 'generating'.
      if (!this.deps.repo.completeThought(thoughtId, cleaned)) {
        // Cancelled by a newer user message: keep the cancelled state.
        return this.deps.repo.get(thoughtId) ?? null;
      }
      const completed = this.deps.repo.get(thoughtId) ?? null;
      if (completed) this.emit(completed);
      return completed;
    } catch (error) {
      if (signal.aborted) {
        this.settleAborted(thoughtId);
      } else {
        this.deps.errorLog?.add('thoughts.present', 'generation_failed', {
          batchId: input.batchId,
          revision: input.revision,
          messageId: input.messageId,
          diagnostic: String((error as Error)?.message ?? error).slice(0, 500)
        });
        this.fail(thoughtId);
      }
      return this.deps.repo.get(thoughtId) ?? null;
    } finally {
      cleanup();
    }
  }

  /** Aborted without a user-activity cancellation (timeout/shutdown): failed. */
  private settleAborted(thoughtId: string): void {
    const current = this.deps.repo.get(thoughtId);
    if (current?.status === 'generating') {
      this.deps.errorLog?.add('thoughts.present', 'timed_out_or_aborted', { thoughtId });
      this.fail(thoughtId);
    }
  }

  private fail(thoughtId: string): void {
    const current = this.deps.repo.get(thoughtId);
    if (!current || current.status !== 'generating') return;
    if (this.deps.repo.failThought(thoughtId)) {
      const failed = this.deps.repo.get(thoughtId);
      if (failed) this.emit(failed);
    }
  }

  private emit(thought: VisibleThought): void {
    this.deps.bus?.publish('thought.updated', {
      thought: {
        id: thought.id,
        messageId: thought.messageId,
        batchId: thought.batchId,
        revision: thought.revision,
        kind: thought.kind,
        status: thought.status,
        text: thought.status === 'completed' ? thought.text : ''
      }
    });
  }

  private composeUserTurn(input: ThoughtPrepareInput): string {
    const lines: string[] = [];
    if (input.safeWorldContext.length > 0) lines.push(`背景（时间地点天气）：${input.safeWorldContext.join('；')}`);
    if (input.safeLifeContext.length > 0) lines.push(`状态：${input.safeLifeContext.join('；')}`);
    if (input.replyIntent) lines.push(`意图：${input.replyIntent}`);
    if (input.voiceMode) lines.push(`语音：${input.voiceMode}`);
    lines.push(`我的消息：${truncate(input.userMessage, 400)}`);
    lines.push(`我的回复：${truncate(input.finalReply, 400)}`);
    return lines.join('\n');
  }

  private composeDecisionSummary(input: ThoughtPrepareInput): string {
    const parts: string[] = [];
    if (input.replyIntent) parts.push(`意图:${input.replyIntent}`);
    if (input.safeLifeContext.length > 0) parts.push(`状态:${input.safeLifeContext.join(',')}`);
    const memory = input.decisionMetadata?.memoryRecallCount;
    if (typeof memory === 'number') parts.push(`记忆召回:${memory}条`);
    if (input.voiceMode) parts.push(`语音:${input.voiceMode}`);
    if (input.decisionMetadata?.semanticGuard) parts.push(`守卫:${input.decisionMetadata.semanticGuard}`);
    return parts.join('；') || '（无决策信息）';
  }
}

/** Trims to 1-3 sentences, strips quotes/directives/whitespace, caps length. */
export function cleanMonologue(raw: string): string {
  let text = String(raw ?? '')
    .replace(/\[\[.*?\]\]/gu, '')
    .replace(/^(?:内心独白|想法|我在想|想)[:：]\s*/u, '')
    .replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return '';
  const sentences = text.split(/(?<=[。！？!?…])/u).map((s) => s.trim()).filter(Boolean);
  const kept = sentences.slice(0, 3).join('');
  if (kept.length <= MAX_MONOLOGUE_CHARS) return kept;
  // One run-on sentence: hard-cut at a comfortable length.
  if (kept.length <= MAX_MONOLOGUE_CHARS + 20) return kept.slice(0, MAX_MONOLOGUE_CHARS);
  return kept.slice(0, MAX_MONOLOGUE_CHARS);
}

function truncate(value: string, max: number): string {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function mergeSignals(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('thought generation timed out')), timeoutMs);
  timer.unref?.();
  const onExternal = () => controller.abort(external?.reason ?? new Error('thought aborted'));
  if (external?.aborted) controller.abort(external.reason ?? new Error('thought aborted'));
  else external?.addEventListener('abort', onExternal, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternal);
    }
  };
}
