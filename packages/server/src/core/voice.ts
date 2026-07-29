import { detectSpeechEmotion } from '../providers/tts.js';
import type { TTSOptions } from '../providers/types.js';

export interface VoiceEmotionPreset {
  label: string;
  instructions: string;
  speed: number;
}

export type VoiceEmotionMap = Record<string, VoiceEmotionPreset>;

export const DEFAULT_VOICE_EMOTIONS: VoiceEmotionMap = {
  neutral: { label: '中性', instructions: '自然、清晰、平静地说。', speed: 1 },
  happy: { label: '开心', instructions: '轻快、明亮、有笑意，但不要夸张。', speed: 1.06 },
  sad: { label: '难过', instructions: '轻声、克制、略慢，带一点低落。', speed: 0.9 },
  angry: { label: '生气', instructions: '语气坚定、略急，但不要吼叫。', speed: 1.04 },
  gentle: { label: '温柔', instructions: '柔和、亲近、放慢一点。', speed: 0.94 }
};

const DETECTED_TO_SAVED: Record<string, string> = {
  happy: 'happy',
  playful: 'happy',
  sad: 'sad',
  angry: 'angry',
  comforting: 'gentle',
  sleepy: 'gentle',
  warm: 'gentle',
  curious: 'neutral',
  serious: 'neutral',
  neutral: 'neutral'
};

export function resolveVoiceDelivery(
  text: string,
  requestedEmotion: string | null | undefined,
  saved: VoiceEmotionMap
): Required<Pick<TTSOptions, 'emotion' | 'instructions' | 'speed'>> {
  const detected = DETECTED_TO_SAVED[detectSpeechEmotion(text)] ?? 'neutral';
  const requested = requestedEmotion?.trim();
  const candidate = requested && saved[requested] ? requested : requested ? 'neutral' : detected;
  const emotion = saved[candidate] ? candidate : 'neutral';
  const preset = saved[emotion] ?? saved.neutral ?? DEFAULT_VOICE_EMOTIONS.neutral!;
  return {
    emotion,
    instructions: preset.instructions,
    speed: preset.speed
  };
}
