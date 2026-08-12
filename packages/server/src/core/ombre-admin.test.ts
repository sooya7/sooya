import { describe, expect, it, vi } from 'vitest';
import { ToolPolicy } from '../agent/tool-policy.js';
import { ToolRegistry, type ToolDescriptor } from '../agent/registry.js';
import { OmbreAdminService, OmbreCatalogUnavailableError } from './ombre-admin.js';

function descriptor(name: string, schema: Record<string, unknown>, handler: ToolDescriptor['handler']): ToolDescriptor {
  return {
    name,
    modelName: name.replace('.', '__'),
    description: `test ${name}`,
    inputSchema: schema,
    source: 'mcp',
    serverId: 'ombre',
    remoteName: name.slice(name.indexOf('.') + 1),
    risk: 'read',
    phases: ['admin'],
    authorized: true,
    handler
  };
}

function serviceWith(tool: ToolDescriptor, events = [{
  id: 'evt_1', seq: 1, type: 'ombre.memory.search' as const, createdAt: '2026-08-12T00:00:00.000Z', payload: { query: 'secret text', resultCount: 2 }
}]) {
  const registry = new ToolRegistry();
  registry.register(tool);
  const manager = {
    health: () => [{ id: 'ombre', enabled: true, state: 'ready' as const, toolCount: 4 }],
    configs: () => [{ id: 'ombre', enabled: true, transport: 'streamable-http' as const, url: 'https://ombre.example/mcp?token=do-not-return', auth: { type: 'bearer-env' as const, env: 'OMBRE_MCP_TOKEN' }, required: false, connectTimeoutMs: 1000, toolTimeoutMs: 1000 }]
  };
  const commits = { list: () => [] };
  const memories = { list: () => [{ id: 'legacy-1', kind: 'profile', content: 'legacy', importance: 0.8, confidence: 0.9, createdAt: '2026-08-11', updatedAt: '2026-08-11', hits: 1, hasEmbedding: false }] };
  const eventRepo = { recent: vi.fn(() => events) };
  return {
    service: new OmbreAdminService({
      manager: manager as never,
      registry,
      policy: new ToolPolicy(registry),
      commits: commits as never,
      memories: memories as never,
      events: eventRepo as never,
      configSource: 'config/mcp.json',
      globalPolicy: { readEnabled: true, writeEnabled: true, maintenanceEnabled: true },
      dashboardUrl: 'https://ombre.example/dashboard?token=secret'
    }),
    eventRepo,
    manager
  };
}

describe('OmbreAdminService', () => {
  it('calls the read-only search tool in the admin phase and parses bounded buckets', async () => {
    const handler = vi.fn(async (_input: unknown, context?: { phase: string }) => {
      expect(context?.phase).toBe('admin');
      return 'bucket_id: B-1\nknown: true\n---\nbucket_id: B-2\nknown: false';
    });
    const { service } = serviceWith(descriptor('ombre.breath_search', { type: 'object' }, handler));

    const result = await service.search('  habit  ', 10);

    expect(handler).toHaveBeenCalledWith({ query: 'habit' }, expect.objectContaining({ phase: 'admin' }));
    expect(result.query).toBe('habit');
    expect(result.results).toEqual([
      expect.objectContaining({ bucketId: 'B-1', known: true }),
      expect.objectContaining({ bucketId: 'B-2', known: false })
    ]);
  });

  it('reports catalog support only when the discovered schema exposes it', async () => {
    const handler = vi.fn(async () => JSON.stringify({ catalog: ['profile', 'event'] }));
    const { service } = serviceWith(descriptor('ombre.breath_advanced', { type: 'object', properties: { catalog: { type: 'boolean' }, max_results: { type: 'integer' } } }, handler));
    await expect(service.catalog(7)).resolves.toMatchObject({ catalog: ['profile', 'event'] });
    expect(handler).toHaveBeenCalledWith({ catalog: true, max_results: 7 }, expect.objectContaining({ phase: 'admin' }));

    const unavailable = serviceWith(descriptor('ombre.breath_advanced', { type: 'object', properties: { query: { type: 'string' } } }, handler)).service;
    await expect(unavailable.catalog(7)).rejects.toBeInstanceOf(OmbreCatalogUnavailableError);
  });

  it('redacts query text and secrets from activity and overview metadata', () => {
    const { service } = serviceWith(descriptor('ombre.breath_search', { type: 'object' }, async () => 'ok'));
    expect(service.activity(20)[0]).toMatchObject({ type: 'ombre.memory.search', detail: { queryLength: 11, resultCount: 2 } });
    expect(JSON.stringify(service.activity(20))).not.toContain('secret text');
    const overview = service.mcpOverview();
    expect(JSON.stringify(overview)).not.toContain('token');
    expect(overview.servers[0]).toMatchObject({ url: 'https://ombre.example/mcp', authConfigured: false });
    expect(overview.dashboardUrl).toBe('https://ombre.example/dashboard');
    expect(JSON.stringify(overview)).not.toContain('inputSchema');
  });
});
