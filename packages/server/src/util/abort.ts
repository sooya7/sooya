/**
 * Abort-signal plumbing shared by the interruptible reply pipeline.
 *
 * Two error types distinguish "the user simply kept typing" (not an error, no
 * logging, no failure card) from real provider failures. Every layer that can
 * be cancelled must preserve the abort reason instead of folding it into a
 * generic timeout.
 */

export class UserInterruptedError extends Error {
  override name = 'UserInterruptedError';
  constructor(message = 'superseded by newer user message') {
    super(message);
  }
}

export class StaleGenerationError extends Error {
  override name = 'StaleGenerationError';
  constructor(message = 'generation revision is stale') {
    super(message);
  }
}

/**
 * Combines several signals into one. The combined signal aborts with the
 * reason of whichever source aborts first, so an external user-interrupt
 * reason survives instead of being rewritten into a timeout.
 */
export function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener(
      'abort',
      () => controller.abort(signal.reason),
      { once: true }
    );
  }
  return controller.signal;
}

/** Sleep that can be interrupted by aborting `signal` (rejects with its reason). */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true }
    );
  });
}

/** True when the error signals a benign cancellation (user interrupt or stale revision). */
export function isBenignAbort(err: unknown): boolean {
  return err instanceof UserInterruptedError || err instanceof StaleGenerationError;
}
