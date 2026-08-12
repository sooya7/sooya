import type { McpToolCallResult } from './types.js';

export const SOOYA_MCP_RESULT = '__sooya_mcp_result__';

export interface SooyaMcpResultEnvelope {
  [SOOYA_MCP_RESULT]: true;
  value: unknown;
  isError: boolean;
}

export function wrapMcpResult(result: McpToolCallResult): SooyaMcpResultEnvelope {
  const text = (result.content ?? [])
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => String(item.text))
    .join('\n');
  const value = result.structuredContent !== undefined
    ? (text ? { structuredContent: result.structuredContent, text } : result.structuredContent)
    : text;
  return { [SOOYA_MCP_RESULT]: true, value, isError: result.isError === true };
}
