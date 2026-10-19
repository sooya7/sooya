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

  // Nothing is volunteered any more. Voice goes out when the user asks for it,
  // when the reply model calls send_voice, or when a legacy marker asks and the
  // auto frequency is not 'never'. The old auto branch (silent hours, text
  // cues, daily cap, long-reply summaries) is gone.
  return { mode: null, requestedBy: 'auto', emotion: null, reason: 'not_requested' };
}
