/**
 * DecisionTraceService — admin-only audit of what went into a reply.
 *
 * Everything recorded is a SAFE SUMMARY derived from persisted, already-
 * published artifacts: never the system prompt, never the hidden reasoning,
 * never raw memory text, never tool results. The trace is written once the
 * reply is fully published (revision-fenced by the coordinator), so it always
 * describes the reply the user actually saw.
 */

import type { ThoughtRepo } from '../../db/repos/thought.repo.js';
import type { DecisionTrace } from './types.js';
import type { MemoryRecallTrace } from '../context.js';
import type { WorldSnapshot } from '../world-context.js';
import type { VoiceGenerationRow } from '../../db/repos/voice.repo.js';
import type { ChatMessage } from '../types.js';

export interface TraceInput {
  batchId: string;
  revision: number;
  messageId: string;
  userMessages: ChatMessage[];
  degraded: string[];
  /**
   * The voice replace-fallback path stamps the published text part's meta
   * with `voiceFallbackReason` ('semantic_risk' | 'too_long'); the owning
   * service resolves it from the message so the trace can record the guard
   * outcome without re-reading raw internals.
   */
  voiceFallbackReason?: string | null;
}

/** Structural seams so the service stays decoupled from the modules it reads. */
export interface TraceSeams {
  repo: ThoughtRepo;
  /** Safe World-context snapshot (location + weather). */
  world?: (() => WorldSnapshot) | null;
  /** Safe Life summary: activity + mood only. */
  life?: (() => { activity: string; mood: string }) | null;
  /** Memory recall stats of the last context build (the batch just replied). */
  context?: (() => { memoryRecallTrace(): MemoryRecallTrace }) | null;
  /** Voice generation row for the published message (mode + guard outcome). */
  voice?: ((messageId: string) => VoiceGenerationRow | undefined) | null;
  /** Experiment variant for the reply subsystem (Agent C contract). */
  experiments?: { canonicalVariantForSubsystem(subsystem: string): string | null } | null;
  clock?: () => Date;
}

export class DecisionTraceService {
  constructor(private readonly seams: TraceSeams) {}

  // ---- safe-context accessors (whitelist only, shared with the presenter) ----

  worldSnapshot(): ReturnType<NonNullable<TraceSeams['world']>> | null {
    try {
      return this.seams.world ? this.seams.world() : null;
    } catch {
      return null;
    }
  }

  lifeSummary(): ReturnType<NonNullable<TraceSeams['life']>> | null {
    try {
      return this.seams.life ? this.seams.life() : null;
    } catch {
      return null;
    }
  }

  voiceRowFor(messageId: string): VoiceGenerationRow | undefined {
    try {
      return this.seams.voice ? this.seams.voice(messageId) : undefined;
    } catch {
      return undefined;
    }
  }

  memoryRecallStats(): { recalled: number } | null {
    try {
      return this.seams.context ? this.seams.context().memoryRecallTrace().stats : null;
    } catch {
      return null;
    }
  }

  /** Builds and persists the trace. Returns the persisted trace. */
  record(input: TraceInput): DecisionTrace {
    const createdAt = (this.seams.clock ?? (() => new Date()))().toISOString();
    const world = this.worldSnapshot();
    const voiceRow = this.voiceRowFor(input.messageId);
    const memoryTrace = this.memoryRecallStats();
    const life = this.lifeSummary();

    const latestUserText = [...input.userMessages]
      .reverse()
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'text' && part.text)
      .map((part) => (part.type === 'text' ? part.text! : ''))
      .find((text) => text.trim().length > 0) ?? '';

    const lifeContext: string[] = [];
    if (world?.location) {
      const place = world.location.city ?? world.location.name ?? world.location.id;
      if (place) lifeContext.push(`location: ${place}`);
    }
    if (life) lifeContext.push(`activity: ${life.activity}`, `mood: ${life.mood}`);

    const trace: DecisionTrace = {
      batchId: input.batchId,
      revision: input.revision,
      replyIntent: classifyReplyIntent(latestUserText),
      lifeContext: lifeContext.length > 0 ? lifeContext : undefined,
      weather: world?.weatherCondition ?? null,
      memoryRecallCount: memoryTrace?.recalled ?? undefined,
      voiceMode: voiceRow?.mode ?? null,
      semanticGuard: semanticGuardFrom(input, voiceRow),
      experimentVariant: this.seams.experiments?.canonicalVariantForSubsystem('reply') ?? null,
      proactive: null,
      createdAt
    };
    this.seams.repo.saveTrace({ batchId: input.batchId, revision: input.revision, trace });
    return trace;
  }
}

/**
 * Reply-intent label — a small deterministic heuristic (NOT a model call).
 * Safe, coarse and honest; used for admin diagnostics only.
 */
export function classifyReplyIntent(userText: string): string | undefined {
  const text = String(userText ?? '').trim();
  if (!text) return undefined;
  if (/[?？]\s*$/u.test(text) || /^(为什么|怎么|如何|什么是|啥是|在吗|干嘛|有没有)/u.test(text)) return 'question';
  if (/(难过|伤心|委屈|焦虑|压力|好累|累了|想哭|哭|烦死|生气|害怕|孤独|睡不着|想不开)/u.test(text)) return 'emotional_support';
  if (/(帮我|请|能不能|可以吗|教教|讲讲|推荐|介绍一下|给个)/u.test(text)) return 'request';
  if (/(早安|晚安|早上好|中午好|下午好|晚上好|你好|回来了|出门)/u.test(text)) return 'greeting';
  return 'small_talk';
}

/** Voice guard outcome derived from persisted artifacts (never a claim about the model). */
export function semanticGuardFrom(
  input: Pick<TraceInput, 'degraded' | 'voiceFallbackReason'>,
  voiceRow: VoiceGenerationRow | undefined
): 'pass' | 'reject' | 'fallback' | undefined {
  if (input.degraded.includes('voice:semantic-risk') || input.degraded.includes('voice:skipped-naturalness')) return 'reject';
  if (input.voiceFallbackReason === 'semantic_risk') return 'reject';
  if (input.voiceFallbackReason === 'too_long') return 'fallback';
  if (voiceRow) return 'pass';
  return undefined;
}
