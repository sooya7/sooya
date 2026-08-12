import { normalizeToolResult } from '../agent/tool-history.js';
import type { ToolDescriptor, ToolRegistry } from '../agent/registry.js';
import { ToolPolicy } from '../agent/tool-policy.js';
import type { EventRepo } from '../db/repos/misc.repo.js';
import type { MemoryRepo } from '../db/repos/memory.repo.js';
import type { OmbreCommitRepo } from '../db/repos/ombre.repo.js';
import type { McpManager } from '../mcp/manager.js';
import type { EventBus } from '../events/bus.js';

export class OmbreCatalogUnavailableError extends Error {
  readonly code = 'ombre_catalog_unavailable';
  constructor() {
    super('Ombre catalog is not exposed by the connected breath_advanced schema');
    this.name = 'OmbreCatalogUnavailableError';
  }
}

export interface OmbreAdminServiceOptions {
  manager: McpManager;
  registry: ToolRegistry;
  policy: ToolPolicy;
  commits: OmbreCommitRepo;
  memories: MemoryRepo;
  events: EventRepo;
  configSource: string;
  globalPolicy: { readEnabled: boolean; writeEnabled: boolean; maintenanceEnabled: boolean };
  dashboardUrl?: string;
  bus?: EventBus;
}

export interface OmbreAdminOverview {
  configSource: string;
  globalPolicy: OmbreAdminServiceOptions['globalPolicy'];
  servers: Array<{
    id: string;
    enabled: boolean;
    required: boolean;
    url: string;
    transport: string;
    authConfigured: boolean;
    state: string;
    toolCount: number;
    latencyMs?: number;
    lastConnected?: string;
    lastRefresh?: string;
    lastConnectedAt?: string;
    lastRefreshAt?: string;
    lastError?: string;
  }>;
  tools: Array<{
    name: string;
    modelName?: string;
    remoteName?: string;
    serverId?: string;
    description: string;
    risk: string;
    phases: string[];
    authorized: boolean;
  }>;
  memory: ReturnType<OmbreAdminService['status']>;
  dashboardUrl: string | null;
}

export class OmbreAdminService {
  constructor(private readonly options: OmbreAdminServiceOptions) {}

  status(): {
    backend: 'ombre';
    connection: 'connected' | 'degraded';
    health: ReturnType<McpManager['health']>[number] | null;
    lastCommit: ReturnType<OmbreCommitRepo['list']>[number] | null;
    pending: number;
    uncertain: number;
    lastDream: string | null;
    dashboardUrl: string | null;
  } {
    const health = this.options.manager.health().find((item) => item.id === 'ombre') ?? null;
    const commits = this.options.commits.list(100);
    const lastDream = this.options.events.recent(100).find((event) => event.type === 'ombre.memory.dream')?.createdAt ?? null;
    return {
      backend: 'ombre',
      connection: health?.state === 'ready' ? 'connected' : 'degraded',
      health,
      lastCommit: commits[0] ?? null,
      pending: commits.filter((row) => row.state === 'running').length,
      uncertain: commits.filter((row) => row.state === 'uncertain').length,
      lastDream,
      dashboardUrl: safeDashboardUrl(this.options.dashboardUrl)
    };
  }

  async search(query: string, limit = 10): Promise<{ query: string; results: Array<Record<string, unknown>>; raw: string; resultCount: number }> {
    const normalized = query.trim().slice(0, 200);
    if (!normalized) return { query: '', results: [], raw: '', resultCount: 0 };
    const capped = Math.max(1, Math.min(50, Math.floor(limit)));
    const result = await this.callRead('ombre.breath_search', { query: normalized }, 'admin');
    const parsed = parseBreathResult(result.content, capped);
    this.options.bus?.publish('ombre.memory.search', { queryLength: normalized.length, resultCount: parsed.length });
    return { query: normalized, results: parsed, raw: result.content.slice(0, 32 * 1024), resultCount: parsed.length };
  }

  async catalog(limit = 50): Promise<Record<string, unknown>> {
    const tool = this.requireRead('ombre.breath_advanced');
    if (!supportsProperty(tool.inputSchema, 'catalog')) throw new OmbreCatalogUnavailableError();
    const capped = Math.max(1, Math.min(200, Math.floor(limit)));
    const result = await tool.handler({ catalog: true, max_results: capped }, { phase: 'admin' });
    const normalized = normalizeToolResult(result);
    if (normalized.isError) throw new Error(normalized.content || 'Ombre catalog request failed');
    return parseRecord(normalized.content);
  }

  activity(limit = 50): Array<{ id: string; seq: number; type: string; createdAt: string; detail: Record<string, unknown> }> {
    return this.options.events.recent(Math.max(1, Math.min(50, limit)))
      .filter((event) => event.type.startsWith('ombre.') || event.type.startsWith('mcp.'))
      .map((event) => ({
        id: event.id,
        seq: event.seq,
        type: event.type,
        createdAt: event.createdAt,
        detail: safeEventDetail(event.type, event.payload)
      }));
  }

