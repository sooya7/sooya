import type { ChatProvider } from '../../providers/types.js';
import type { PersonaSpeechStyle } from './style.js';
import type { VoiceIntent, VoiceMode, VoiceRequestedBy } from './types.js';

/**
 * Auto voice decision (§96-97): whether an inline reply gets voice at all,
 * and in which mode. User intent always wins; the model marker is a strong
 * hint; the auto path is conservative (rare, emotional, short, capped).
 */

export interface VoiceDecision {
  mode: VoiceMode | null;
  requestedBy: VoiceRequestedBy;
  emotion: string | null;
  reason: string;
}

export interface VoiceDecisionInput {
  userIntent: VoiceIntent;
  /** The model's [[voice]]-family marker, already normalized. */
  modelVoice?: 'replace' | 'complement' | 'summary' | 'read_aloud' | boolean | string | null;
  text: string;
  persona: {
    name: string;
    voicePolicy: { enabled: boolean; maxCharsPerClip: number };
  };
  preferences: { enabled: boolean; autoVoiceFrequency: 'never' | 'rare' | 'sometimes'; preferredModes: VoiceMode[]; maxVoiceSeconds: number };
  ttsConfigured: boolean;
  recentAutoCount: number;
  dailyAutoCap: number;
  inSilentHours: boolean;
  style?: PersonaSpeechStyle | null;
  /** VOICE_AUTO_COMPLEMENT_ENABLED: when false the auto path never picks complement. */
  autoComplementEnabled?: boolean;
  /** VOICE_READ_ALOUD_ENABLED: when false read-aloud intents/markers are ignored. */
  readAloudEnabled?: boolean;
}

/** Emotional contexts worth an auto voice, and the emotion to use. */
const AUTO_EMOTION_CUES: Array<[RegExp, string]> = [
  [/晚安|早点睡|睡个好觉/, 'sleepy'],
  [/别难过|抱抱|别担心|没事的|心疼|辛苦/, 'gentle'],
  [/哈哈|笑死|太好了|开心|好耶|恭喜/, 'happy'],
  [/好喜欢你|想你|亲亲/, 'gentle'],
  [/气死|好烦|讨厌/, 'angry'],
  [/想你了|好久没聊|今天怎么样/, 'gentle']
];

const EMOJI_OR_AFFECTION = /[😊😄🥰😘❤️💕]|亲爱的|宝贝|乖/u;

export function decideVoiceMode(input: VoiceDecisionInput): VoiceDecision {
  const { userIntent } = input;
  if (!input.persona.voicePolicy.enabled || !input.ttsConfigured || !input.preferences.enabled) {
    return { mode: null, requestedBy: 'auto', emotion: null, reason: 'disabled' };
  }
  // Hard user intents.
  if (userIntent === 'no_voice') return { mode: null, requestedBy: 'user', emotion: null, reason: 'no_voice' };
  if (userIntent === 'voice_only' || userIntent === 'voice_reply') {
    return { mode: 'replace', requestedBy: 'user', emotion: null, reason: userIntent };
  }
  if (userIntent === 'read_aloud') {
    if (input.readAloudEnabled === false) return { mode: null, requestedBy: 'user', emotion: null, reason: 'read_aloud_disabled' };
    return { mode: 'read_aloud', requestedBy: 'user', emotion: null, reason: 'read_aloud' };
  }

  // Model marker.
  const mv = input.modelVoice;
  if (mv === 'replace') return { mode: 'replace', requestedBy: 'model', emotion: null, reason: 'model:replace' };
  if (mv === 'summary') return { mode: 'summary', requestedBy: 'model', emotion: null, reason: 'model:summary' };
  if (mv === 'complement' || mv === true) return { mode: 'complement', requestedBy: 'model', emotion: null, reason: 'model:complement' };
  if (mv === 'read_aloud') {
    if (input.readAloudEnabled === false) return { mode: null, requestedBy: 'model', emotion: null, reason: 'read_aloud_disabled' };
    return { mode: 'read_aloud', requestedBy: 'model', emotion: null, reason: 'model:read_aloud' };
  }
  if (typeof mv === 'string' && mv !== 'false' && mv !== 'none') {
    return { mode: 'complement', requestedBy: 'model', emotion: null, reason: `model:${mv}` };
  }

  // Auto (conservative).
  if (input.inSilentHours) return { mode: null, requestedBy: 'auto', emotion: null, reason: 'silent_hours' };
  if (input.preferences.autoVoiceFrequency === 'never') return { mode: null, requestedBy: 'auto', emotion: null, reason: 'auto_never' };
  if (input.recentAutoCount >= input.dailyAutoCap) return { mode: null, requestedBy: 'auto', emotion: null, reason: 'daily_cap' };
  const autoComplement = input.autoComplementEnabled !== false;
  if (input.preferences.autoVoiceFrequency === 'sometimes' && EMOJI_OR_AFFECTION.test(input.text)) {
    if (!autoComplement) return { mode: null, requestedBy: 'auto', emotion: null, reason: 'auto_complement_disabled' };
    return { mode: 'complement', requestedBy: 'auto', emotion: 'happy', reason: 'auto:affection' };
  }
  for (const [re, emotion] of AUTO_EMOTION_CUES) {
    if (re.test(input.text)) {
      const mode = autoComplement && input.preferences.preferredModes.includes('complement') ? 'complement' : 'replace';
      return { mode, requestedBy: 'auto', emotion, reason: `auto:${emotion}` };
    }
  }
  // Long structured replies: a summary voice can help, but only for the
  // 'sometimes' frequency and only when preferredModes allow summary.
  if (input.preferences.autoVoiceFrequency === 'sometimes' && input.preferences.preferredModes.includes('summary') && input.text.length > 220) {
    return { mode: 'summary', requestedBy: 'auto', emotion: null, reason: 'auto:long_text' };
  }
  return { mode: null, requestedBy: 'auto', emotion: null, reason: 'no_cue' };
}
