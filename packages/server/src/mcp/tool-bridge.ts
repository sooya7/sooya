import type { ToolDescriptor, ToolPhase, ToolRisk } from '../agent/registry.js';
import type { McpConnection } from './connection.js';
import { wrapMcpResult } from './result.js';
import type { McpRemoteTool, McpServerConfig, McpToolCallResult, McpToolPolicy } from './types.js';

export type McpToolCaller = (remoteName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpToolCallResult>;

export function bridgeMcpTools(
  config: McpServerConfig,
  connection: McpConnection,
  remoteTools: McpRemoteTool[],
  callTool: McpToolCaller = (remoteName, args, signal) => connection.callTool(remoteName, args, signal)
): ToolDescriptor[] {
  return remoteTools.map((remote) => {
    const policy = config.toolPolicy?.[remote.name] ?? defaultPolicy(config.id, remote.name);
    const canonicalName = `${config.id}.${canonicalPart(remote.name)}`;
    return {
      name: canonicalName,
      modelName: `${modelPart(config.id)}__${modelPart(remote.name)}`,
      remoteName: remote.name,
      description: remote.description?.trim() || `MCP tool ${config.id}/${remote.name}`,
      inputSchema: remote.inputSchema,
      source: 'mcp' as const,
      serverId: config.id,
      risk: policy.risk,
      phases: policy.phases,
      authorized: policy.authorized,
      handler: async (input: unknown, context) => wrapMcpResult(await callTool(remote.name, asObject(input), context?.signal))
    };
  });
}

function defaultPolicy(serverId: string, remoteName: string): McpToolPolicy {
  if (serverId === 'ombre') {
    if (remoteName === 'breath') {
      return { risk: 'read', phases: ['reply', 'proactive'], authorized: true };
    }
    if (['breath_search', 'breath_advanced', 'pulse', 'letter_read'].includes(remoteName)) {
      return { risk: 'read', phases: ['reply', 'proactive', 'memory_commit', 'admin'], authorized: true };
    }
    if (remoteName === 'dream') return { risk: 'maintenance', phases: ['maintenance'], authorized: true };
    if (['hold', 'grow', 'trace', 'anchor', 'release', 'plan', 'letter_write', 'I'].includes(remoteName)) {
      return { risk: remoteName === 'trace' ? 'destructive' : 'write', phases: ['memory_commit'], authorized: true };
    }
  }
  return { risk: 'maintenance', phases: ['maintenance'], authorized: false };
}

function canonicalPart(value: string): string {
  const part = value.normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9]+/gu, '.').replace(/^\.+|\.+$/gu, '');
  return part || 'unnamed';
}

function modelPart(value: string): string {
  const part = value.normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
  return part || 'tool';
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