  legacy(limit = 100, offset = 0): { memories: ReturnType<MemoryRepo['list']>; total: number; readOnly: true } {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    const memories = this.options.memories.list({ limit: safeLimit, offset: safeOffset });
    return { memories, total: this.options.memories.list({ limit: 1000, offset: 0 }).length, readOnly: true };
  }

  mcpOverview(): OmbreAdminOverview {
    const configs = new Map(this.options.manager.configs().map((config) => [config.id, config]));
    const snapshots = new Map(this.options.manager.health().map((snapshot) => [snapshot.id, snapshot]));
    const servers = [...new Set([...configs.keys(), ...snapshots.keys()])].map((id) => {
      const config = configs.get(id);
      const snapshot = snapshots.get(id);
      return {
        id,
        enabled: config?.enabled ?? snapshot?.enabled ?? false,
        required: config?.required ?? false,
        url: safeUrl(config?.url ?? ''),
        transport: config?.transport ?? 'unknown',
        authConfigured: config
          ? typeof (this.options.manager as unknown as { authConfigured?: (serverId: string) => boolean }).authConfigured === 'function'
            ? this.options.manager.authConfigured(id)
            : config.auth.type === 'none'
          : false,
        state: snapshot?.state ?? 'closed',
        toolCount: snapshot?.toolCount ?? 0,
        ...(snapshot?.latencyMs === undefined ? {} : { latencyMs: snapshot.latencyMs }),
        ...(snapshot?.lastConnectedAt ? { lastConnected: snapshot.lastConnectedAt } : {}),
        ...(snapshot?.lastRefreshAt ? { lastRefresh: snapshot.lastRefreshAt } : {}),
        ...(snapshot?.lastConnectedAt ? { lastConnectedAt: snapshot.lastConnectedAt } : {}),
        ...(snapshot?.lastRefreshAt ? { lastRefreshAt: snapshot.lastRefreshAt } : {}),
        ...(snapshot?.lastError ? { lastError: snapshot.lastError.slice(0, 300) } : {})
      };
    });
    return {
      configSource: this.options.configSource,
      globalPolicy: { ...this.options.globalPolicy },
      servers,
      tools: this.options.registry.listForAdmin()
        .filter((tool) => tool.source === 'mcp')
        .map(({ inputSchema: _inputSchema, ...tool }) => tool),
      memory: this.status(),
      dashboardUrl: safeDashboardUrl(this.options.dashboardUrl)
    };
  }

  toolSchema(name: string): Record<string, unknown> | null {
    const tool = this.options.registry.get(name);
    if (!tool || tool.source !== 'mcp') return null;
    return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, risk: tool.risk, phases: tool.phases, authorized: tool.authorized === true };
  }

  private requireRead(name: string): ToolDescriptor {
    const tool = this.options.registry.get(name);
    if (!tool || !this.options.policy.check(tool, 'admin').allowed || tool.risk !== 'read') throw new Error(`admin tool unavailable: ${name}`);
    return tool;
  }

  private async callRead(name: string, input: Record<string, unknown>, phase: 'admin') {
    const tool = this.requireRead(name);
    const result = normalizeToolResult(await tool.handler(input, { phase }));
    if (result.isError) throw new Error(result.content || `${name} failed`);
    return result;
  }
}

function supportsProperty(schema: Record<string, unknown>, property: string): boolean {
  const properties = schema.properties;
  return typeof properties === 'object' && properties !== null && !Array.isArray(properties) && property in properties;
}

function parseBreathResult(raw: string, limit: number): Array<Record<string, unknown>> {
  const blocks = raw.split(/\r?\n\s*---\s*\r?\n/u).map((block) => block.trim()).filter(Boolean).slice(0, limit);
  return blocks.map((block) => {
    const record: Record<string, unknown> = { raw: block.slice(0, 4000) };
    for (const line of block.split(/\r?\n/u)) {
      const match = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/u.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (key === 'bucket_id' || key === 'bucketId') record.bucketId = value ?? '';
      else if (key === 'known') record.known = (value ?? '').toLowerCase() === 'true';
      else if (key === 'score') record.score = Number.isFinite(Number(value)) ? Number(value) : value;
    }
    return record;
  });
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
  } catch {
    return { raw: raw.slice(0, 32 * 1024) };
  }
}

function safeEventDetail(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (type.endsWith('.search')) {
    if (typeof payload.query === 'string') result.queryLength = payload.query.length;
    if (typeof payload.resultCount === 'number') result.resultCount = payload.resultCount;
  } else {
    for (const key of ['batchId', 'revision', 'state', 'reason', 'callsExecuted', 'rounds', 'recovered', 'serverId', 'error', 'resultCount']) {
      if (payload[key] !== undefined) result[key] = typeof payload[key] === 'string' ? String(payload[key]).slice(0, 300) : payload[key];
    }
  }
  return result;
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/u, '');
  } catch {
    return '';
  }
}

function safeDashboardUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const result = safeUrl(value.trim());
  return result || null;
}
