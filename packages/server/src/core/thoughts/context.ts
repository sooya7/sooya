/**
 * ThoughtContextProvider — the whitelist of safe context the visible-thought
 * layer may read. Replaces the deleted Decision Trace product while keeping
 * every safety boundary: only persisted, already-published artifacts with
 * no free text beyond coarse labels; never the system prompt, hidden
 * reasoning, raw memory dumps, tool results or provider secrets.
 */
import type { MemoryRecallTrace } from '../context.js';
import type { WorldSnapshot } from '../world-context.js';
import type { VoiceGenerationRow } from '../../db/repos/voice.repo.js';

export interface ThoughtContextProvider {
  /** Safe World-context snapshot (location + weather). */
  worldSnapshot(): WorldSnapshot | null;
  /** Safe Life summary: activity + mood only. */
  lifeSummary(): { activity: string; mood: string } | null;
  /** Memory recall stats of the last context build (the batch just replied). */
  memoryRecallStats(): MemoryRecallTrace | null;
  /** Voice generation row for the published message (mode + guard outcome). */
  voiceRowFor(messageId: string): VoiceGenerationRow | undefined;
}

/**
 * Reply-intent label — a small deterministic heuristic (NOT a model call).
 * Safe, coarse and honest; used for the thought's safe metadata only.
 */
export function classifyReplyIntent(userText: string): string | undefined {
  const text = String(userText ?? '').trim();
  if (!text) return undefined;
  if (/[?？]\s*$/u.test(text) || /^(为什么|怎么|如何|什么是|啥是|在吗|干嘛|有没有)/u.test(text)) return 'question';
  if (/(难过|伤心|委屈|焦虑|压力|好累|累了|想哭|哭|烦死|生气|害怕|孤独|睡不着|想不开)/u.test(text)) return 'emotional_support';
  if (/(帮我|请|能不能|可以吗|教教|讲讲|推荐|介绍一下|给个)/u.test(text)) return 'request';
  if (/(晚安|早安|午安|睡|晚安了|我先睡)/u.test(text)) return 'greeting';
  return undefined;
}

/**
 * Semantic-guard outcome for the published reply, derived from persisted
 * degraded flags and the voice generation row (deterministic, no model).
 */
export function semanticGuardFrom(
  input: { degraded: string[]; voiceFallbackReason?: string | null },
  voiceRow: VoiceGenerationRow | undefined
): 'pass' | 'reject' | 'fallback' | undefined {
  if (input.degraded.includes('voice:semantic-risk') || input.degraded.includes('voice:skipped-naturalness')) return 'reject';
  if (input.voiceFallbackReason === 'semantic_risk') return 'reject';
  if (input.voiceFallbackReason === 'too_long') return 'fallback';
  if (voiceRow) return 'pass';
  return undefined;
}
