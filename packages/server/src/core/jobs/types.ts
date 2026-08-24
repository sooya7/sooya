export type JobLane = 'critical' | 'background' | 'autonomous' | 'maintenance';
export type JobTimeoutMode = 'abort' | 'observe';

export interface JobContext {
  jobId: string;
  type: string;
  lane: JobLane;
  attempt: number;
  signal: AbortSignal;
  /** Called by the executor when a cancellable job exceeds its contract timeout. */
  cancel?: () => void;
}

export type JobHandler = (
  payload: Record<string, unknown>,
  context: JobContext
) => Promise<void>;

export interface JobDefinition {
  type: string;
  lane: JobLane;
  timeoutMs: number;
  maxAttempts: number;
  retryable: boolean;
  cancellable: boolean;
  timeoutMode: JobTimeoutMode;
  execute: JobHandler;
}

export type JobContract = Omit<JobDefinition, 'type' | 'execute'> & {
  type?: string;
};
