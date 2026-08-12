import { describe, expect, it } from 'vitest';
import { loadMcpConfig } from './config.js';

describe('MCP config loading', () => {
  it('loads a multi-server document without ever reading secret values into the config', async () => {
    const file = `${process.cwd()}/.tmp-mcp-config-${Date.now()}.json`;
    const fs = await import('node:fs/promises');
    await fs.writeFile(file, JSON.stringify({ servers: {
      ombre: { enabled: true, transport: 'streamable-http', url: 'http://127.0.0.1:18001/mcp', auth: { type: 'bearer-env', env: 'OMBRE_MCP_TOKEN' } },
      github: { enabled: false, transport: 'streamable-http', url: 'http://github-mcp:8000/mcp', auth: { type: 'none' } }
    } }), 'utf8');
    try {
      const result = loadMcpConfig(file, {});
      expect(result.servers.ombre).toMatchObject({ id: 'ombre', enabled: true, connectTimeoutMs: 10_000, toolTimeoutMs: 15_000 });
      expect(JSON.stringify(result)).not.toContain('secret');
    } finally {
      await fs.unlink(file);
    }
  });

  it('uses OMBRE_MCP_URL as a compatibility override inside the generic server map', () => {
    const result = loadMcpConfig('C:/path/that/does/not/exist.json', { OMBRE_MCP_URL: 'http://ombre-brain:8000/mcp' });
    expect(result.servers.ombre?.url).toBe('http://ombre-brain:8000/mcp');
    expect(result.servers.ombre?.auth).toEqual({ type: 'bearer-env', env: 'OMBRE_MCP_TOKEN' });
  });
});
