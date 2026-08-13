import { afterEach, describe, expect, it, vi } from 'vitest';
import { OmbreMemoryBridge } from './ombre-memory.js';

afterEach(() => vi.useRealTimers());

function wakeBridge(handler: () => Promise<unknown> = async () => 'wake'): { bridge: OmbreMemoryBridge; calls: { wake: number } } {
  const calls = { wake: 0 };
  const tool = { handler: async () => { calls.wake += 1; return handler(); } };
  const bridge = new OmbreMemoryBridge({
    manager: { health: () => [{ id: 'ombre', enabled: true, state: 'ready', toolCount: 1 }], getConnection: () => undefined } as never,
    registry: { get: (name: string) => name === 'ombre.breath' ? tool : undefined } as never,
    policy: { check: () => ({ allowed: true }) } as never,
    runtime: {} as never,
    commits: {} as never,
    chatProvider: {} as never
  });
  return { bridge, calls };
}

describe('OmbreMemoryBridge', () => {
  it('wakes once with no history, then respects the local idle guard', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-12T00:00:00.000Z') });
    const { bridge, calls } = wakeBridge();

    await expect(bridge.wakeIfNeeded()).resolves.toBe('wake');
    await expect(bridge.wakeIfNeeded()).resolves.toBeNull();
    vi.advanceTimersByTime(29 * 60_000);
    await expect(bridge.wakeIfNeeded()).resolves.toBeNull();
    vi.advanceTimersByTime(2 * 60_000);
    await expect(bridge.wakeIfNeeded()).resolves.toBe('wake');
    expect(calls.wake).toBe(2);
  });

  it('does not wake while the previous interaction is still recent', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-12T00:31:00.000Z') });
    const { bridge, calls } = wakeBridge();

    await expect(bridge.wakeIfNeeded(new Date('2026-08-12T00:10:00.000Z'))).resolves.toBeNull();
    await expect(bridge.wakeIfNeeded(new Date('2026-08-12T00:00:00.000Z'))).resolves.toBe('wake');
    expect(calls.wake).toBe(1);
  });

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

  it('reconciles an uncertain receipt from an exact source marker before writing again', async () => {
    let searchArgs: Record<string, unknown> | undefined;
    let marked: Record<string, unknown> | undefined;
    const bridge = new OmbreMemoryBridge({
      manager: { health: () => [], getConnection: () => undefined } as never,
      registry: {
        get: (name: string) => name === 'ombre.breath_search'
          ? { handler: async (input: Record<string, unknown>) => { searchArgs = input; return 'found sooya:batch-7:2'; } }
          : undefined
      } as never,
      policy: { check: () => ({ allowed: true }) } as never,
      runtime: { prepare: async () => { throw new Error('must not run commit model'); } } as never,
      commits: {
        get: () => ({ batch_id: 'batch-7', revision: 2, state: 'uncertain', started_at: null, completed_at: null, detail_json: '{}' }),
        mark: (_batchId: string, _revision: number, state: string, detail: Record<string, unknown>) => {
          expect(state).toBe('completed');
          marked = detail;
          return {};
        },
        start: () => { throw new Error('must not start after an exact hit'); },
        hasCompletedSince: () => false
      } as never,
      chatProvider: {} as never
    });

    await expect(bridge.commit({ batchId: 'batch-7', revision: 2, userText: 'x', assistantText: 'y' })).resolves.toEqual({
      state: 'completed', callsExecuted: 0, rounds: 0
    });
    expect(searchArgs).toEqual({ query: 'sooya:batch-7:2' });
    expect(marked).toMatchObject({ recovered: true, sourceMarker: 'sooya:batch-7:2' });
  });

  it('keeps an uncertain receipt when the marker cannot prove the remote write', async () => {
    let started = 0;
    const bridge = new OmbreMemoryBridge({
      manager: { health: () => [], getConnection: () => undefined } as never,
      registry: { get: (name: string) => name === 'ombre.breath_search' ? { handler: async () => 'ordinary result' } : undefined } as never,
      policy: { check: () => ({ allowed: true }) } as never,
      runtime: { prepare: async () => { throw new Error('must not write automatically'); } } as never,
      commits: {
        get: () => ({ batch_id: 'batch-8', revision: 1, state: 'uncertain', started_at: null, completed_at: null, detail_json: '{}' }),
        start: () => { started += 1; throw new Error('automatic retry must not start'); },
        mark: () => { throw new Error('automatic retry must not mark'); }
      } as never,
      chatProvider: {} as never
    });

    await expect(bridge.commit({ batchId: 'batch-8', revision: 1, userText: 'x', assistantText: 'y' })).resolves.toEqual({
      state: 'uncertain', callsExecuted: 0, rounds: 0
    });
    expect(started).toBe(0);
  });

  it('allows only an explicit retry to pass an unproven receipt through the writer', async () => {
    let prepared = 0;
    const bridge = new OmbreMemoryBridge({
      manager: { health: () => [], getConnection: () => undefined } as never,
      registry: { get: (name: string) => name === 'ombre.breath_search' ? { handler: async () => 'ordinary result' } : undefined } as never,
      policy: { check: () => ({ allowed: true }) } as never,
      runtime: { prepare: async () => { prepared += 1; return { rounds: 1, callsExecuted: 1, exhausted: false }; } } as never,
      commits: {
        get: () => ({ batch_id: 'batch-9', revision: 1, state: 'uncertain', started_at: null, completed_at: null, detail_json: '{}' }),
        start: () => ({ state: 'running' }),
        mark: (_batchId: string, _revision: number, state: string) => { expect(state).toBe('completed'); return {}; }
      } as never,
      chatProvider: () => ({ configured: true, supportsTools: true } as never)
    });
    await expect(bridge.commit({ batchId: 'batch-9', revision: 1, userText: 'x', assistantText: 'y', allowUncertainRetry: true })).resolves.toMatchObject({ state: 'completed' });
    expect(prepared).toBe(1);
  });

  it('marks a zero-tool-call commit as skipped instead of completed', async () => {
    let markState: string | undefined;
    let markDetail: Record<string, unknown> | undefined;
    const bridge = new OmbreMemoryBridge({
      manager: { health: () => [], getConnection: () => undefined } as never,
      registry: { get: () => undefined } as never,
      policy: { check: () => ({ allowed: true }) } as never,
      runtime: { prepare: async () => ({ rounds: 0, callsExecuted: 0, succeededCalls: 0, failedCalls: 0, exhausted: false }) } as never,
      commits: {
        get: () => undefined,
        start: () => ({ state: 'running' }),
        mark: (_batchId: string, _revision: number, state: string, detail: Record<string, unknown>) => { markState = state; markDetail = detail; return {}; }
      } as never,
      chatProvider: () => ({ configured: true, supportsTools: true } as never)
    });

    const result = await bridge.commit({ batchId: 'batch-zero', revision: 1, userText: '我喜欢猫', assistantText: '记住了' });
    expect(result).toMatchObject({ state: 'skipped', callsExecuted: 0, succeededCalls: 0, failedCalls: 0 });
    expect(markState).toBe('skipped');
    expect(markDetail).toMatchObject({ reason: 'no_tool_call', callsExecuted: 0, succeededCalls: 0 });
  });

  it('keeps an all-failed commit uncertain, never completed', async () => {
    let markState: string | undefined;
    const bridge = new OmbreMemoryBridge({
      manager: { health: () => [], getConnection: () => undefined } as never,
      registry: { get: () => undefined } as never,
      policy: { check: () => ({ allowed: true }) } as never,
      runtime: { prepare: async () => ({ rounds: 1, callsExecuted: 2, succeededCalls: 0, failedCalls: 2, exhausted: false }) } as never,
      commits: {
        get: () => undefined,
        start: () => ({ state: 'running' }),
        mark: (_batchId: string, _revision: number, state: string) => { markState = state; return {}; }
      } as never,
      chatProvider: () => ({ configured: true, supportsTools: true } as never)
    });

    const result = await bridge.commit({ batchId: 'batch-fail', revision: 1, userText: 'x', assistantText: 'y' });
    expect(result).toMatchObject({ state: 'uncertain', callsExecuted: 2, succeededCalls: 0, failedCalls: 2 });
    expect(markState).toBe('uncertain');
  });

  it('marks completed only when at least one call succeeded and never records secrets', async () => {
    let markState: string | undefined;
    let markDetail: Record<string, unknown> | undefined;
    const bridge = new OmbreMemoryBridge({
      manager: { health: () => [], getConnection: () => undefined } as never,
      registry: { get: () => undefined } as never,
      policy: { check: () => ({ allowed: true }) } as never,
      runtime: { prepare: async () => ({ rounds: 1, callsExecuted: 2, succeededCalls: 1, failedCalls: 1, exhausted: false }) } as never,
      commits: {
        get: () => undefined,
        start: () => ({ state: 'running' }),
        mark: (_batchId: string, _revision: number, state: string, detail: Record<string, unknown>) => { markState = state; markDetail = detail; return {}; }
      } as never,
      chatProvider: () => ({ configured: true, supportsTools: true } as never)
    });

    const result = await bridge.commit({ batchId: 'batch-ok', revision: 1, userText: 'x', assistantText: 'y' });
    expect(result).toMatchObject({ state: 'completed', callsExecuted: 2, succeededCalls: 1, failedCalls: 1 });
    expect(markState).toBe('completed');
    expect(markDetail).toMatchObject({ succeededCalls: 1, failedCalls: 1, protocol: { providerTools: true, degradedReason: null } });
    // Sanitized detail: numeric counters and protocol flags only, no payloads or credentials.
    expect(JSON.stringify(markDetail)).not.toContain('api');
    expect(JSON.stringify(markDetail)).not.toContain('key');
  });
});
