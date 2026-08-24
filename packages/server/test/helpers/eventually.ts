import { expect } from 'vitest';

export async function eventually(check: () => unknown | Promise<unknown>, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) throw lastError;
  expect.fail('eventually timed out');
}
