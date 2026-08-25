import type { JobContext, JobDefinition, JobExecutionResult } from './types.js';

export class JobTimeoutError extends Error {
  override readonly cause?: unknown;

  constructor(
    public readonly type: string,
    public readonly timeoutMs: number,
    public readonly mode: JobDefinition['timeoutMode'],
    cause?: unknown
  ) {
    super(`job ${type} timed out after ${timeoutMs}ms`);
    this.name = 'JobTimeoutError';
    this.cause = cause;
  }
}

/**
 * Provider adapters do not all use the same abort error shape. Keep the
 * worker's cancellation decision in one place instead of teaching each job
 * about DOMException, QqApiError, and provider timeout variants.
 */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown; kind?: unknown; cause?: unknown };
  if (candidate.name === 'AbortError' || candidate.name === 'TimeoutError') return true;
  if (candidate.code === 'ABORT_ERR' || candidate.kind === 'timeout') return true;
  return candidate.cause !== undefined && candidate.cause !== error
    ? isAbortError(candidate.cause, signal)
    : false;
}

export async function executeWithContract(
  definition: JobDefinition,
  payload: Record<string, unknown>,
  context: JobContext
): Promise<JobExecutionResult> {
  if (definition.timeoutMode === 'abort' && !definition.cancellable) {
    throw new Error(`job ${definition.type} uses timeoutMode=abort without cancellable=true`);
  }

  const startedAt = Date.now();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  timer = setTimeout(() => {
    timedOut = true;
    if (definition.timeoutMode === 'abort') context.cancel?.();
    try {
      context.onTimeout?.({
        timeoutMs: definition.timeoutMs,
        mode: definition.timeoutMode,
        elapsedMs: Date.now() - startedAt
      });
    } catch {
      // Slow-job diagnostics must never become a second job failure.
    }
  }, definition.timeoutMs);
  timer.unref?.();

  try {
    // Do not race the handler with a timeout promise. A timeout is a signal
    // or a diagnostic, not permission to detach the handler from its lane.
    await definition.execute(payload, context);
  } catch (error) {
    if (timedOut && definition.timeoutMode === 'abort') {
      throw new JobTimeoutError(definition.type, definition.timeoutMs, definition.timeoutMode, error);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (timedOut && definition.timeoutMode === 'abort') {
    throw new JobTimeoutError(definition.type, definition.timeoutMs, definition.timeoutMode);
  }

  return {
    timedOut,
    timeoutMode: definition.timeoutMode,
    elapsedMs: Date.now() - startedAt
  };
}
