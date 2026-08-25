export type JobLane = 'critical' | 'background' | 'autonomous' | 'maintenance';
export type JobTimeoutMode = 'abort' | 'observe';

export interface JobSlowInfo {
  jobId: string;
  type: string;
  lane: JobLane;
  timeoutMs: number;
  elapsedMs: number;
}

export interface JobContext {
  jobId: string;
  type: string;
  lane: JobLane;
  attempt: number;
  signal: AbortSignal;
  /** Called by the executor when a cancellable job exceeds its contract timeout. */
  cancel?: () => void;
  /** Diagnostic hook; it must not change the job outcome or release its lane. */
  onTimeout?: (notice: { timeoutMs: number; mode: JobTimeoutMode; elapsedMs: number }) => void;
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

export interface JobExecutionResult {
  timedOut: boolean;
  timeoutMode: JobTimeoutMode;
  elapsedMs: number;
}

export type JobContract = Omit<JobDefinition, 'type' | 'execute'> & {
  type?: string;
};
