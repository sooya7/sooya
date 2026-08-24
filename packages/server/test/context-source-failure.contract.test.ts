import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (harness) await harness.cleanup();
  harness = null;
});

const options = {
  recentMessages: 10,
  memoryLimit: 8,
  allowVision: false,
  voiceMoods: '',
  capabilityNotes: [],
  contextWindow: 8_000,
  maxOutputTokens: 1_000
};

describe('ContextSourcePipeline failure isolation', () => {
  it.each([
    ['future', 'futureContext', 'contextLines'],
    ['relationship', 'relationshipContext', 'contextLines'],
    ['life', 'life', 'contextLines'],
    ['world', 'world', 'snapshot']
  ] as const)('%s source failure does not make buildContext fail or call legacy fallback', async (_id, service, method) => {
    harness = await createHarness({ startWorkers: false });
    const target = harness.app.services[service] as Record<string, unknown>;
    const spy = vi.spyOn(target as never, method as never).mockImplementation(() => {
      throw new Error(`${_id} source unavailable`);
    });

    const built = await harness.app.services.context.build(
      harness.app.config.getPersona(),
      '继续聊聊',
      options
    );

    expect(built).toBeTruthy();
    expect(built.system).not.toContain('source unavailable');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
