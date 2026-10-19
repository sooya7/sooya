import { describe, expect, it } from 'vitest';
import { McpConnection } from './connection.js';
import { createPostJsonRpcClient } from './post-client.js';
import { loadMcpConfig } from './config.js';
import type { McpServerConfig } from './types.js';

const config: McpServerConfig = {
  id: 'srv', enabled: true, transport: 'post-jsonrpc', url: 'http://127.0.0.1:18201/mcp',
  auth: { type: 'none' }, required: false, connectTimeoutMs: 1000, toolTimeoutMs: 1000
};

/** Behaves like srv-bridge: every message must be a request with an id, one JSON reply each. */
function bridge() {
  const seen: Array<{ method: string; id: unknown; auth: string | null }> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const message = JSON.parse(String(init?.body)) as { id?: unknown; method: string; params?: Record<string, unknown> };
    seen.push({ method: message.method, id: message.id, auth: new Headers(init?.headers).get('authorization') });
    if (message.id === undefined) return new Promise<Response>(() => undefined); // the real bridge hangs here
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } });
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    if (message.method === 'tools/list') return reply({ tools: [{ name: 'system_uptime', inputSchema: { type: 'object' } }] });
    if (message.method === 'tools/call' && message.params?.name === 'slow') return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'up 1 day' }], structuredContent: { result: 'up 1 day' } });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe('post-jsonrpc MCP client', () => {
  it('connects, lists and calls tools with requests only (never a notification)', async () => {
    const { seen, fetchImpl } = bridge();
    const connection = new McpConnection(config, {
      clientFactory: async (cfg) => ({ client: createPostJsonRpcClient(cfg, { authorization: 'Bearer t0k' }, fetchImpl) })
    });
    await connection.connect();
    expect(connection.snapshot()).toMatchObject({ state: 'ready', toolCount: 1 });
    const result = await connection.callTool('system_uptime', {});
    expect(result.content?.[0]).toMatchObject({ text: 'up 1 day' });
    expect(seen.map((item) => item.method)).toEqual(['initialize', 'tools/list', 'tools/call']);
    expect(seen.every((item) => item.id !== undefined && item.auth === 'Bearer t0k')).toBe(true);
  });

  it('aborting a call just drops the HTTP request (no cancelled notification)', async () => {
    const { seen, fetchImpl } = bridge();
    const client = createPostJsonRpcClient(config, {}, fetchImpl);
    const controller = new AbortController();
    const pending = client.callTool({ name: 'slow', arguments: {} }, undefined, { signal: controller.signal });
    controller.abort(new Error('reply superseded'));
    await expect(pending).rejects.toThrow('reply superseded');
    expect(seen.some((item) => item.method.startsWith('notifications/'))).toBe(false);
  });

  it('surfaces JSON-RPC and HTTP errors, and times out', async () => {
    const { fetchImpl } = bridge();
    const client = createPostJsonRpcClient(config, {}, fetchImpl);
    await expect(client.connect(undefined)).resolves.toBeUndefined();
    const unauthorized = createPostJsonRpcClient(config, {}, (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as typeof fetch);
    await expect(unauthorized.listTools()).rejects.toThrow('MCP HTTP 401');
    await expect(client.callTool({ name: 'slow' }, undefined, { timeout: 20 })).rejects.toThrow(/timed out after 20ms/);
  });

  it('is selected by "transport": "post-jsonrpc" in mcp.json', async () => {
    const fs = await import('node:fs/promises');
    const file = `${process.cwd()}/.tmp-mcp-post-${Date.now()}.json`;
    await fs.writeFile(file, JSON.stringify({ servers: { srv: { transport: 'post-jsonrpc', url: 'http://127.0.0.1:18201/mcp' }, other: { transport: 'weird', url: 'http://x/mcp' } } }), 'utf8');
    try {
      const servers = loadMcpConfig(file, {}).servers;
      expect(servers.srv!.transport).toBe('post-jsonrpc');
      expect(servers.other!.transport).toBe('streamable-http');
    } finally {
      await fs.unlink(file);
    }
  });
});
