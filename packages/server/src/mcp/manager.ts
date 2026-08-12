import { McpConnection, type McpConnectionOptions } from './connection.js';
import { bridgeMcpTools } from './tool-bridge.js';
import type { ToolRegistry } from '../agent/registry.js';
import type { McpClientFactory, McpConnectionSnapshot, McpServerConfig } from './types.js';

export interface McpManagerOptions extends McpConnectionOptions {
  servers: McpServerConfig[] | Record<string, Omit<McpServerConfig, 'id'>>;
  registry: ToolRegistry;
  clientFactory?: McpClientFactory;
  onEvent?: (event: { serverId: string; event: string; detail?: string }) => void;
}

export class McpManager {
  private readonly connections = new Map<string, McpConnection>();

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
    return this.health();
  }

  async connect(serverId: string): Promise<McpConnectionSnapshot> {
    const connection = this.requireConnection(serverId);
    try {
      await connection.connect();
      this.registerTools(connection);
      this.options.onEvent?.({ serverId, event: 'connect_success' });
    } catch (error) {
      this.options.onEvent?.({ serverId, event: 'connect_failure', detail: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    return connection.snapshot();
  }

  async refreshTools(serverId: string): Promise<McpConnectionSnapshot> {
    const connection = this.requireConnection(serverId);
    try {
      await connection.refreshTools();
      this.registerTools(connection);
      this.options.onEvent?.({ serverId, event: 'tools_refresh' });
    } catch (error) {
      this.options.onEvent?.({ serverId, event: 'tools_refresh_failure', detail: error instanceof Error ? error.message : String(error) });
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

  async callTool(serverId: string, remoteName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.requireConnection(serverId).callTool(remoteName, args, signal);
  }

  getConnection(serverId: string): McpConnection | undefined {
    return this.connections.get(serverId);
  }

  health(): McpConnectionSnapshot[] {
    return [...this.connections.values()].map((connection) => connection.snapshot());
  }

  async close(): Promise<void> {
    await Promise.all([...this.connections.values()].map((connection) => connection.close()));
  }

  private registerTools(connection: McpConnection): void {
    const descriptors = bridgeMcpTools(connection.config, connection, connection.tools());
    this.options.registry.replaceSource(connection.config.id, descriptors);
  }

  private requireConnection(serverId: string): McpConnection {
    const connection = this.connections.get(serverId);
    if (!connection) throw new Error(`unknown MCP server: ${serverId}`);
    return connection;
  }
}

function normalizeServers(input: McpManagerOptions['servers']): McpServerConfig[] {
  if (Array.isArray(input)) return input;
  return Object.entries(input).map(([id, config]) => ({ ...config, id }));
}
