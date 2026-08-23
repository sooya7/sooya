import { expect } from 'vitest';
import type { Commitment } from '../../src/core/future/types.js';

/** Shared long-horizon assertions; each returns a short metric name/value pair. */
export function expectSingleCommitment(list: Commitment[]): Commitment {
  expect(list).toHaveLength(1);
  return list[0]!;
}

export function expectStatus(c: Commitment | undefined, status: Commitment['status']): void {
  expect(c, `commitment ${c?.id ?? '?'} status`).toBeDefined();
  expect(c!.status).toBe(status);
}

export function expectContextMentions(app: { services: { futureContext: { contextLines(): string[] } } }, substring: string, times = 1): void {
  const hits = app.services.futureContext.contextLines().filter((line) => line.includes(substring));
  expect(hits, `future context lines mentioning "${substring}"`).toHaveLength(times);
}
