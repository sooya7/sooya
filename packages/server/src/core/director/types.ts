import type { z } from 'zod';

export type DirectorTask = 'sticker' | 'voice' | 'image';

export interface DirectorRunRequest<T> {
  task: DirectorTask;
  system: string;
  input: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface DirectorRunResult<T> {
  data: T;
  model: string;
  latencyMs: number;
}

export type DirectorEventName = 'started' | 'completed' | 'failed' | 'fallback';

export interface DirectorEvent {
  event: DirectorEventName;
  task: DirectorTask;
  latencyMs?: number;
  inputChars?: number;
  outputChars?: number;
  reason?: string;
  model?: string;
}
