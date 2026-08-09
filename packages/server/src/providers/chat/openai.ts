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
  type ChatTurn,
  type HealthStatus
} from '../types.js';

export interface ProviderDeps {
  allowPrivateNetwork: boolean;
  fetchImpl?: typeof fetch;
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
            choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          return {
            text: json.choices?.[0]?.message?.content ?? '',
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

  private endpoint(): string {
    return joinUrl(this.cfg.baseUrl, '/responses');
  }

  private body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const input = req.messages.map((turn) => ({
      role: turn.role,
      content: turn.content.map((p) =>
        p.type === 'text'
          ? { type: turn.role === 'assistant' ? 'output_text' : 'input_text', text: p.text }
          : { type: 'input_image', image_url: `data:${p.mime};base64,${p.data}` }
      )
    }));
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      input,
      max_output_tokens: req.maxTokens ?? this.cfg.maxTokens,
      temperature: req.temperature ?? this.cfg.temperature,
      stream
    };
    if (req.system) body.instructions = req.system;
    if (req.webSearch?.enabled) {
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
  for (const content of final?.content ?? []) {
    for (const annotation of content.annotations ?? []) {
      if (annotation.type !== 'url_citation' || !annotation.url) continue;
      const url = safeCitationUrl(annotation.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      citations.push({ title: annotation.title?.trim() || new URL(url).hostname, url });
      if (citations.length >= 5) break;
    }
    if (citations.length >= 5) break;
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
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((turn) => ({
        role: turn.role,
        content: turn.content.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }
        )
      }));
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      max_tokens: req.maxTokens ?? this.cfg.maxTokens,
      temperature: req.temperature ?? this.cfg.temperature,
      stream
    };
    if (req.system) body.system = req.system;
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
            content?: Array<{ type: string; text?: string }>;
            stop_reason?: string;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          const text = (json.content ?? [])
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text!)
            .join('');
          return {
            text,
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

function toOpenAiMessage(turn: ChatTurn): Record<string, unknown> {
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
