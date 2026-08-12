import { SOOYA_MCP_RESULT, type SooyaMcpResultEnvelope } from '../mcp/result.js';

const DEFAULT_RESULT_MAX_BYTES = 32 * 1024;

export interface NormalizedToolResult {
  content: string;
  isError?: boolean;
  bytes: number;
}

export function normalizeToolResult(value: unknown, options: { maxBytes?: number; isError?: boolean } = {}): NormalizedToolResult {
  const maxBytes = Math.max(256, options.maxBytes ?? DEFAULT_RESULT_MAX_BYTES);
  if (isMcpEnvelope(value)) return normalizeToolResult(value.value, { maxBytes, isError: options.isError || value.isError });
  let content: string;
  if (typeof value === 'string') content = value;
  else if (value === undefined) content = '';
  else {
    try { content = JSON.stringify(value); } catch { content = '[tool result could not be serialized]'; }
  }
  const bytes = byteLength(content);
  if (bytes <= maxBytes) return { content, ...(options.isError ? { isError: true } : {}), bytes };
  const marker = `\n[tool result truncated by SOOYA host: ${maxBytes} bytes limit]`;
  return { content: clipUtf8(content, Math.max(0, maxBytes - byteLength(marker))) + marker, ...(options.isError ? { isError: true } : {}), bytes: maxBytes };
}

function isMcpEnvelope(value: unknown): value is SooyaMcpResultEnvelope {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>)[SOOYA_MCP_RESULT] === true;
}

export function normalizeToolError(error: unknown, maxBytes?: number): NormalizedToolResult {
  const raw = error instanceof Error ? error.message : String(error);
  const safe = raw
    .replace(/(?:bearer|token|api[_ -]?key|password)\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .slice(0, 2000);
  return normalizeToolResult(`tool temporarily unavailable: ${safe || 'unknown error'}`, { maxBytes, isError: true });
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function clipUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let output = '';
  for (const char of value) {
    if (byteLength(output + char) > maxBytes) break;
    output += char;
  }
  return output;
}
