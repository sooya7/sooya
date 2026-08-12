/**
 * Agent and tool contracts.
 *
 * Tool names in this registry are canonical host names. Remote MCP names are
 * never registered without a server namespace (for example
 * `ombre.breath`), which keeps multiple servers isolated and makes policy
 * decisions auditable.
 */

export interface CapabilityDescriptor {
  name: string;
  description: string;
  /** Whether the underlying provider/resource is currently usable. */
  available: () => boolean;
}

export class CapabilityRegistryStub {
  private readonly items = new Map<string, CapabilityDescriptor>();

  register(desc: CapabilityDescriptor): void {
    this.items.set(desc.name, desc);
  }

  get(name: string): CapabilityDescriptor | undefined {
    return this.items.get(name);
  }

  list(): Array<{ name: string; description: string; available: boolean }> {
    return [...this.items.values()].map((d) => ({ name: d.name, description: d.description, available: d.available() }));
  }
}

export type ToolSource = 'local' | 'mcp' | 'provider';
export type ToolRisk = 'read' | 'write' | 'external_side_effect' | 'destructive' | 'maintenance';
export type ToolPhase = 'reply' | 'memory_commit' | 'proactive' | 'maintenance';

export interface ToolExecutionContext {
  phase: ToolPhase;
  signal?: AbortSignal;
  batchId?: string;
  revision?: number;
}

export interface ToolDescriptor<I = unknown, O = unknown> {
  name: string;
  description: string;
  /** JSON schema describing the input; validated by ToolCallRuntime. */
  inputSchema: Record<string, unknown>;
  source: ToolSource;
  serverId?: string;
  /** Provider-facing name. Defaults to canonical name for local tools. */
  modelName?: string;
  /** Original remote MCP name used for callTool. */
  remoteName?: string;
  /** Dynamically discovered MCP tools stay denied until explicitly classified. */
  authorized?: boolean;
  risk: ToolRisk;
  phases: ToolPhase[];
  /** Optional finer-grained authorization for a dynamically discovered tool. */
  authorize?: (phase: ToolPhase) => boolean;
  handler: (input: I, context?: ToolExecutionContext) => Promise<O>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>();

  register(tool: ToolDescriptor): void {
    validateToolDescriptor(tool);
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool as ToolDescriptor);
  }

  replaceSource(sourceId: string, tools: ToolDescriptor[]): void {
    for (const [name, current] of this.tools) {
      if (current.serverId === sourceId) this.tools.delete(name);
    }
    for (const tool of tools) this.register(tool);
  }

  removeSource(sourceId: string): void {
    for (const [name, current] of this.tools) {
      if (current.serverId === sourceId) this.tools.delete(name);
    }
  }

  get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name);
  }

  require(name: string): ToolDescriptor {
    const tool = this.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool;
  }

  getByModelName(name: string): ToolDescriptor | undefined {
    return [...this.tools.values()].find((tool) => (tool.modelName ?? tool.name) === name);
  }

  setAuthorization(name: string, authorized: boolean): void {
    const tool = this.require(name);
    tool.authorized = authorized;
  }

  list(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [...this.tools.values()].map(toPublicDescriptor);
  }

  listForPhase(phase: ToolPhase): ToolDescriptor[] {
    return [...this.tools.values()].filter((tool) =>
      tool.phases.includes(phase) && (tool.authorize === undefined || tool.authorize(phase))
    );
  }

  size(): number {
    return this.tools.size;
  }
}

function validateToolDescriptor(tool: ToolDescriptor): void {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u.test(tool.name)) {
    throw new Error(`invalid canonical tool name: ${tool.name}`);
  }
  if (!tool.description.trim()) throw new Error(`tool description is empty: ${tool.name}`);
  if (tool.inputSchema.type !== undefined && tool.inputSchema.type !== 'object') {
    throw new Error(`tool input schema must be an object: ${tool.name}`);
  }
  if (tool.phases.length === 0) throw new Error(`tool has no allowed phases: ${tool.name}`);
  if (tool.source === 'mcp' && !tool.serverId) throw new Error(`MCP tool is missing serverId: ${tool.name}`);
  if (tool.modelName !== undefined && !/^[a-z][a-z0-9]*(?:[_-]+[a-z0-9]+)*$/u.test(tool.modelName)) {
    throw new Error(`invalid model tool name: ${tool.modelName}`);
  }
}

function toPublicDescriptor(tool: ToolDescriptor): { name: string; description: string; inputSchema: Record<string, unknown> } {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

export interface AgentTask {
  id: string;
  goal: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

export interface AgentRunResult {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  output?: unknown;
  error?: string;
}

/** Interface a future agent worker must implement. Nothing implements it yet. */
export interface AgentWorker {
  readonly name: string;
  readonly enabled: boolean;
  run(task: AgentTask, ctx: { tools: ToolRegistry; signal?: AbortSignal }): Promise<AgentRunResult>;
}

export class AgentRegistry {
  private readonly workers = new Map<string, AgentWorker>();

  register(worker: AgentWorker): void {
    this.workers.set(worker.name, worker);
  }

  get(name: string): AgentWorker | undefined {
    return this.workers.get(name);
  }

  list(): Array<{ name: string; enabled: boolean }> {
    return [...this.workers.values()].map((w) => ({ name: w.name, enabled: w.enabled }));
  }

  /** Always false in v1 — the agent subsystem is reserved, not active. */
  get active(): boolean {
    return [...this.workers.values()].some((w) => w.enabled);
  }
}
