/**
 * Reserved Agent architecture.
 *
 * This version deliberately ships NO CLI agent and no tool execution. The chat
 * pipeline never imports anything from this module, so adding an agent later
 * cannot force a rewrite of the chat system. Only the interfaces and the
 * registries exist today.
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

export interface ToolDescriptor<I = unknown, O = unknown> {
  name: string;
  description: string;
  /** JSON schema describing the input; validated by the caller. */
  inputSchema: Record<string, unknown>;
  handler: (input: I) => Promise<O>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>();

  register(tool: ToolDescriptor): void {
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool as ToolDescriptor);
  }

  get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name);
  }

  list(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  size(): number {
    return this.tools.size;
  }
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
