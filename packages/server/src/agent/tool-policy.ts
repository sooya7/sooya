import type { ChatToolDefinition } from '../providers/types.js';
import type { ToolDescriptor, ToolPhase, ToolRegistry, ToolRisk } from './registry.js';

export interface ToolPolicyOptions {
  readEnabled?: boolean;
  writeEnabled?: boolean;
  maintenanceEnabled?: boolean;
  serverPolicies?: Record<string, ToolServerPolicyOptions>;
}

export interface ToolServerPolicyOptions {
  readEnabled?: boolean;
  writeEnabled?: boolean;
  maintenanceEnabled?: boolean;
}

export interface ToolPolicyDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Host-side authorization. MCP discovery only supplies a schema; it never
 * grants a model permission to call the newly discovered tool.
 */
export class ToolPolicy {
  private readonly readEnabled: boolean;
  private readonly writeEnabled: boolean;
  private readonly maintenanceEnabled: boolean;
  private readonly serverPolicies: Record<string, ToolServerPolicyOptions>;

  constructor(
    private readonly registry: ToolRegistry,
    options: ToolPolicyOptions = {}
  ) {
    this.readEnabled = options.readEnabled ?? true;
    this.writeEnabled = options.writeEnabled ?? true;
    this.maintenanceEnabled = options.maintenanceEnabled ?? true;
    this.serverPolicies = options.serverPolicies ?? {};
  }

  check(tool: ToolDescriptor, phase: ToolPhase): ToolPolicyDecision {
    if (!tool.phases.includes(phase)) return { allowed: false, reason: 'phase-not-authorized' };
    if (tool.source === 'mcp' && tool.authorized !== true) return { allowed: false, reason: 'tool-not-authorized' };
    if (tool.authorize && !tool.authorize(phase)) return { allowed: false, reason: 'tool-not-authorized' };
    const readEnabled = this.enabledFor(tool, 'readEnabled', this.readEnabled);
    const writeEnabled = this.enabledFor(tool, 'writeEnabled', this.writeEnabled);
    const maintenanceEnabled = this.enabledFor(tool, 'maintenanceEnabled', this.maintenanceEnabled);
    if (phase === 'reply' || phase === 'proactive') {
      if (!readEnabled) return { allowed: false, reason: 'read-disabled' };
      return tool.risk === 'read' ? { allowed: true } : { allowed: false, reason: 'non-read-tool-in-visible-phase' };
    }
    if (phase === 'memory_commit') {
      if (tool.risk === 'read' && !readEnabled) return { allowed: false, reason: 'read-disabled' };
      if (isWriteRisk(tool.risk) && !writeEnabled) return { allowed: false, reason: 'write-disabled' };
      if (tool.risk === 'maintenance' && !maintenanceEnabled) return { allowed: false, reason: 'maintenance-disabled' };
      return { allowed: true };
    }
    if (tool.risk === 'read' && !readEnabled) return { allowed: false, reason: 'read-disabled' };
    if (!maintenanceEnabled) return { allowed: false, reason: 'maintenance-disabled' };
    if (isWriteRisk(tool.risk) && !writeEnabled) return { allowed: false, reason: 'write-disabled' };
    return { allowed: true };
  }

  descriptors(phase: ToolPhase): ToolDescriptor[] {
    return this.registry.listForPhase(phase).filter((tool) => this.check(tool, phase).allowed);
  }

  definitions(phase: ToolPhase): ChatToolDefinition[] {
    return this.descriptors(phase).map((tool) => ({
      name: tool.modelName ?? tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  }

  resolve(modelName: string): ToolDescriptor | undefined {
    return this.registry.getByModelName(modelName) ?? this.registry.get(modelName);
  }

  private enabledFor<K extends keyof ToolServerPolicyOptions>(tool: ToolDescriptor, key: K, global: boolean): boolean {
    if (tool.source !== 'mcp' || !tool.serverId) return global;
    return global && (this.serverPolicies[tool.serverId]?.[key] ?? true);
  }
}

function isWriteRisk(risk: ToolRisk): boolean {
  return risk === 'write' || risk === 'external_side_effect' || risk === 'destructive';
}
