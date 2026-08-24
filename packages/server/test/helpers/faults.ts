/** Small deterministic fault primitives shared by contract tests. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function abortableBlock(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
  });
}

export function timeoutError(message = 'provider timeout'): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

export function failureResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
