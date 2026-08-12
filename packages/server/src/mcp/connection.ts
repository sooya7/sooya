import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveMcpAuth, redactMcpError } from './auth.js';
import type {
  McpClientFactory,
  McpClientLike,
  McpConnectionSnapshot,
  McpRemoteTool,
  McpServerConfig,
  McpToolCallResult,
} from './types.js';

export interface McpConnectionOptions {
  env?: NodeJS.ProcessEnv;
  clientFactory?: McpClientFactory;
}

export class McpConnection {
  private client: McpClientLike | null = null;
  private sessionClose: (() => Promise<void>) | null = null;
  private remoteTools: McpRemoteTool[] = [];
  private state: McpConnectionSnapshot['state'];
  private lastError: string | undefined;
  private latencyMs: number | undefined;
  private lastConnectedAt: string | undefined;
  private lastRefreshAt: string | undefined;

  constructor(
    readonly config: McpServerConfig,
    private readonly options: McpConnectionOptions = {}
  ) {
    this.state = config.enabled ? 'closed' : 'disabled';
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      this.state = 'disabled';
      return;
    }
    await this.closeActive();
    this.state = 'connecting';
    this.lastError = undefined;
    const auth = resolveMcpAuth(this.config, this.options.env);
    if (!auth.configured) {
      this.state = 'degraded';
      this.lastError = auth.reason;
      throw new Error(auth.reason ?? 'MCP authentication is not configured');
    }
    const started = Date.now();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`MCP connection timed out after ${this.config.connectTimeoutMs}ms`)), this.config.connectTimeoutMs);
    try {
      const factory = this.options.clientFactory ?? defaultClientFactory;
      const session = await factory(this.config, auth.headers);
      this.client = session.client;
      this.sessionClose = session.close ?? null;
      await this.client.connect(session.transport, { signal: timeout.signal, timeout: this.config.connectTimeoutMs });
      await this.refreshTools();
      this.state = 'ready';
      this.latencyMs = Date.now() - started;
      this.lastConnectedAt = new Date().toISOString();
    } catch (error) {
      this.state = 'degraded';
      this.lastError = redactMcpError(error);
      await this.closeActive();
      throw new Error(this.lastError);
    } finally {
      clearTimeout(timer);
    }
  }

  async refreshTools(): Promise<McpRemoteTool[]> {
    if (!this.client) throw new Error(`MCP server ${this.config.id} is not connected`);
    const tools: McpRemoteTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.client.listTools(cursor ? { cursor } : undefined, { timeout: this.config.toolTimeoutMs });
      tools.push(...result.tools);
      if (!result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    this.remoteTools = tools;
    this.lastRefreshAt = new Date().toISOString();
    return this.tools();
  }

  async test(): Promise<McpConnectionSnapshot> {
    if (this.state !== 'ready') await this.connect();
    await this.refreshTools();
    return this.snapshot();
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> {
    if (!this.client || this.state !== 'ready') throw new Error(`MCP server ${this.config.id} is unavailable`);
    if (signal?.aborted) throw signal.reason ?? new Error('MCP tool call aborted');
    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout: this.config.toolTimeoutMs
    });
    return result;
  }

  tools(): McpRemoteTool[] {
    return this.remoteTools.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
  }

  snapshot(): McpConnectionSnapshot {
    return {
      id: this.config.id,
      enabled: this.config.enabled,
      state: this.state,
      toolCount: this.remoteTools.length,
      ...(this.latencyMs === undefined ? {} : { latencyMs: this.latencyMs }),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.lastRefreshAt ? { lastRefreshAt: this.lastRefreshAt } : {})
    };
  }

  async close(): Promise<void> {
    await this.closeActive();
    if (this.config.enabled) this.state = 'closed';
  }

  private async closeActive(): Promise<void> {
    const client = this.client;
    const sessionClose = this.sessionClose;
    this.client = null;
    this.sessionClose = null;
    if (sessionClose) {
      try { await sessionClose(); } catch { /* best effort */ }
    }
    if (client) {
      try { await client.close(); } catch { /* best effort */ }
    }
  }
}

const defaultClientFactory: McpClientFactory = async (config, headers) => {
  const client = new Client({ name: 'sooya-mcp-host', version: '1.0.0' });
  const requestInit: RequestInit | undefined = Object.keys(headers).length > 0 ? { headers } : undefined;
  const url = new URL(config.url);
  const transport = config.transport === 'sse'
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, {
        requestInit,
        reconnectionOptions: { initialReconnectionDelay: 250, maxReconnectionDelay: 2000, reconnectionDelayGrowFactor: 1.5, maxRetries: 0 }
      });
  return {
    client: client as unknown as McpClientLike,
    transport,
    close: () => transport.close()
  };
};
