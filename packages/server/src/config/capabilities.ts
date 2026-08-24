import type { AppEnv } from './env.js';

export interface CapabilityPolicy {
  messaging: {
    qqBot: boolean;
    qqConfigured: boolean;
  };
  proactive: {
    enabled: boolean;
    qqDelivery: boolean;
    lifeCandidates: boolean;
    futureCandidates: boolean;
    effective: boolean;
    reasons: string[];
  };
  continuity: {
    future: boolean;
    relationship: boolean;
    timeline: boolean;
    feedback: boolean;
  };
  memory: {
    backend: 'ombre' | 'legacy';
    read: boolean;
    write: boolean;
  };
  world: {
    enabled: boolean;
    location: boolean;
    weather: boolean;
  };
}

/**
 * The only place where cross-flag product capabilities are derived. Raw env
 * values remain available for infrastructure tuning; domain code consumes this
 * policy for user-visible feature decisions.
 */
export function createCapabilityPolicy(env: AppEnv): CapabilityPolicy {
  const qqBot = env.QQ_BOT_ENABLED;
  const qqConfigured = Boolean(env.QQ_APP_ID && env.QQ_APP_SECRET && env.QQ_CALLBACK_SECRET);
  const lifeCandidates = env.ENABLE_LIFE_ENGINE && env.ENABLE_LIFE_REACH_OUT;
  const futureCandidates = env.FUTURE_ENGINE_ENABLED && env.FUTURE_PROACTIVE_ENABLED;
  const qqDelivery = qqBot && qqConfigured && env.QQ_PROACTIVE_ENABLED;
  const candidateEngine = lifeCandidates || futureCandidates;
  const proactiveReasons: string[] = [];
  if (!candidateEngine) proactiveReasons.push('no proactive candidate engine is enabled');
  if (!qqBot) proactiveReasons.push('qq bot is disabled');
  else if (!qqConfigured) proactiveReasons.push('qq bot is not configured');
  if (!env.QQ_PROACTIVE_ENABLED) proactiveReasons.push('qq proactive delivery is disabled');
  return {
    messaging: { qqBot, qqConfigured },
    proactive: {
      enabled: lifeCandidates || futureCandidates,
      qqDelivery,
      lifeCandidates,
      futureCandidates,
      effective: candidateEngine && qqDelivery,
      reasons: proactiveReasons
    },
    continuity: {
      future: env.FUTURE_ENGINE_ENABLED,
      relationship: env.RELATIONSHIP_CONTEXT_ENABLED,
      timeline: env.TIMELINE_ENABLED,
      feedback: env.INTERACTION_LEARNING_ENABLED
    },
    memory: {
      backend: env.MEMORY_BACKEND,
      read: !env.DISABLE_MEMORY_PIPELINE && (env.MEMORY_BACKEND !== 'ombre' || env.OMBRE_READ_ENABLED),
      write: !env.DISABLE_MEMORY_PIPELINE && (env.MEMORY_BACKEND !== 'ombre' || env.OMBRE_WRITE_ENABLED)
    },
    world: {
      enabled: env.WORLD_CONTEXT_ENABLED,
      location: env.WORLD_CONTEXT_ENABLED && env.LOCATION_MODEL_ENABLED,
      weather: env.WORLD_CONTEXT_ENABLED && env.LOCATION_MODEL_ENABLED && env.WEATHER_ENABLED
    }
  };
}

export function capabilityInspector(policy: CapabilityPolicy): CapabilityPolicy {
  return structuredClone(policy);
}
