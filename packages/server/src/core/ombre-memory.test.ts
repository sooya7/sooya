import { describe, expect, it } from 'vitest';
import { OmbreMemoryBridge } from './ombre-memory.js';

describe('OmbreMemoryBridge', () => {
  it('does not write a second time after a completed receipt', async () => {
    let calls = 0;
    const bridge = new OmbreMemoryBridge({
      manager: { health: () => [{ id: 'ombre', enabled: true, state: 'ready', toolCount: 1 }], getConnection: () => undefined } as never,
      registry: { get: () => undefined } as never,
      policy: { check: () => ({ allowed: false }) } as never,
      runtime: {} as never,
      commits: {
        get: () => ({ batch_id: 'b', revision: 1, state: 'completed', started_at: null, completed_at: null, detail_json: '{}' }),
        start: () => { calls += 1; throw new Error('must not start completed receipt'); },
        mark: () => { throw new Error('must not mark completed receipt'); }
      } as never,
      chatProvider: () => { throw new Error('must not create provider'); }
    });
    await expect(bridge.commit({ batchId: 'b', revision: 1, userText: 'x', assistantText: 'y' })).resolves.toEqual({ state: 'completed', callsExecuted: 0, rounds: 0 });
    expect(calls).toBe(0);
  });
});
