import fs from 'node:fs';
import type { McpAuth, McpServerConfig, McpToolPolicy } from './types.js';

export interface McpConfigDocument {
  servers: Record<string, McpServerConfig>;
}

export function loadMcpConfig(file: string, env: NodeJS.ProcessEnv = process.env): McpConfigDocument {
  let raw: unknown = {};
  if (fs.existsSync(file)) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown; } catch (error) { throw new Error(`invalid MCP config: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const sourceServers = isRecord(raw) && isRecord(raw.servers) ? raw.servers : {};
  const servers: Record<string, McpServerConfig> = {};
  for (const [id, value] of Object.entries(sourceServers)) {
    const config = normalizeServer(id, value);
    if (config) servers[id] = config;
  }

  const overrideUrl = env.OMBRE_MCP_URL?.trim();
  if (overrideUrl) {
    servers.ombre = normalizeServer('ombre', {
      ...(servers.ombre ?? {}),
      enabled: true,
      url: overrideUrl,
      auth: servers.ombre?.auth ?? { type: 'bearer-env', env: 'OMBRE_MCP_TOKEN' }
    })!;
  }
  return { servers };
}

function normalizeServer(id: string, value: unknown): McpServerConfig | null {
  if (!isRecord(value)) return null;
  const url = typeof value.url === 'string' ? value.url.trim() : '';
  if (!url) return null;
  const transport = value.transport === 'sse' ? 'sse' : 'streamable-http';
  const auth = normalizeAuth(value.auth);
  const toolPolicy = normalizeToolPolicy(value.toolPolicy);
  return {
    id,
    enabled: value.enabled !== false,
    transport,
    url,
    auth,
    required: value.required === true,
    connectTimeoutMs: boundedInt(value.connectTimeoutMs, 10_000, 500, 120_000),
    toolTimeoutMs: boundedInt(value.toolTimeoutMs, 15_000, 500, 120_000),
    ...(toolPolicy ? { toolPolicy } : {})
  };
}

function normalizeAuth(value: unknown): McpAuth {
  if (isRecord(value) && value.type === 'none') return { type: 'none' };
  if (isRecord(value) && value.type === 'bearer-env' && typeof value.env === 'string' && value.env.trim()) {
    return { type: 'bearer-env', env: value.env.trim() };
  }
  return { type: 'none' };
}

function normalizeToolPolicy(value: unknown): Record<string, McpToolPolicy> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, McpToolPolicy> = {};
  for (const [name, item] of Object.entries(value)) {
    if (!isRecord(item)) continue;
    const allowedRisks = ['read', 'write', 'external_side_effect', 'destructive', 'maintenance'] as const;
    const risk = allowedRisks.includes(item.risk as typeof allowedRisks[number]) ? item.risk as McpToolPolicy['risk'] : 'maintenance';
    const defaultPhases: McpToolPolicy['phases'] = ['maintenance'];
    const phases: McpToolPolicy['phases'] = Array.isArray(item.phases)
      ? item.phases.filter((phase): phase is McpToolPolicy['phases'][number] => ['reply', 'memory_commit', 'proactive', 'maintenance'].includes(String(phase)))
      : defaultPhases;
    out[name] = { risk, phases: phases.length > 0 ? phases : ['maintenance'], authorized: item.authorized === true };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
