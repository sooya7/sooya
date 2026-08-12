import { describe, expect, it } from 'vitest';
import { McpConnection } from './connection.js';
import type { McpClientLike, McpServerConfig } from './types.js';

function config(id: string): McpServerConfig {
  return { id, enabled: true, transport: 'streamable-http', url: `http://${id}.test/mcp`, auth: { type: 'none' }, required: false, connectTimeoutMs: 1000, toolTimeoutMs: 1000 };
}

function fakeClient(): McpClientLike {
  return {
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => ({ tools: [{ name: 'breath', description: 'read', inputSchema: { type: 'object' } }] }),
    callTool: async ({ name }) => ({ content: [{ type: 'text', text: `${name}:ok` }] })
  };
}

describe('McpConnection', () => {
  it('connects, lists tools, calls a tool and exposes safe health state', async () => {
    const connection = new McpConnection(config('ombre'), { clientFactory: async () => ({ client: fakeClient() }) });
    await connection.connect();
    expect(connection.tools()).toHaveLength(1);
    expect((await connection.callTool('breath', {})).content?.[0]?.text).toBe('breath:ok');
    expect(connection.snapshot()).toMatchObject({ id: 'ombre', state: 'ready', toolCount: 1 });
    await connection.close();
    expect(connection.snapshot().state).toBe('closed');
  });

  it('does not connect when required auth is missing', async () => {
    const connection = new McpConnection({ ...config('ombre'), auth: { type: 'bearer-env', env: 'MISSING_OMBRE_TOKEN' } }, { env: {} });
    await expect(connection.connect()).rejects.toThrow('missing MISSING_OMBRE_TOKEN');
    expect(connection.snapshot().state).toBe('degraded');
  });
});
