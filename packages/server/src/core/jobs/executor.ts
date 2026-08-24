import type { JobContext, JobDefinition } from './types.js';

export class JobTimeoutError extends Error {
  constructor(public readonly type: string, public readonly timeoutMs: number) {
    super(`job ${type} timed out after ${timeoutMs}ms`);
    this.name = 'JobTimeoutError';
  }
}

export async function executeWithContract(
  definition: JobDefinition,
  payload: Record<string, unknown>,
  context: JobContext
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const task = definition.execute(payload, context);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (definition.cancellable) context.cancel?.();
      reject(new JobTimeoutError(definition.type, definition.timeoutMs));
    }, definition.timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
