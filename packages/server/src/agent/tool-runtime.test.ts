import { describe, expect, it } from 'vitest';
import type { ChatProvider, ChatRequest, ChatResult } from '../providers/types.js';
import { byteLength } from './tool-history.js';
import { ToolRegistry, type ToolDescriptor } from './registry.js';
import { ToolPolicy } from './tool-policy.js';
import { ToolCallRuntime } from './tool-runtime.js';

function provider(results: ChatResult[], supportsTools = true): ChatProvider {
  let index = 0;
  return {
    name: 'fake',
    configured: true,
    supportsTools,
    complete: async (_request: ChatRequest) => results[Math.min(index++, results.length - 1)]!,
    stream: async () => ({ text: 'final', model: 'fake' }),
    inspectHealth: async () => ({ capability: 'chat', configured: true, ok: true, provider: 'fake', checkedAt: new Date().toISOString() })
  };
}

function tool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: 'ombre.breath',
    modelName: 'ombre__breath',
    description: 'Read memory.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    source: 'mcp',
    serverId: 'ombre',
    risk: 'read',
    phases: ['reply'],
    authorized: true,
    handler: async (input) => ({ echoed: input }),
    ...overrides
  };
}

describe('ToolCallRuntime', () => {
  it('executes read calls and returns provider-neutral history for final streaming', async () => {
    const registry = new ToolRegistry();
    registry.register(tool());
    const runtime = new ToolCallRuntime({ registry, policy: new ToolPolicy(registry), maxRounds: 2, maxCallsPerRound: 4 });
    const prepared = await runtime.prepare(provider([
      { text: '', model: 'fake', toolCalls: [{ id: 'c1', name: 'ombre__breath', arguments: { query: '考试' } }] },
      { text: 'ignored planning text', model: 'fake' }
    ]), { messages: [{ role: 'user', content: [{ type: 'text', text: '你记得什么？' }] }] }, { phase: 'reply' });
    expect(prepared.messages.map((turn) => turn.role)).toEqual(['user', 'assistant_tool_call', 'tool_result']);
    expect(prepared.messages[2]).toMatchObject({ role: 'tool_result', name: 'ombre.breath', content: '{"echoed":{"query":"考试"}}' });
    expect(prepared.tools).toBeUndefined();
  });

  it('runs same-round reads in parallel, but does not expose unauthorized calls', async () => {
    const order: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool({
      name: 'ombre.one', modelName: 'ombre__one', handler: async () => { order.push('one'); await new Promise((resolve) => setTimeout(resolve, 5)); return 'one'; }
    }));
    registry.register(tool({
      name: 'ombre.two', modelName: 'ombre__two', handler: async () => { order.push('two'); return 'two'; }
    }));
    registry.register(tool({ name: 'ombre.unknown', modelName: 'ombre__unknown', authorized: false }));
    const runtime = new ToolCallRuntime({ registry, policy: new ToolPolicy(registry), maxRounds: 1, maxCallsPerRound: 4 });
    const prepared = await runtime.prepare(provider([{ text: '', model: 'fake', toolCalls: [
      { id: 'c1', name: 'ombre__one', arguments: { query: '1' } },
      { id: 'c2', name: 'ombre__two', arguments: { query: '2' } },
      { id: 'c3', name: 'ombre__unknown', arguments: { query: '3' } }
    ] }]), { messages: [{ role: 'user', content: [{ type: 'text', text: '查一下' }] }] }, { phase: 'reply' });
    expect(order).toEqual(['one', 'two']);
    expect(prepared.messages.at(-1)).toMatchObject({ role: 'tool_result', callId: 'c3', isError: true });
  });

  it('degrades without tools when provider advertises supportsTools=false', async () => {
    const registry = new ToolRegistry();
    registry.register(tool());
    const runtime = new ToolCallRuntime({ registry, policy: new ToolPolicy(registry) });
    const prepared = await runtime.prepare(provider([{ text: '', model: 'fake', toolCalls: [{ id: 'c1', name: 'ombre__breath', arguments: {} }] }], false), { messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] }, { phase: 'reply' });
    expect(prepared.messages).toHaveLength(1);
    expect(prepared.tools).toBeUndefined();
    expect(prepared.degradedReason).toBe('provider-tools-unsupported');
  });

  it('enforces the total tool-result byte budget across parallel calls', async () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: 'ombre.one', modelName: 'ombre__one', handler: async () => 'x'.repeat(1_000) }));
    registry.register(tool({ name: 'ombre.two', modelName: 'ombre__two', handler: async () => 'y'.repeat(1_000) }));
    const runtime = new ToolCallRuntime({
      registry,
      policy: new ToolPolicy(registry),
      maxRounds: 1,
      resultMaxBytes: 512,
      totalResultMaxBytes: 768
    });
    const prepared = await runtime.prepare(provider([{ text: '', model: 'fake', toolCalls: [
      { id: 'c1', name: 'ombre__one', arguments: { query: '1' } },
      { id: 'c2', name: 'ombre__two', arguments: { query: '2' } }
    ] }]), { messages: [{ role: 'user', content: [{ type: 'text', text: 'limit' }] }] }, { phase: 'reply' });
    const results = prepared.messages.filter((turn) => turn.role === 'tool_result');
    const bytes = results.reduce((total, turn) => total + byteLength(turn.content), 0);
    expect(bytes).toBeLessThanOrEqual(768);
    expect(results[1]?.content).toContain('total result limit reached');
  });
});
