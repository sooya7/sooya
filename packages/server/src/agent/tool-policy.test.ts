import { describe, expect, it } from 'vitest';
import { ToolRegistry, type ToolDescriptor } from './registry.js';
import { ToolPolicy } from './tool-policy.js';

function tool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: 'ombre.breath',
    modelName: 'ombre__breath',
    description: 'Surface memory.',
    inputSchema: { type: 'object' },
    source: 'mcp',
    serverId: 'ombre',
    risk: 'read',
    phases: ['reply', 'proactive'],
    authorized: true,
    handler: async () => 'ok',
    ...overrides
  };
}

describe('ToolPolicy', () => {
  it('only exposes explicitly authorized tools in the model-facing phase list', () => {
    const registry = new ToolRegistry();
    registry.register(tool());
    registry.register(tool({ name: 'ombre.future', modelName: 'ombre__future', authorized: false }));
    const policy = new ToolPolicy(registry);
    expect(policy.definitions('reply').map((item) => item.name)).toEqual(['ombre__breath']);
    expect(policy.check(registry.require('ombre.future'), 'reply')).toMatchObject({ allowed: false, reason: 'tool-not-authorized' });
  });

  it('keeps writes out of reply/proactive and permits them in memory_commit', () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: 'ombre.hold', modelName: 'ombre__hold', risk: 'write', phases: ['memory_commit'] }));
    const policy = new ToolPolicy(registry);
    const hold = registry.require('ombre.hold');
    expect(policy.check(hold, 'reply').allowed).toBe(false);
    expect(policy.check(hold, 'proactive').allowed).toBe(false);
    expect(policy.check(hold, 'memory_commit').allowed).toBe(true);
  });

  it('allows explicitly classified memory reads during memory_commit', () => {
    const registry = new ToolRegistry();
    registry.register(tool({ phases: ['reply', 'proactive', 'memory_commit'] }));
    const policy = new ToolPolicy(registry);
    expect(policy.check(registry.require('ombre.breath'), 'memory_commit')).toEqual({ allowed: true });
  });

  it('isolates server-specific switches from other MCP servers', () => {
    const registry = new ToolRegistry();
    registry.register(tool());
    registry.register(tool({ name: 'github.search', modelName: 'github__search', serverId: 'github' }));
    const policy = new ToolPolicy(registry, { serverPolicies: { ombre: { readEnabled: false } } });
    expect(policy.check(registry.require('ombre.breath'), 'reply')).toMatchObject({ allowed: false, reason: 'read-disabled' });
    expect(policy.check(registry.require('github.search'), 'reply')).toEqual({ allowed: true });
  });

  it('can disable read or write capability without hiding the whole app', () => {
    const registry = new ToolRegistry();
    registry.register(tool());
    registry.register(tool({ name: 'ombre.hold', modelName: 'ombre__hold', risk: 'write', phases: ['memory_commit'] }));
    const policy = new ToolPolicy(registry, { readEnabled: false, writeEnabled: false });
    expect(policy.definitions('reply')).toEqual([]);
    expect(policy.check(registry.require('ombre.hold'), 'memory_commit')).toMatchObject({ allowed: false, reason: 'write-disabled' });
  });
});
