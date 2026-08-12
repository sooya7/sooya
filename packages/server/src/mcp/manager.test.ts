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

  it('reconnects once and retries a transport failure through bridged tools', async () => {
    let factoryCalls = 0;
    const registry = new ToolRegistry();
    const manager = new McpManager({
      servers: [cfg('ombre')],
      registry,
      clientFactory: async () => {
        factoryCalls += 1;
        if (factoryCalls === 1) {
          return { client: { ...client('first'), callTool: async () => { throw new Error('transport closed'); } } };
        }
        return { client: client('reconnected') };
      }
    });
    await manager.connectAllBestEffort();

    const result = await registry.require('ombre.breath').handler({}, { phase: 'reply' });
    expect(result).toMatchObject({ value: 'reconnected:ok' });
    expect(factoryCalls).toBe(2);
  });

  it('does not reconnect an authentication or parameter failure', async () => {
    let factoryCalls = 0;
    const manager = new McpManager({
      servers: [cfg('ombre')],
      registry: new ToolRegistry(),
      clientFactory: async () => {
        factoryCalls += 1;
        return {
          client: {
            ...client('ombre'),
            callTool: async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }); }
          }
        };
      }
    });
    await manager.connectAllBestEffort();
    await expect(manager.callTool('ombre', 'breath', {})).rejects.toThrow('unauthorized');
    expect(factoryCalls).toBe(1);
  });

  it('fails startup when an enabled required server is not ready', async () => {
    const required = { ...cfg('required'), required: true };
    const manager = new McpManager({
      servers: [required],
      registry: new ToolRegistry(),
      clientFactory: async () => { throw new Error('connection refused'); }
    });
    await expect(manager.connectAllBestEffort()).rejects.toThrow(/required MCP server required/u);
  });
});
