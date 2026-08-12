import type { McpServerConfig } from './types.js';

export interface ResolvedMcpAuth {
  headers: Record<string, string>;
  configured: boolean;
  reason?: string;
}

export function resolveMcpAuth(config: McpServerConfig, env: NodeJS.ProcessEnv = process.env): ResolvedMcpAuth {
  if (config.auth.type === 'none') return { headers: {}, configured: true };
  const token = env[config.auth.env]?.trim();
  if (!token) return { headers: {}, configured: false, reason: `missing ${config.auth.env}` };
  return { headers: { authorization: `Bearer ${token}` }, configured: true };
}

export function redactMcpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/authorization\s*:\s*bearer\s+\S+/giu, 'authorization: Bearer [redacted]')
    .replace(/(?:token|api[_ -]?key|password)\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .slice(0, 500);
}
