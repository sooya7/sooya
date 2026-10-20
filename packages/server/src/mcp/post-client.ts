/**
 * Minimal MCP client for a plain "POST one JSON-RPC message, get one JSON
 * reply" bridge (srv-mcp-bridge in front of a stdio server).
 *
 * The SDK's streamable-http client cannot be used there: it sends
 * notifications (`notifications/initialized` on connect, `notifications/
 * cancelled` on abort), and that bridge waits for a reply to every message it
 * forwards; a notification never gets one, so the bridge would hold its lock
 * forever. This client only ever sends requests, and an abort just drops the
 * HTTP request.
 */
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { McpClientLike, McpRemoteTool, McpServerConfig, McpToolCallResult } from './types.js';

const PROTOCOL_VERSION = '2025-06-18';

class McpPostError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function createPostJsonRpcClient(config: McpServerConfig, headers: Record<string, string>, fetchImpl: typeof fetch = fetch): McpClientLike {
  let nextId = 1;
  const rpc = async (method: string, params: Record<string, unknown> | undefined, options?: RequestOptions): Promise<unknown> => {
    const controller = new AbortController();
    const timeoutMs = options?.timeout ?? config.toolTimeoutMs;
    const timer = setTimeout(() => controller.abort(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => controller.abort(options?.signal?.reason);
    if (options?.signal?.aborted) onAbort();
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
        signal: controller.signal
      });
      if (!response.ok) throw new McpPostError(`MCP HTTP ${response.status}`, response.status);
      const reply = await response.json() as { result?: unknown; error?: { code?: number; message?: string } };
      if (reply.error) throw new McpPostError(`MCP error ${reply.error.code ?? ''}: ${reply.error.message ?? 'unknown'}`.trim());
      return reply.result;
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onAbort);
    }
  };

  return {
    connect: async (_transport, options) => {
      await rpc('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'sooya-mcp-host', version: '1.0.0' }
      }, options);
    },
    close: async () => undefined,
    listTools: async (params, options) => {
      const result = await rpc('tools/list', params?.cursor ? { cursor: params.cursor } : undefined, options) as { tools?: McpRemoteTool[]; nextCursor?: string } | undefined;
      return { tools: Array.isArray(result?.tools) ? result.tools : [], ...(result?.nextCursor ? { nextCursor: result.nextCursor } : {}) };
    },
    callTool: async (params, _schema, options) => {
      const result = await rpc('tools/call', { name: params.name, arguments: params.arguments ?? {} }, options);
      return (result && typeof result === 'object' ? result : { content: [] }) as McpToolCallResult;
    }
  };
}
