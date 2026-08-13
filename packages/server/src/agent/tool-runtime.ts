import type { ChatProvider, ChatRequest, ChatToolCall, ModelTurn } from '../providers/types.js';
import { clipUtf8, normalizeToolError, normalizeToolResult, byteLength } from './tool-history.js';
import { ToolPolicy } from './tool-policy.js';
import type { ToolDescriptor, ToolPhase, ToolRegistry } from './registry.js';

export interface ToolCallRuntimeOptions {
  registry: ToolRegistry;
  policy: ToolPolicy;
  maxRounds?: number;
  maxCallsPerRound?: number;
  timeoutMs?: number;
  resultMaxBytes?: number;
  totalResultMaxBytes?: number;
}

export interface ToolRuntimeContext {
  phase: ToolPhase;
  signal?: AbortSignal;
  batchId?: string;
  revision?: number;
}

export interface PreparedFinalRequest extends ChatRequest {
  rounds: number;
  callsExecuted: number;
  succeededCalls: number;
  failedCalls: number;
  exhausted: boolean;
  degradedReason?: 'provider-tools-unsupported' | 'no-authorized-tools';
}

const DEFAULTS = {
  maxRounds: 6,
  maxCallsPerRound: 4,
  timeoutMs: 15_000,
  resultMaxBytes: 32 * 1024,
  totalResultMaxBytes: 64 * 1024
} as const;

export class ToolCallRuntime {
  private readonly maxRounds: number;
  private readonly maxCallsPerRound: number;
  private readonly timeoutMs: number;
  private readonly resultMaxBytes: number;
  private readonly totalResultMaxBytes: number;

