import type { VoiceDirective, VoiceIntent } from './types.js';

/**
 * Rule-based voice intent parser. Distinguishes:
 *   - read_aloud  "读出来 / 念一下 / 朗读这段"
 *   - voice_reply "用语音回我 / 你说给我听"
 *   - voice_only  "只发语音 / 别打字"
 *   - no_voice    "不要发语音 / 打字就好"
 *
 * Capability questions ("你会发语音吗？") must NOT trigger anything.
 * Conflicts resolve to the LAST explicit user directive in the batch; the
 * hard precedence is no_voice > voice_only > voice_reply > read_aloud > auto.
 */

const READ_ALOUD_PATTERNS = [
  /(?:把|将|帮我把)?(?:刚才|这段|这个|那条|那(?:句|段))?[^，。！？!?]{0,12}?(?:读出来|念出来|念一下|朗读|读给我听)/u,
  /(?:读|念)(?:给我)?(?:听|一下|一遍|出来)/u,
  /read (?:it )?(?:out loud|aloud)/i
];

const VOICE_REPLY_PATTERNS = [
  /用语音(?:回|回答|讲|说)(?:我|给我)?/,
  /语音(?:回复|回答|讲|说)/,
  /发(?:个|条|段)?语音(?:说|回|答)?/,
  /你说给我听/,
  /用声音回答/,
  /(?:发|用)语音消息/,
  /voice (?:reply|message)/i,
  /say it/i
];

const VOICE_ONLY_PATTERNS = [
  /只发语音/,
  /只要语音/,
  /只用语音/,
  /光发语音/,
  /别打字/,
  /不要打字/,
  /voice only/i
];

const NO_VOICE_PATTERNS = [
  /不要(?:发)?语音/,
  /别发语音/,
  /不用语音/,
  /打字就好/,
  /no voice/i
];

/** 「你会发语音吗」「能念出来吗」——能力询问，不是指令。 */
const ABILITY_QUESTION_RE =
  /(?:会不会|能不能|会|能|可以|可否|能否)[^，。！!？?、\n]{0,12}(?:语音|音频|读出来|念|朗读)[吗么嘛呢？?~～。]*$/u;

const INTENT_ORDER: VoiceIntent[] = ['no_voice', 'voice_only', 'voice_reply', 'read_aloud'];

export function parseVoiceIntent(text: string): VoiceIntent {
  const t = (text ?? '').trim();
  if (!t) return 'none';
  if (ABILITY_QUESTION_RE.test(t)) return 'none';
  let found: VoiceIntent = 'none';
  for (const [re, intent] of [
    [NO_VOICE_PATTERNS, 'no_voice'],
    [VOICE_ONLY_PATTERNS, 'voice_only'],
    [VOICE_REPLY_PATTERNS, 'voice_reply'],
    [READ_ALOUD_PATTERNS, 'read_aloud']
  ] as Array<[RegExp[], VoiceIntent]>) {
    if (re.some((pattern) => pattern.test(t))) {
      // Last matching (lowest priority slot) wins among the explicit intents.
      if (INTENT_ORDER.indexOf(found) > INTENT_ORDER.indexOf(intent)) found = intent;
      if (found === 'none') found = intent;
    }
  }
  return found;
}

/**
 * Merges per-message intents of one batch. The final user directive wins
 * (later messages override earlier ones).
 */
export function mergeVoiceDirectives(messages: Array<{ text: string } | undefined>, explicit?: Partial<VoiceDirective>): VoiceDirective {
  let intent: VoiceIntent = 'none';
  for (const message of messages) {
    if (!message) continue;
    const parsed = parseVoiceIntent(message.text);
    if (parsed !== 'none') intent = parsed;
  }
  if (explicit?.intent && explicit.intent !== 'none') intent = explicit.intent;
  return { intent, requestedEmotion: explicit?.requestedEmotion ?? null, requestedStyle: explicit?.requestedStyle ?? null };
}
