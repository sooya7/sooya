import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';

export type McpTransport = 'streamable-http' | 'sse';
export type McpAuth =
  | { type: 'none' }
  | { type: 'bearer-env'; env: string };

export interface McpToolPolicy {
  risk: 'read' | 'write' | 'external_side_effect' | 'destructive' | 'maintenance';
  phases: Array<'reply' | 'memory_commit' | 'proactive' | 'maintenance'>;
  authorized: boolean;
}

export interface McpServerConfig {
  id: string;
  enabled: boolean;
  transport: McpTransport;
  url: string;
  auth: McpAuth;
  required: boolean;
  connectTimeoutMs: number;
  toolTimeoutMs: number;
  toolPolicy?: Record<string, McpToolPolicy>;
}

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpClientLike {
  connect(transport: unknown, options?: RequestOptions): Promise<void>;
  close(): Promise<void>;
  listTools(params?: { cursor?: string }, options?: RequestOptions): Promise<{ tools: McpRemoteTool[]; nextCursor?: string }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }, resultSchema?: unknown, options?: RequestOptions): Promise<McpToolCallResult>;
}

export interface McpClientSession {
  client: McpClientLike;
  transport?: unknown;
  close?: () => Promise<void>;
}

export type McpClientFactory = (config: McpServerConfig, headers: Record<string, string>) => Promise<McpClientSession>;

export interface McpConnectionSnapshot {
  id: string;
  enabled: boolean;
  state: 'disabled' | 'connecting' | 'ready' | 'degraded' | 'closed';
  toolCount: number;
  latencyMs?: number;
  lastError?: string;
  lastConnectedAt?: string;
  lastRefreshAt?: string;
  serverName?: string;
}
