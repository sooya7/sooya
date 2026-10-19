import type { VoiceIntent, VoiceMode, VoiceRequestedBy } from './types.js';

/**
 * Voice decision for an inline reply: whether it gets voice at all, and in
 * which mode. User intent always wins; otherwise her [[voice]] marker (or a
 * send_voice call, folded into the same marker) decides. Whether a marker she
 * wrote on her own is allowed through at all - auto frequency, daily cap - is
 * checked by the replier before this runs.
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
  persona: {
    name: string;
    voicePolicy: { enabled: boolean; maxCharsPerClip: number };
  };
  preferences: { enabled: boolean; autoVoiceFrequency: 'never' | 'rare' | 'sometimes'; preferredModes: VoiceMode[]; maxVoiceSeconds: number };
  ttsConfigured: boolean;
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

  // Nothing is volunteered beyond the marker: no user intent and no marker
  // means no voice.
  return { mode: null, requestedBy: 'auto', emotion: null, reason: 'not_requested' };
}