  constructor(private readonly options: ToolCallRuntimeOptions) {
    this.maxRounds = Math.max(1, options.maxRounds ?? DEFAULTS.maxRounds);
    this.maxCallsPerRound = Math.max(1, options.maxCallsPerRound ?? DEFAULTS.maxCallsPerRound);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULTS.timeoutMs);
    this.resultMaxBytes = Math.max(256, options.resultMaxBytes ?? DEFAULTS.resultMaxBytes);
    this.totalResultMaxBytes = Math.max(this.resultMaxBytes, options.totalResultMaxBytes ?? DEFAULTS.totalResultMaxBytes);
  }

  hasAuthorizedTools(phase: ToolPhase): boolean {
    return this.options.policy.definitions(phase).length > 0;
  }

  async prepare(provider: ChatProvider, request: ChatRequest, context: ToolRuntimeContext): Promise<PreparedFinalRequest> {
    const initial: PreparedFinalRequest = {
      ...request,
      tools: undefined,
      toolChoice: 'none',
      rounds: 0,
      callsExecuted: 0,
      succeededCalls: 0,
      failedCalls: 0,
      exhausted: false
    };
    if (provider.supportsTools === false) return { ...initial, degradedReason: 'provider-tools-unsupported' };
    const definitions = this.options.policy.definitions(context.phase);
    if (definitions.length === 0) return { ...initial, degradedReason: 'no-authorized-tools' };

    const turns: ModelTurn[] = [...request.messages];
    let totalResultBytes = 0;
    let callsExecuted = 0;
    let succeededCalls = 0;
    let failedCalls = 0;
    let rounds = 0;
    let exhausted = false;
    let system = request.system;

    while (rounds < this.maxRounds) {
      if (context.signal?.aborted) throw context.signal.reason ?? new Error('tool runtime aborted');
      const result = await provider.complete({
        ...request,
        system,
        messages: turns,
        tools: definitions,
        toolChoice: 'auto'
      });
      const calls = result.toolCalls ?? [];
      if (calls.length === 0) break;
      rounds += 1;
      turns.push({ role: 'assistant_tool_call', calls });
      const boundedCalls = calls.slice(0, this.maxCallsPerRound);
      const overflow = calls.slice(this.maxCallsPerRound);
      const run = (call: ChatToolCall): Promise<ExecutionResult> => this.execute(call, context, totalResultBytes);
      const allRead = boundedCalls.every((call) => {
        const tool = this.options.policy.resolve(call.name);
        return tool?.risk === 'read' && this.options.policy.check(tool, context.phase).allowed;
      });
      const results = allRead ? await Promise.all(boundedCalls.map(run)) : await runSequential(boundedCalls, run);
      for (const item of [...results, ...overflow.map((call) => ({
        callId: call.id,
        name: call.name,
        content: 'tool call limit reached for this round',
        isError: true,
        bytes: byteLength('tool call limit reached for this round')
      }))]) {
        if (item.isError) failedCalls += 1;
        else succeededCalls += 1;
        const bounded = boundTotalResult(item, Math.max(0, this.totalResultMaxBytes - totalResultBytes));
        turns.push({ role: 'tool_result', callId: bounded.callId ?? '', name: bounded.name ?? 'unknown.tool', content: bounded.content, ...(bounded.isError ? { isError: true } : {}) });
        totalResultBytes += bounded.bytes;
      }
      callsExecuted += boundedCalls.length;
      if (rounds >= this.maxRounds) {
        exhausted = true;
        system = `${system ?? ''}\n\nSOOYA 工具调用预算已用完，请基于已有工具结果直接回答，不再调用工具。`.trim();
      }
    }

    return {
      ...request,
      system,
      messages: turns,
      tools: undefined,
      toolChoice: 'none',
      rounds,
      callsExecuted,
      succeededCalls,
      failedCalls,
      exhausted
    };
  }

  private async execute(call: ChatToolCall, context: ToolRuntimeContext, totalBytes: number): Promise<ExecutionResult> {
    const tool = this.options.policy.resolve(call.name);
    if (!tool) return executionError(call, 'unknown tool');
    const decision = this.options.policy.check(tool, context.phase);
    if (!decision.allowed) return executionError(call, `tool denied: ${decision.reason ?? 'policy'}`);
    if (call.argumentsError) return executionError(call, call.argumentsError);
    const validation = validateArguments(call.arguments, tool.inputSchema);
    if (validation) return executionError(call, validation);
    if (context.signal?.aborted) throw context.signal.reason ?? new Error('tool runtime aborted');

    const controller = new AbortController();
    const onAbort = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new ToolTimeoutError(`tool timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    try {
      const value = await tool.handler(call.arguments, { ...context, signal: controller.signal });
      const remaining = Math.max(256, this.totalResultMaxBytes - totalBytes);
      const normalized = normalizeToolResult(value, { maxBytes: Math.min(this.resultMaxBytes, remaining) });
      return { callId: call.id, name: tool.name, ...normalized };
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason ?? error;
      return { callId: call.id, name: tool.name, ...normalizeToolError(error, this.resultMaxBytes) };
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function boundTotalResult(item: ExecutionResult, remainingBytes: number): ExecutionResult {
  if (item.bytes <= remainingBytes) return item;
  if (remainingBytes <= 0) return { ...item, content: '', bytes: 0, isError: true };
  const marker = '\n[tool result truncated by SOOYA host: total result limit reached]';
  const markerBytes = byteLength(marker);
  const content = remainingBytes <= markerBytes
    ? clipUtf8(marker, remainingBytes)
    : `${clipUtf8(item.content, remainingBytes - markerBytes)}${marker}`;
  return { ...item, content, bytes: byteLength(content), isError: item.isError };
}

interface ExecutionResult {
  callId?: string;
  name?: string;
  content: string;
  isError?: boolean;
  bytes: number;
}

class ToolTimeoutError extends Error {
  override name = 'ToolTimeoutError';
}

function executionError(call: ChatToolCall, message: string): ExecutionResult {
  const normalized = normalizeToolError(new Error(message));
  return { callId: call.id, name: call.name, ...normalized };
}

async function runSequential<T>(items: T[], run: (item: T) => Promise<ExecutionResult>): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  for (const item of items) results.push(await run(item));
  return results;
}

export function validateArguments(value: unknown, schema: Record<string, unknown>): string | null {
  if (!isRecord(value)) return 'tool arguments must be an object';
  if (byteLength(JSON.stringify(value)) > 16 * 1024) return 'tool arguments exceed 16 KiB';
  if (containsUnsafeKey(value, 0)) return 'tool arguments contain a forbidden key';
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
  for (const key of required) if (!(key in value)) return `missing required argument: ${key}`;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, definition] of Object.entries(properties)) {
    if (!(key in value) || !isRecord(definition) || typeof definition.type !== 'string') continue;
    if (!matchesType(value[key], definition.type)) return `invalid argument type: ${key}`;
  }
  return null;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function containsUnsafeKey(value: unknown, depth: number): boolean {
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((item) => containsUnsafeKey(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    key === '__proto__' || key === 'prototype' || key === 'constructor' || containsUnsafeKey(child, depth + 1)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
