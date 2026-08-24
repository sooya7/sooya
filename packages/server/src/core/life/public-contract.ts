import type { LifeLogRow } from '../../db/repos/life.repo.js';
import type { LifeConfig, LifeTickResult } from '../life.js';

export type LifeConversationMood = 'warm' | 'neutral' | 'rough';

export interface LifeConversationSignal {
  mood: LifeConversationMood;
  text?: string;
  messageId?: string;
}

export interface LifeProactiveCandidate {
  id: string;
  activity: string;
  kind: string;
  mood: string;
  started_at: string;
  ended_at: string;
  shared: number;
  created_at: string;
}

/**
 * The only runtime surface that application modules may use for Life.
 * Legacy Life and Life V2 can evolve behind this boundary without making
 * jobs, proactive composition, or routes know which implementation is live.
 */
export interface LifeRuntime {
  tick(): LifeTickResult | { changed: boolean; activity: string; kind: string; mood: string; endedPrevious: LifeLogRow | null };
  contextLines(lastUserMessageAt?: Date | null): string[];
  shouldReachOut(lastUserMessageAt: Date | null, lastAssistantMessageAt: Date | null): { reach: boolean; reason: string; candidate: LifeLogRow | null };
  markShared(id: string): void;
  currentState(): ReturnType<LifeRuntime['snapshot']>;
  snapshot(): {
    activity: string;
    kind: string;
    mood: string;
    startedAt: string;
    endsAt: string;
    recent: Array<{ activity: string; startedAt: string; endedAt: string }>;
    [key: string]: unknown;
  };
  applyConversationSignal(signal: LifeConversationSignal): void;
  getProactiveCandidates(): LifeProactiveCandidate[];
  settings: LifeConfig;
  now(): Date;
}

export function isLifeRuntime(value: unknown): value is LifeRuntime {
  if (!value || typeof value !== 'object') return false;
  const runtime = value as Partial<LifeRuntime>;
  return typeof runtime.tick === 'function'
    && typeof runtime.contextLines === 'function'
    && typeof runtime.shouldReachOut === 'function'
    && typeof runtime.snapshot === 'function'
    && typeof runtime.currentState === 'function'
    && typeof runtime.applyConversationSignal === 'function'
    && typeof runtime.getProactiveCandidates === 'function';
}
