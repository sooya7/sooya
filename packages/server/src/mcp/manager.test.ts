import { describe, expect, it } from 'vitest';
import { McpManager } from './manager.js';
import type { McpClientLike, McpServerConfig } from './types.js';
import { ToolPolicy } from '../agent/tool-policy.js';
import { ToolRegistry } from '../agent/registry.js';

function cfg(id: string): McpServerConfig {
  return { id, enabled: true, transport: 'streamable-http', url: `http://${id}.test/mcp`, auth: { type: 'none' }, required: false, connectTimeoutMs: 1000, toolTimeoutMs: 1000 };
}

function client(id: string): McpClientLike {
  return {
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => ({ tools: [{ name: 'breath', description: `${id} read`, inputSchema: { type: 'object' } }] }),
    callTool: async () => ({ content: [{ type: 'text', text: `${id}:ok` }] })
  };
}

describe('McpManager', () => {
  it('isolates server failures and namespaces same-named tools', async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager({
      servers: [cfg('ombre'), cfg('github')],
      registry,
      clientFactory: async (config) => {
        if (config.id === 'github') throw new Error('github unavailable');
        return { client: client('ombre') };
      }
    });
    await manager.connectAllBestEffort();
    expect(registry.get('ombre.breath')).toBeDefined();
    expect(registry.get('github.breath')).toBeUndefined();
    expect(manager.health().find((item) => item.id === 'ombre')).toMatchObject({ state: 'ready', toolCount: 1 });
    expect(manager.health().find((item) => item.id === 'github')).toMatchObject({ state: 'degraded' });
    const policy = new ToolPolicy(registry);
    expect(policy.definitions('reply').map((item) => item.name)).toEqual(['ombre__breath']);
  });
});
