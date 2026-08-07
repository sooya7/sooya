/**
 * Shared types for the independent voice expression system (Part 4 of the
 * upgrade plan). Voice is no longer a read-back of the text reply: it has its
 * own intent, mode, spoken script, delivery plan and publication rules.
 */

export type VoiceIntent =
  | 'none'
  | 'read_aloud'
  | 'voice_reply'
  | 'voice_only'
  | 'no_voice';

export type VoiceMode = 'read_aloud' | 'replace' | 'complement' | 'summary';

export type VoiceRequestedBy = 'user' | 'model' | 'auto' | 'proactive' | 'accessibility';

export interface VoiceDirective {
  intent: VoiceIntent;
  targetMessageId?: string | null;
  requestedEmotion?: string | null;
  requestedStyle?: string | null;
}

export interface VoiceDeliveryPlan {
  primaryEmotion:
    | 'neutral'
    | 'happy'
    | 'gentle'
    | 'sad'
    | 'angry'
    | 'sleepy'
    | 'playful'
    | 'serious';
  secondaryEmotion?: string | null;
  pace: number;
  energy: number;
  warmth: number;
  intimacy: number;
  seriousness: number;
  openingStyle: 'direct' | 'soft' | 'hesitant' | 'smiling';
  endingStyle: 'falling' | 'questioning' | 'soft' | 'playful';
  pauseStyle: 'minimal' | 'natural' | 'thoughtful';
  emphasis: string[];
  instructions: string;
}

export interface VoiceNaturalnessReport {
  textSimilarity: number;
  averageSentenceChars: number;
  maxSentenceChars: number;
  formalPhraseCount: number;
  fillerDensity: number;
  repeatedOpeningScore: number;
  markdownResidueCount: number;
  estimatedSeconds: number;
  accepted: boolean;
  reasons: string[];
}

export interface VoiceScript {
  spokenText: string;
  mode: VoiceMode;
  purpose: 'full_answer' | 'emotional_support' | 'short_summary' | 'read_aloud' | 'follow_up';
  estimatedSeconds: number;
  semanticClaims: string[];
  styleTags: string[];
}

/** Stored on the audio part's meta so the UI can label it correctly. */
export interface VoicePartMeta {
  voiceMode: VoiceMode;
  requestedBy: VoiceRequestedBy;
  emotion: string;
  pace: number;
  generatedFromTextPartId?: string | null;
  targetMessageId?: string | null;
  synthesisChars: number;
  /** Only present when the synthesis was clipped to maxChars (old UI contract). */
  clipped?: boolean;
  /** Chars actually synthesized when clipped. */
  spokenChars?: number;
  fullTranscriptAvailable: boolean;
  voiceGenerationId?: string;
}

export interface UserVoicePreferences {
  enabled: boolean;
  autoVoiceFrequency: 'never' | 'rare' | 'sometimes';
  preferredModes: VoiceMode[];
  maxVoiceSeconds: number;
  autoplay: boolean;
  showTranscript: 'always' | 'collapsed' | 'hidden';
  preferredPace?: number;
  quietHours?: { from: number; to: number };
}

export const DEFAULT_VOICE_PREFERENCES: UserVoicePreferences = {
  enabled: true,
  autoVoiceFrequency: 'rare',
  preferredModes: ['replace', 'complement'],
  maxVoiceSeconds: 35,
  autoplay: false,
  showTranscript: 'collapsed'
};
