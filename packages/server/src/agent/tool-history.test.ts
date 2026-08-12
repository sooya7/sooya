import { describe, expect, it } from 'vitest';
import { normalizeToolError, normalizeToolResult } from './tool-history.js';

describe('tool result safety', () => {
  it('serializes structured values and clips UTF-8 output with an explicit marker', () => {
    const result = normalizeToolResult({ text: '记忆'.repeat(100) }, { maxBytes: 256 });
    expect(result.bytes).toBe(256);
    expect(result.content).toContain('[tool result truncated by SOOYA host: 256 bytes limit]');
  });

  it('redacts credential-shaped error text', () => {
    const result = normalizeToolError(new Error('request failed bearer=secret-value'));
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('secret-value');
  });
});
