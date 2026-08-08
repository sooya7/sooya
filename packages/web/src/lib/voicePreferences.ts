/** Voice preference shapes mirrored from the server for the settings UI. */

export type VoiceMode = 'replace' | 'complement' | 'summary' | 'read_aloud';

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
