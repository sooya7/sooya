import type { ChatModelConfig } from '../../config/schema.js';
import { assertSafeUrl, withRetry, defaultRetryable, HttpTimeoutError } from '../../util/http.js';
import { withJsonInstruction } from '../../util/json-extract.js';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type ChatChunk,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type ChatToolCall,
  type ChatToolDefinition,
  type ModelTurn,
  type HealthStatus
} from '../types.js';

export interface ProviderDeps {
  allowPrivateNetwork: boolean;
  fetchImpl?: typeof fetch;
  /**
   * Advisory findings a provider noticed about a response that still succeeded
   * — e.g. an image endpoint that returned a different model, or a smaller
   * image, than was asked for. Reporting rather than throwing is deliberate:
   * the user has a usable result and the reply must not fail, but a silent
   * substitution has to be visible to the operator. See image-provenance.ts.
   */
  onProviderNotice?: (notice: { scope: string; message: string; detail?: Record<string, unknown> }) => void;
}

function joinUrl(base: string, suffix: string): string {
  const b = base.replace(/\/+$/, '');
  if (b.endsWith(suffix)) return b;
  return `${b}${suffix}`;
}

function withTimeout(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new HttpTimeoutError(`model request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * Reads an SSE body, dispatching each `data:` line.
 *
 * If the connection breaks mid-stream the error is re-thrown, but only after
 * everything already received has been dispatched. Dropping that text would
 * lose tokens the model genuinely produced — the caller decides what to do with
 * a partial reply, and the replier keeps partial text rather than discarding it.
 */
async function readSse(response: Response, onEvent: (data: string) => void): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const drainLines = (): boolean => {
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return true;
      onEvent(data);
    }
    return false;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (drainLines()) return;
    }
  } catch (err) {
    // Flush whatever arrived before the failure, then surface the error.
    try {
      drainLines();
    } catch {
      /* the consumer threw while handling a partial line; ignore */
    }
    throw err;
  }

  const tail = buffer.trim();
  if (tail.startsWith('data:')) {
    const data = tail.slice(5).trim();
    if (data && data !== '[DONE]') onEvent(data);
  }
}

/** OpenAI Chat Completions + any OpenAI-compatible third-party endpoint. */
export class OpenAIChatProvider implements ChatProvider {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;
  /**
   * Observed, not configured: flipped off the first time the endpoint refuses
   * `response_format`. Providers are rebuilt whenever model config changes, so
   * this never outlives the setup it was learned from.
   */
  private jsonModeSupported = true;

  constructor(
    private readonly cfg: ChatModelConfig,
    private readonly deps: ProviderDeps
  ) {
    this.name = cfg.provider;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.cfg.provider !== 'none' && !!this.cfg.baseUrl && !!this.cfg.model && !!this.cfg.apiKey;
  }

  get supportsTools(): boolean {
    return this.cfg.supportsTools;
  }

  private endpoint(): string {
    return joinUrl(this.cfg.baseUrl, '/chat/completions');
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.cfg.apiKey}`,
      ...this.cfg.extraHeaders
    };
  }

  private body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    // `jsonMode` is what the caller needs, `response_format` is only one way to
    // get it. When the endpoint has rejected that field once, the constraint
    // moves into the prompt instead of being dropped on the floor.
    const nativeJson = req.jsonMode === true && this.jsonModeSupported;
    const system = req.jsonMode === true && !nativeJson ? withJsonInstruction(req.system) : req.system;
    const messages: Array<Record<string, unknown>> = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const turn of req.messages) messages.push(toOpenAiMessage(turn));
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      max_tokens: req.maxTokens ?? this.cfg.maxTokens,
      temperature: req.temperature ?? this.cfg.temperature,
      stream
    };
    if (nativeJson) body.response_format = { type: 'json_object' };
    if (this.cfg.supportsTools && req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(toOpenAiTool);
      if (req.toolChoice !== undefined) body.tool_choice = toOpenAiToolChoice(req.toolChoice);
    }
    return body;
  }

  /**
   * Config declares JSON mode the same way it declares vision: statically. An
   * endpoint that 4xx's on `response_format` used to fail the whole extraction,
   * which the callers then swallowed as "no memories worth keeping" -- a silent
   * downgrade with no visible symptom. Retry once under a prompt constraint and
   * remember the answer, so later calls skip the doomed request entirely.
   */
  async complete(req: ChatRequest): Promise<ChatResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('chat');
    const wantsJson = req.jsonMode === true;
    const degradedAlready = wantsJson && !this.jsonModeSupported;
    try {
      const result = await this.completeOnce(req);
      return degradedAlready ? { ...result, jsonModeDegraded: true } : result;
    } catch (err) {
      if (!wantsJson || !this.jsonModeSupported || !isJsonModeRejection(err as Error)) throw err;
      this.jsonModeSupported = false;
      const result = await this.completeOnce(req);
      return { ...result, jsonModeDegraded: true };
    }
  }

  private async completeOnce(req: ChatRequest): Promise<ChatResult> {
    return withRetry(
      async () => {
        const { signal, cancel } = withTimeout(this.cfg.timeoutMs, req.signal);
        try {
          await assertSafeUrl(this.endpoint(), this.deps.allowPrivateNetwork);
          const res = await this.fetchImpl(this.endpoint(), {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(this.body(req, false)),
            signal
          });
          if (!res.ok) throw new ProviderRequestError(`chat request failed with status ${res.status}: ${await safeText(res)}`, res.status);
          const json = (await res.json()) as {
            choices?: Array<{
              message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string | null } }> };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const message = json.choices?.[0]?.message;
          return {
            text: message?.content ?? '',
            toolCalls: parseOpenAiToolCalls(message?.tool_calls),
            finishReason: json.choices?.[0]?.finish_reason,
            usage: { promptTokens: json.usage?.prompt_tokens, completionTokens: json.usage?.completion_tokens },
            model: this.cfg.model
          };
        } catch (err) {
          throw normalizeAbort(err, this.cfg.timeoutMs);
        } finally {
          cancel();
        }
      },
      { retries: this.cfg.maxRetries }
    );
  }

  async stream(req: ChatRequest, onChunk: (c: ChatChunk) => void): Promise<ChatResult> {
    // Retries are applied here so `maxRetries` also governs streamed requests -- but
    // only for requests that actually stream. When the model cannot stream, `streamOnce`
    // delegates to `complete()`, which runs a retry ladder of its own; applying this one
    // as well multiplied them into (maxRetries + 1)^2 requests.
    const retries = this.cfg.supportsStreaming ? this.cfg.maxRetries : 0;
    return streamWithRetry(retries, (emit) => this.streamOnce(req, emit), onChunk);
  }

  private async streamOnce(req: ChatRequest, emit: (c: ChatChunk) => void): Promise<ChatResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('chat');
    if (!this.cfg.supportsStreaming) {
      const result = await this.complete(req);
      if (result.text) emit({ delta: result.text });
      return result;
    }
    const { signal, cancel } = withTimeout(this.cfg.timeoutMs, req.signal);
    try {
      await assertSafeUrl(this.endpoint(), this.deps.allowPrivateNetwork);
      const res = await this.fetchImpl(this.endpoint(), {
        method: 'POST',
        headers: { ...this.headers(), accept: 'text/event-stream' },
        body: JSON.stringify(this.body(req, true)),
        signal
      });
      if (!res.ok) throw new ProviderRequestError(`chat stream failed with status ${res.status}: ${await safeText(res)}`, res.status);
      let text = '';
      let finishReason: string | undefined;
      await readSse(res, (data) => {
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
          };
          const choice = parsed.choices?.[0];
          const delta = choice?.delta?.content;
          if (delta) {
            text += delta;
            emit({ delta });
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        } catch {
          /* ignore malformed keepalive chunks */
        }
      });
      return { text, finishReason, model: this.cfg.model };
    } catch (err) {
      throw normalizeAbort(err, this.cfg.timeoutMs);
    } finally {
      cancel();
    }
  }

  async inspectHealth(): Promise<HealthStatus> {
    const base: HealthStatus = {
      capability: 'chat',
      configured: this.configured,
      ok: false,
      provider: this.cfg.provider,
      model: this.cfg.model || undefined,
      checkedAt: new Date().toISOString()
    };
    if (!this.configured) return { ...base, detail: 'not configured' };
    try {
      await assertSafeUrl(this.endpoint(), this.deps.allowPrivateNetwork);
      return { ...base, ok: true, detail: 'configured (endpoint not called)' };
    } catch (err) {
      return { ...base, detail: (err as Error).message };
    }
  }
}

