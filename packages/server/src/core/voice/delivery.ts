import type { TTSOptions } from '../../providers/types.js';
import type { VoiceDeliveryPlan } from './types.js';
import type { VoiceEmotionMap } from '../voice.js';

/**
 * Delivery planning (§89): from a single emotion (or detected mood) to a
 * concrete delivery plan, then a provider-agnostic mapping to TTSOptions.
 * Providers that do not understand the advanced fields degrade to
 * pace→speed / primaryEmotion→emotion / instructions→instructions.
 */

const PLAN_TABLE: Record<VoiceDeliveryPlan['primaryEmotion'], Omit<VoiceDeliveryPlan, 'primaryEmotion' | 'emphasis'>> = {
  neutral: {
    pace: 1.0, energy: 0.5, warmth: 0.5, intimacy: 0.4, seriousness: 0.5,
    openingStyle: 'direct', endingStyle: 'falling', pauseStyle: 'natural',
    instructions: '自然、清晰、平静地说，像平时聊天一样。'
  },
  happy: {
    pace: 1.06, energy: 0.7, warmth: 0.75, intimacy: 0.6, seriousness: 0.25,
    openingStyle: 'smiling', endingStyle: 'playful', pauseStyle: 'natural',
    instructions: '轻快、明亮、带一点笑意，但不要夸张，不要像表演。'
  },
  gentle: {
    pace: 0.93, energy: 0.3, warmth: 0.9, intimacy: 0.8, seriousness: 0.5,
    openingStyle: 'soft', endingStyle: 'soft', pauseStyle: 'thoughtful',
    instructions: '像私下安慰很亲近的人。开头轻一点，中间克制，不要煽情，最后一句放慢并自然收住。'
  },
  sad: {
    pace: 0.9, energy: 0.25, warmth: 0.6, intimacy: 0.65, seriousness: 0.7,
    openingStyle: 'soft', endingStyle: 'falling', pauseStyle: 'thoughtful',
    instructions: '轻声、克制、略慢，带一点低落，不要哭腔，不要煽情。'
  },
  angry: {
    pace: 1.04, energy: 0.75, warmth: 0.3, intimacy: 0.4, seriousness: 0.8,
    openingStyle: 'direct', endingStyle: 'falling', pauseStyle: 'minimal',
    instructions: '语气坚定、略急，但不要吼叫，不要失去分寸。'
  },
  sleepy: {
    pace: 0.85, energy: 0.2, warmth: 0.7, intimacy: 0.7, seriousness: 0.3,
    openingStyle: 'soft', endingStyle: 'soft', pauseStyle: 'thoughtful',
    instructions: '声音放轻放慢，像快睡着前说话，带着困意但不含糊。'
  },
  playful: {
    pace: 1.04, energy: 0.62, warmth: 0.72, intimacy: 0.7, seriousness: 0.15,
    openingStyle: 'smiling', endingStyle: 'playful', pauseStyle: 'natural',
    instructions: '带一点忍笑的感觉，不要夸张，不要像表演台词。'
  },
  serious: {
    pace: 0.96, energy: 0.55, warmth: 0.45, intimacy: 0.5, seriousness: 0.9,
    openingStyle: 'direct', endingStyle: 'falling', pauseStyle: 'minimal',
    instructions: '认真、清楚、直接，不绕弯子，但语气不要生硬。'
  }
};

export const VOICE_DELIVERY_EMOTIONS = Object.keys(PLAN_TABLE) as VoiceDeliveryPlan['primaryEmotion'][];

export function planDelivery(
  emotion: string | null | undefined,
  opts: { pace?: number; seriousness?: number } = {}
): VoiceDeliveryPlan {
  const key = emotion && emotion in PLAN_TABLE ? (emotion as VoiceDeliveryPlan['primaryEmotion']) : 'neutral';
  const base = PLAN_TABLE[key]!;
  const pace = Math.min(1.25, Math.max(0.75, (opts.pace ?? base.pace) + (key === 'sleepy' ? -0.04 : 0)));
  const seriousness = key === 'sleepy' || key === 'playful' ? base.seriousness : opts.seriousness ?? base.seriousness;
  return {
    primaryEmotion: key,
    pace: Math.round(pace * 100) / 100,
    energy: base.energy,
    warmth: base.warmth,
    intimacy: base.intimacy,
    seriousness,
    openingStyle: base.openingStyle,
    endingStyle: base.endingStyle,
    pauseStyle: base.pauseStyle,
    emphasis: [],
    instructions: base.instructions
  };
}

/**
 * Maps a delivery plan onto the existing TTSOptions surface. The preset
 * catalogue (voice.emotions setting) supplies the vendor emotion wording but
 * never replaces the delivery plan: `pace` → speed, the plan's compiled
 * instructions always reach the provider (D3). `advanced: false` keeps the
 * legacy preset-only mapping for VOICE_ADVANCED_DELIVERY_ENABLED=false.
 */
export function deliveryToTTSOptions(
  plan: VoiceDeliveryPlan,
  savedEmotions: VoiceEmotionMap,
  opts: { advanced?: boolean; customPresets?: boolean } = {}
): Required<Pick<TTSOptions, 'emotion' | 'instructions' | 'speed'>> {
  const preset = savedEmotions[plan.primaryEmotion] ?? savedEmotions.neutral;
  const speed = Math.round(plan.pace * 100) / 100;
  if (opts.advanced === false) {
    if (preset) return { emotion: plan.primaryEmotion, instructions: preset.instructions, speed: 1 };
    return { emotion: plan.primaryEmotion, instructions: plan.instructions, speed };
  }
  // A user-saved emotion mapping is an explicit override: it drives the
  // request exactly as configured (old contract). Otherwise the delivery
  // plan is consumed — pace → speed, compiled instructions reach the provider
  // and the preset only supplies the vendor emotion wording (D3).
  if (opts.customPresets && preset) {
    return { emotion: plan.primaryEmotion, instructions: preset.instructions, speed: preset.speed };
  }
  const planInstructions = [
    plan.instructions,
    plan.emphasis.length ? `重点强调：${plan.emphasis.join('、')}。` : '',
    plan.pauseStyle === 'thoughtful' ? '句与句之间留一点自然的停顿。' : ''
  ].filter(Boolean).join('');
  return {
    emotion: plan.primaryEmotion,
    instructions: preset ? [preset.instructions, planInstructions].filter(Boolean).join(' ') : planInstructions,
    speed
  };
}
