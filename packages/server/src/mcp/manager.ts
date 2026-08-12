import { McpConnection, type McpConnectionOptions } from './connection.js';
import { bridgeMcpTools } from './tool-bridge.js';
import { resolveMcpAuth } from './auth.js';
import type { ToolRegistry } from '../agent/registry.js';
import type { McpClientFactory, McpConnectionSnapshot, McpServerConfig, McpToolCallResult } from './types.js';

export interface McpManagerOptions extends McpConnectionOptions {
  servers: McpServerConfig[] | Record<string, Omit<McpServerConfig, 'id'>>;
  registry: ToolRegistry;
  clientFactory?: McpClientFactory;
  onEvent?: (event: { serverId: string; event: string; detail?: string }) => void;
}

export class McpManager {
  private readonly connections = new Map<string, McpConnection>();
  private readonly reconnecting = new Map<string, Promise<void>>();

  constructor(private readonly options: McpManagerOptions) {
    for (const config of normalizeServers(options.servers)) {
      if (this.connections.has(config.id)) throw new Error(`duplicate MCP server: ${config.id}`);
      this.connections.set(config.id, new McpConnection(config, {
        env: options.env,
        clientFactory: options.clientFactory
      }));
    }
  }

  async connectAllBestEffort(): Promise<McpConnectionSnapshot[]> {
    await Promise.all([...this.connections.keys()].map((id) => this.connect(id).catch(() => undefined)));
    const snapshots = this.health();
    const requiredFailure = [...this.connections.values()].find((connection) =>
      connection.config.enabled && connection.config.required && connection.snapshot().state !== 'ready'
    );
    if (requiredFailure) {
      const snapshot = requiredFailure.snapshot();
      throw new Error(`required MCP server ${snapshot.id} is not ready${snapshot.lastError ? `: ${snapshot.lastError}` : ''}`);
    }
    return snapshots;
  }

  async connect(serverId: string): Promise<McpConnectionSnapshot> {
    const connection = this.requireConnection(serverId);
    try {
      await connection.connect();
      this.registerTools(connection);
      this.options.onEvent?.({ serverId, event: 'connect_success' });
    } catch (error) {
      this.options.registry.removeSource(serverId);
      this.options.onEvent?.({ serverId, event: 'connect_failure', detail: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    return connection.snapshot();
  }

  async refreshTools(serverId: string): Promise<McpConnectionSnapshot> {
    const connection = this.requireConnection(serverId);
    if (connection.snapshot().state !== 'ready') {
      await this.reconnect(serverId);
      return connection.snapshot();
    }
    try {
      await connection.refreshTools();
      this.registerTools(connection);
      this.options.onEvent?.({ serverId, event: 'tools_refresh' });
    } catch (error) {
      this.options.onEvent?.({ serverId, event: 'tools_refresh_failure', detail: error instanceof Error ? error.message : String(error) });
      if (isReconnectableMcpError(error)) {
        await this.reconnect(serverId);
        return connection.snapshot();
      }
      throw error;
    }
    return connection.snapshot();
  }

  async test(serverId: string): Promise<McpConnectionSnapshot> {
    const connection = this.requireConnection(serverId);
    const snapshot = await connection.test();
    this.registerTools(connection);
    return snapshot;
  }

  async callTool(serverId: string, remoteName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> {
    const connection = this.requireConnection(serverId);
    try {
      return await connection.callTool(remoteName, args, signal);
    } catch (error) {
      if (signal?.aborted || !isReconnectableMcpError(error)) throw error;
      await this.reconnect(serverId);
      if (signal?.aborted) throw signal.reason ?? new Error('MCP tool call aborted');
      return connection.callTool(remoteName, args, signal);
    }
  }

  getConnection(serverId: string): McpConnection | undefined {
    return this.connections.get(serverId);
  }

  health(): McpConnectionSnapshot[] {
    return [...this.connections.values()].map((connection) => connection.snapshot());
  }

  /** Safe config metadata for administrative observability; auth values stay in the connection. */
  configs(): McpServerConfig[] {
    return [...this.connections.values()].map((connection) => ({
      ...connection.config,
      ...(connection.config.toolPolicy ? { toolPolicy: { ...connection.config.toolPolicy } } : {})
    }));
  }

  /** Whether the configured auth source currently resolves without exposing its value. */
  authConfigured(serverId: string): boolean {
    const connection = this.connections.get(serverId);
    return connection ? resolveMcpAuth(connection.config, this.options.env).configured : false;
  }

  async close(): Promise<void> {
    await Promise.all([...this.connections.values()].map((connection) => connection.close()));
  }

  private registerTools(connection: McpConnection): void {
    const descriptors = bridgeMcpTools(
      connection.config,
      connection,
      connection.tools(),
      (remoteName, args, signal) => this.callTool(connection.config.id, remoteName, args, signal)
    );
    this.options.registry.replaceSource(connection.config.id, descriptors);
  }

  private async reconnect(serverId: string): Promise<void> {
    const current = this.reconnecting.get(serverId);
    if (current) return current;
    const attempt = (async () => {
      this.options.onEvent?.({ serverId, event: 'reconnect_attempt' });
      try {
        await this.connect(serverId);
        this.options.onEvent?.({ serverId, event: 'reconnect_success' });
      } catch (error) {
        this.options.onEvent?.({ serverId, event: 'reconnect_failure', detail: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    })();
    this.reconnecting.set(serverId, attempt);
    try {
      await attempt;
    } finally {
      if (this.reconnecting.get(serverId) === attempt) this.reconnecting.delete(serverId);
    }
  }

  private requireConnection(serverId: string): McpConnection {
    const connection = this.connections.get(serverId);
    if (!connection) throw new Error(`unknown MCP server: ${serverId}`);
    return connection;
  }
}

/** Only transport/session failures are eligible for the single reconnect. */
export function isReconnectableMcpError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  const status = [value.status, value.statusCode].find((candidate): candidate is number =>
    typeof candidate === 'number' && Number.isFinite(candidate)
  );
  if (status !== undefined) {
    if (status >= 400 && status < 500) return false;
    if ([502, 503, 504].includes(status)) return true;
  }
  const text = `${typeof value.code === 'string' ? value.code : ''} ${typeof value.message === 'string' ? value.message : String(error)}`.toLowerCase();
  return /connection\s+(?:closed|reset|lost)|transport\s+(?:closed|reset|unavailable)|session\s+(?:invalid|closed|expired)|econnreset|econnrefused|fetch\s+failed|socket\s+hang\s*up|network\s+error|mcp server [^\n]*unavailable/u.test(text);
}

function normalizeServers(input: McpManagerOptions['servers']): McpServerConfig[] {
  if (Array.isArray(input)) return input;
  return Object.entries(input).map(([id, config]) => ({ ...config, id }));
}