/** OpenAI Responses API style adapter. */
export class OpenAIResponsesProvider implements ChatProvider {
  readonly name = 'openai-responses';
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly cfg: ChatModelConfig,
    private readonly deps: ProviderDeps
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return !!this.cfg.baseUrl && !!this.cfg.model && !!this.cfg.apiKey;
  }

  get supportsTools(): boolean {
    return this.cfg.supportsTools;
  }

  private endpoint(): string {
    return joinUrl(this.cfg.baseUrl, '/responses');
  }

  private body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const input = req.messages.flatMap(toResponsesInput);
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      input,
      max_output_tokens: req.maxTokens ?? this.cfg.maxTokens,
      temperature: req.temperature ?? this.cfg.temperature,
      stream
    };
    if (req.system) body.instructions = req.system;
    if (this.cfg.supportsTools && req.tools && req.tools.length > 0) {
      const tools: Array<Record<string, unknown>> = req.tools.map(toResponsesTool);
      if (req.webSearch?.enabled) tools.push({ type: 'web_search', ...responsesSearchLocation(req.webSearch.userLocation) });
      body.tools = tools;
      if (req.toolChoice !== undefined) body.tool_choice = toResponsesToolChoice(req.toolChoice);
    } else if (req.webSearch?.enabled) {
      const location = req.webSearch.userLocation;
      const approximate = location
        ? Object.fromEntries(
            Object.entries({
              type: 'approximate',
              country: location.countryCode?.trim().toUpperCase(),
              region: location.region?.trim(),
              city: location.city?.trim()
            }).filter(([, value]) => Boolean(value))
          )
        : null;
      body.tools = [{
        type: 'web_search',
        ...(approximate && Object.keys(approximate).length > 1 ? { user_location: approximate } : {})
      }];
    }
    return body;
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('chat');
    return withRetry(
      async () => {
        const { signal, cancel } = withTimeout(this.cfg.timeoutMs, req.signal);
        try {
          await assertSafeUrl(this.endpoint(), this.deps.allowPrivateNetwork);
          const res = await this.fetchImpl(this.endpoint(), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.cfg.apiKey}`,
              ...this.cfg.extraHeaders
            },
            body: JSON.stringify(this.body(req, false)),
            signal
          });
          if (!res.ok)
            throw new ProviderRequestError(`responses request failed with status ${res.status}: ${await safeText(res)}`, res.status);
          const json = (await res.json()) as ResponsesPayload;
          return {
            text: extractResponsesText(json),
            toolCalls: parseResponsesToolCalls(json.output),
            model: this.cfg.model,
            ...(req.webSearch?.enabled ? { webSearch: extractResponsesWebSearch(json) } : {})
          };
        } catch (err) {
          throw normalizeAbort(err, this.cfg.timeoutMs);
        } finally {
          cancel();
        }
      },
      { retries: this.cfg.maxRetries }
    );
  }

  async stream(req: ChatRequest, onChunk: (c: ChatChunk) => void): Promise<ChatResult> {
    // Retries are applied here so `maxRetries` also governs streamed requests -- but
    // only for requests that actually stream. When the model cannot stream, `streamOnce`
    // delegates to `complete()`, which runs a retry ladder of its own; applying this one
    // as well multiplied them into (maxRetries + 1)^2 requests.
    const retries = this.cfg.supportsStreaming ? this.cfg.maxRetries : 0;
    return streamWithRetry(retries, (emit) => this.streamOnce(req, emit), onChunk);
  }

  private async streamOnce(req: ChatRequest, emit: (c: ChatChunk) => void): Promise<ChatResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('chat');
    if (!this.cfg.supportsStreaming) {
      const r = await this.complete(req);
      if (r.text) emit({ delta: r.text });
      return r;
    }
    const { signal, cancel } = withTimeout(this.cfg.timeoutMs, req.signal);
    try {
      await assertSafeUrl(this.endpoint(), this.deps.allowPrivateNetwork);
      const res = await this.fetchImpl(this.endpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
          accept: 'text/event-stream',
          ...this.cfg.extraHeaders
        },
        body: JSON.stringify(this.body(req, true)),
        signal
      });
      if (!res.ok)
        throw new ProviderRequestError(`responses stream failed with status ${res.status}: ${await safeText(res)}`, res.status);
      let text = '';
      let completedResponse: ResponsesPayload | undefined;
      await readSse(res, (data) => {
        try {
          const evt = JSON.parse(data) as { type?: string; delta?: string; response?: ResponsesPayload };
          if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
            text += evt.delta;
            emit({ delta: evt.delta });
          } else if (evt.type === 'response.completed' && evt.response) {
            completedResponse = evt.response;
            if (!text) {
              text = extractResponsesText(evt.response);
              if (text) emit({ delta: text });
            }
          }
        } catch {
          /* ignore */
        }
      });
      return {
        text,
        model: this.cfg.model,
        ...(req.webSearch?.enabled
          ? { webSearch: extractResponsesWebSearch(completedResponse ?? { output_text: text }) }
          : {})
      };
    } catch (err) {
      throw normalizeAbort(err, this.cfg.timeoutMs);
    } finally {
      cancel();
    }
  }

  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'chat',
      configured: this.configured,
      ok: this.configured,
      provider: this.name,
      model: this.cfg.model || undefined,
      detail: this.configured ? 'configured (endpoint not called)' : 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

interface ResponsesPayload {
  output_text?: string | string[];
  output?: Array<{
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string | Record<string, unknown>;
    status?: string;
    role?: string;
    action?: { type?: string; url?: string };
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ type?: string; title?: string; url?: string }>;
    }>;
  }>;
}

function toResponsesInput(turn: ModelTurn): Array<Record<string, unknown>> {
  if (turn.role === 'assistant_tool_call') {
    return turn.calls.map((call) => ({
      type: 'function_call',
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.arguments)
    }));
  }
  if (turn.role === 'tool_result') {
    return [{ type: 'function_call_output', call_id: turn.callId, output: turn.content }];
  }
  if (turn.role === 'system') return [];
  return [{
    role: turn.role,
    content: turn.content.map((part) =>
      part.type === 'text'
        ? { type: turn.role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
        : { type: 'input_image', image_url: `data:${part.mime};base64,${part.data}` }
    )
  }];
}

function toResponsesTool(tool: ChatToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.inputSchema
  };
}

function responsesSearchLocation(location: NonNullable<ChatRequest['webSearch']>['userLocation']): Record<string, unknown> {
  if (!location || typeof location !== 'object') return {};
  const approximate = Object.fromEntries(
    Object.entries({
      type: 'approximate',
      country: location.countryCode?.trim().toUpperCase(),
      region: location.region?.trim(),
      city: location.city?.trim()
    }).filter(([, value]) => Boolean(value))
  );
  return Object.keys(approximate).length > 1 ? { user_location: approximate } : {};
}

function toResponsesToolChoice(choice: NonNullable<ChatRequest['toolChoice']>): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.name };
}

function parseResponsesToolCalls(output: ResponsesPayload['output']): ChatToolCall[] | undefined {
  const calls = (output ?? []).filter((item) => item.type === 'function_call');
  if (calls.length === 0) return undefined;
  return calls.map((call, index) => {
    const parsed = parseToolArguments(call.arguments ?? '{}');
    return {
      id: call.call_id?.trim() || call.id?.trim() || `tool-call-${index + 1}`,
      name: call.name?.trim() || 'unknown.tool',
      arguments: parsed.arguments,
      ...(parsed.error ? { argumentsError: parsed.error } : {})
    };
  });
}

function toAnthropicMessages(turn: ModelTurn): Array<{ role: string; content: Array<Record<string, unknown>> }> {
  if (turn.role === 'assistant_tool_call') {
    return [{
      role: 'assistant',
      content: turn.calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }))
    }];
  }
  if (turn.role === 'tool_result') {
    return [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: turn.callId, content: turn.content, ...(turn.isError ? { is_error: true } : {}) }]
    }];
  }
  return [{
    role: turn.role,
    content: turn.content.map((part) =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'image', source: { type: 'base64', media_type: part.mime, data: part.data } }
    )
  }];
}

function toAnthropicTool(tool: ChatToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.inputSchema
  };
}

function toAnthropicToolChoice(choice: NonNullable<ChatRequest['toolChoice']>): unknown {
  if (choice === 'none') return { type: 'none' };
  if (choice === 'auto') return { type: 'auto' };
  return { type: 'tool', name: choice.name };
}

function parseAnthropicToolCalls(content: Array<{ type: string; id?: string; name?: string; input?: unknown }> | undefined): ChatToolCall[] | undefined {
  const calls = (content ?? []).filter((item) => item.type === 'tool_use');
  if (calls.length === 0) return undefined;
  return calls.map((call, index) => {
    const parsed = parseToolArguments(call.input as Record<string, unknown>);
    return {
      id: call.id?.trim() || `tool-call-${index + 1}`,
      name: call.name?.trim() || 'unknown.tool',
      arguments: parsed.arguments,
      ...(parsed.error ? { argumentsError: parsed.error } : {})
    };
  });
}

function extractResponsesText(json: ResponsesPayload): string {
  if (typeof json.output_text === 'string') return json.output_text;
  if (Array.isArray(json.output_text)) return json.output_text.join('');
  const finalMessages = (json.output ?? []).filter(
    (item) => item.type === 'message' && item.role === 'assistant' && item.status === 'completed'
  );
  if (finalMessages.length > 0) {
    const final = finalMessages[finalMessages.length - 1]!;
    return (final.content ?? [])
      .filter((content) => content.type === 'output_text' && typeof content.text === 'string')
      .map((content) => content.text!)
      .join('');
  }
  const parts: string[] = [];
  for (const item of json.output ?? []) {
    for (const c of item.content ?? []) {
      if (typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('');
}

function extractResponsesWebSearch(json: ResponsesPayload): NonNullable<ChatResult['webSearch']> {
  const callCount = (json.output ?? []).filter((item) => item.type === 'web_search_call').length;
  const finalMessages = (json.output ?? []).filter(
    (item) => item.type === 'message' && item.role === 'assistant' && item.status === 'completed'
  );
  const final = finalMessages[finalMessages.length - 1];
  const seen = new Set<string>();
  const citations: Array<{ title: string; url: string }> = [];
  const addCitation = (value: string, title?: string): void => {
    const url = safeCitationUrl(value);
    if (!url || seen.has(url) || citations.length >= 5) return;
    seen.add(url);
    citations.push({ title: title?.trim() || new URL(url).hostname, url });
  };
  for (const content of final?.content ?? []) {
    for (const annotation of content.annotations ?? []) {
      if (annotation.type !== 'url_citation' || !annotation.url) continue;
      addCitation(annotation.url, annotation.title);
      if (citations.length >= 5) break;
    }
    if (citations.length >= 5) break;
  }
  for (const item of json.output ?? []) {
    if (item.type === 'web_search_call' && item.action?.type === 'open_page' && item.action.url) {
      addCitation(item.action.url);
    }
  }
  for (const match of extractResponsesText(json).matchAll(/https?:\/\/[^\s<>"'）。，、；！？]+/giu)) {
    addCitation(match[0].replace(/[),.;!?]+$/u, ''));
  }
  return { used: callCount > 0, callCount, citations };
}

function safeCitationUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Anthropic Messages API adapter. */
export class AnthropicChatProvider implements ChatProvider {
  readonly name = 'anthropic-messages';
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly cfg: ChatModelConfig,
    private readonly deps: ProviderDeps
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return !!this.cfg.baseUrl && !!this.cfg.model && !!this.cfg.apiKey;
  }

  get supportsTools(): boolean {
    return this.cfg.supportsTools;
  }

  private endpoint(): string {
    return joinUrl(this.cfg.baseUrl, '/messages');
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.cfg.apiKey,
      'anthropic-version': '2023-06-01',
      ...this.cfg.extraHeaders
    };
  }

  private body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const messages = req.messages.flatMap(toAnthropicMessages).filter((message) => message.role !== 'system');
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      max_tokens: req.maxTokens ?? this.cfg.maxTokens,
      temperature: req.temperature ?? this.cfg.temperature,
      stream
    };
    if (req.system) body.system = req.system;
    if (this.cfg.supportsTools && req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(toAnthropicTool);
      if (req.toolChoice !== undefined) body.tool_choice = toAnthropicToolChoice(req.toolChoice);
    }
    return body;
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('chat');
    return withRetry(
      async () => {
        const { signal, cancel } = withTimeout(this.cfg.timeoutMs, req.signal);
        try {
          await assertSafeUrl(this.endpoint(), this.deps.allowPrivateNetwork);
          const res = await this.fetchImpl(this.endpoint(), {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(this.body(req, false)),
            signal
          });
          if (!res.ok)
            throw new ProviderRequestError(`anthropic request failed with status ${res.status}: ${await safeText(res)}`, res.status);
          const json = (await res.json()) as {
            content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
            stop_reason?: string;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          const text = (json.content ?? [])
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text!)
            .join('');
          return {
            text,
            toolCalls: parseAnthropicToolCalls(json.content),
            finishReason: json.stop_reason,
            usage: { promptTokens: json.usage?.input_tokens, completionTokens: json.usage?.output_tokens },
            model: this.cfg.model
          };
        } catch (err) {
          throw normalizeAbort(err, this.cfg.timeoutMs);
        } finally {
          cancel();
        }
      },
      { retries: this.cfg.maxRetries }
    );
  }

  async stream(req: ChatRequest, onChunk: (c: ChatChunk) => void): Promise<ChatResult> {
    // Retries are applied here so `maxRetries` also governs streamed requests -- but
    // only for requests that actually stream. When the model cannot stream, `streamOnce`
    // delegates to `complete()`, which runs a retry ladder of its own; applying this one
    // as well multiplied them into (maxRetries + 1)^2 requests.
    const retries = this.cfg.supportsStreaming ? this.cfg.maxRetries : 0;
    return streamWithRetry(retries, (emit) => this.streamOnce(req, emit), onChunk);
  }

  private async streamOnce(req: ChatRequest, emit: (c: ChatChunk) => void): Promise<ChatResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('chat');
    if (!this.cfg.supportsStreaming) {
      const r = await this.complete(req);
      if (r.text) emit({ delta: r.text });
      return r;
    }
    const { signal, cancel } = withTimeout(this.cfg.timeoutMs, req.signal);
    try {
      await assertSafeUrl(this.endpoint(), this.deps.allowPrivateNetwork);
      const res = await this.fetchImpl(this.endpoint(), {
        method: 'POST',
        headers: { ...this.headers(), accept: 'text/event-stream' },
        body: JSON.stringify(this.body(req, true)),
        signal
      });
      if (!res.ok)
        throw new ProviderRequestError(`anthropic stream failed with status ${res.status}: ${await safeText(res)}`, res.status);
      let text = '';
      let finishReason: string | undefined;
      await readSse(res, (data) => {
        try {
          const evt = JSON.parse(data) as {
            type?: string;
            delta?: { type?: string; text?: string; stop_reason?: string };
          };
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
            text += evt.delta.text;
            emit({ delta: evt.delta.text });
          } else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
            finishReason = evt.delta.stop_reason;
          }
        } catch {
          /* ignore */
        }
      });
      return { text, finishReason, model: this.cfg.model };
    } catch (err) {
      throw normalizeAbort(err, this.cfg.timeoutMs);
    } finally {
      cancel();
    }
  }

  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'chat',
      configured: this.configured,
      ok: this.configured,
      provider: this.name,
      model: this.cfg.model || undefined,
      detail: this.configured ? 'configured (endpoint not called)' : 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

/** Null object used whenever chat is not configured; never throws at boot. */
export class UnconfiguredChatProvider implements ChatProvider {
  readonly name = 'none';
  readonly configured = false;
  readonly supportsTools = false;
  async complete(): Promise<ChatResult> {
    throw new ProviderNotConfiguredError('chat');
  }
  async stream(): Promise<ChatResult> {
    throw new ProviderNotConfiguredError('chat');
  }
  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'chat',
      configured: false,
      ok: false,
      provider: 'none',
      detail: 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

export function createChatProvider(cfg: ChatModelConfig, deps: ProviderDeps): ChatProvider {
  switch (cfg.provider) {
    case 'openai-chat':
    case 'openai-compatible':
      return new OpenAIChatProvider(cfg, deps);
    case 'openai-responses':
      return new OpenAIResponsesProvider(cfg, deps);
    case 'anthropic-messages':
      return new AnthropicChatProvider(cfg, deps);
    default:
      return new UnconfiguredChatProvider();
  }
}

/**
 * Runs one streaming attempt under the provider's retry policy.
 *
 * `complete()` has always been wrapped in `withRetry`, but `stream()` was not,
 * so `maxRetries` silently had no effect on streamed chat. A stream cannot be
 * retried unconditionally though: once a delta has reached the caller, replaying
 * the request would duplicate visible text in the user's bubble. An attempt is
 * therefore retried only when it failed *before* emitting anything.
 */
async function streamWithRetry(
  maxRetries: number,
  attempt: (emit: (c: ChatChunk) => void) => Promise<ChatResult>,
  onChunk: (c: ChatChunk) => void
): Promise<ChatResult> {
  let emitted = false;
  const emit = (c: ChatChunk) => {
    emitted = true;
    onChunk(c);
  };
  return withRetry(
    () => {
      emitted = false;
      return attempt(emit);
    },
    {
      retries: maxRetries,
      isRetryable: (err) => !emitted && defaultRetryable(err)
    }
  );
}

export async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return '<no body>';
  }
}

/**
 * A 4xx that names `response_format` / JSON mode, i.e. the endpoint does not
 * implement the field. 5xx and timeouts are transient and must keep retrying
 * the same way as before.
 */
const JSON_MODE_REJECTION = /response_format|json_object|json_schema|json mode|structured output/i;

export function isJsonModeRejection(err: Error): boolean {
  const status = (err as { status?: number }).status;
  if (typeof status !== 'number' || status < 400 || status >= 500) return false;
  return JSON_MODE_REJECTION.test(err.message);
}

export function normalizeAbort(err: unknown, timeoutMs: number): Error {
  const e = err as Error;
  if (e instanceof HttpTimeoutError) return e;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return new HttpTimeoutError(`model request timed out after ${timeoutMs}ms`);
  if (typeof e?.message === 'string' && e.message.includes('timed out')) return new HttpTimeoutError(e.message);
  return e;
}

function toOpenAiMessage(turn: ModelTurn): Record<string, unknown> {
  if (turn.role === 'assistant_tool_call') {
    return {
      role: 'assistant',
      content: null,
      tool_calls: turn.calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      }))
    };
  }
  if (turn.role === 'tool_result') {
    return { role: 'tool', tool_call_id: turn.callId, name: turn.name, content: turn.content };
  }
  const onlyText = turn.content.every((p) => p.type === 'text');
  if (onlyText) {
    return { role: turn.role, content: turn.content.map((p) => (p as { text: string }).text).join('\n') };
  }
  return {
    role: turn.role,
    content: turn.content.map((p) =>
      p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } }
    )
  };
}

function toOpenAiTool(tool: ChatToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema
    }
  };
}

function toOpenAiToolChoice(choice: NonNullable<ChatRequest['toolChoice']>): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function parseOpenAiToolCalls(calls: Array<{ id?: string; function?: { name?: string; arguments?: string | null } }> | undefined): ChatToolCall[] | undefined {
  if (!calls || calls.length === 0) return undefined;
  return calls.map((call, index) => {
    const raw = call.function?.arguments ?? '{}';
    const parsed = parseToolArguments(raw);
    return {
      id: call.id?.trim() || `tool-call-${index + 1}`,
      name: call.function?.name?.trim() || 'unknown.tool',
      arguments: parsed.arguments,
      ...(parsed.error ? { argumentsError: parsed.error } : {})
    };
  });
}

function parseToolArguments(raw: string | Record<string, unknown>): { arguments: Record<string, unknown>; error?: string } {
  if (typeof raw !== 'string') return isRecord(raw) ? { arguments: raw } : { arguments: {}, error: 'tool arguments must be an object' };
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? { arguments: parsed } : { arguments: {}, error: 'tool arguments must be an object' };
  } catch {
    return { arguments: {}, error: 'invalid JSON arguments' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
