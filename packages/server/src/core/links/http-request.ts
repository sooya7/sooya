/**
 * http_request: let her call any public HTTP API.
 *
 * A key from the secret vault is filled in here, on the server: she names the
 * secret, never sees its value, and every byte handed back to her (body,
 * headers, errors) has that value masked in case the API echoes it. Internal
 * addresses are refused on every redirect hop, and a redirect to another
 * origin drops the key so it cannot be carried away.
 */
import { assertSafeUrl } from '../../util/http.js';
import type { ToolDescriptor, ToolExecutionContext } from '../../agent/registry.js';

const REQUEST_TIMEOUT_MS = 12_000;
/** A direct attempt that fails this fast looks like a block, not a dead API: retry via the proxy. */
const FAST_FAILURE_MS = 3_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_BODY_RETURN_BYTES = 16 * 1024;
const MASK = '[密钥]';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
const KEPT_HEADERS = /^(content-type|content-length|location|retry-after|(x-)?ratelimit-.*|x-rate-limit-.*)$/i;
const BINARY_TYPE = /^(image|audio|video|font)\/|^application\/(octet-stream|pdf|zip|gzip|x-tar|x-7z|vnd\.|msword|wasm)/i;

export interface HttpRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
  secret?: string;
  auth?: string;
  proxy?: boolean;
}

/** What gets logged: never a value, only which secret was used. */
export interface HttpRequestAudit {
  method: string;
  host: string;
  status: number | null;
  durationMs: number;
  secret?: string;
  viaProxy: boolean;
  error?: string;
}

export interface HttpRequestDeps {
  /** Direct fetch (domestic APIs). */
  directFetchImpl: typeof fetch;
  /** Fetch through the outbound proxy (foreign APIs). Same as direct when no proxy is set. */
  proxyFetchImpl: typeof fetch;
  /** Resolves a secret vault name to its value; null when there is no such secret. */
  readSecret: (name: string, signal?: AbortSignal) => Promise<string | null>;
  onAudit?: (event: HttpRequestAudit, context?: ToolExecutionContext) => void;
  /** Test seams; production uses the shared SSRF check and the 12 s budget. */
  assertUrl?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

class RefusedError extends Error {}

export function httpRequestTool(deps: HttpRequestDeps): ToolDescriptor<HttpRequestInput> {
  return {
    name: 'web.http_request',
    modelName: 'http_request',
    description: '向任意网址发 HTTP 请求并拿回结果，用来调用各种 API。需要鉴权时用 secret 填密钥库里的名字（不知道名字就先用 secret_list 查），服务器会替你填上，你不需要也看不到 Key 的值；auth 决定 Key 放在哪：默认 bearer，也可以写 header:x-api-key 或 query:key。Google、OpenAI 这类国外服务把 proxy 设为 true。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整的 http/https 地址' },
        method: { type: 'string', enum: [...METHODS], description: '默认 GET' },
        headers: { type: 'object', description: '额外的请求头，可选' },
        body: { description: '请求体：字符串原样发送；对象会转成 JSON 并自动加 content-type: application/json' },
        secret: { type: 'string', description: '密钥库里的名字，例如 fish-audio/api-key' },
        auth: { type: 'string', description: 'Key 放哪：bearer（默认）/ header:<请求头名> / query:<参数名>' },
        proxy: { type: 'boolean', description: '走代理，访问国外服务时设为 true' }
      },
      required: ['url']
    },
    source: 'local',
    risk: 'external_side_effect',
    phases: ['reply'],
    allowInReply: true,
    maxArgumentBytes: 64 * 1024,
    handler: async (input, context) => {
      const started = Date.now();
      const method = normalizeMethod(input.method);
      let host = '';
      let secretValue: string | null = null;
      let viaProxy = input.proxy === true;
      const audit = (status: number | null, error?: string): void => deps.onAudit?.({
        method, host, status, durationMs: Date.now() - started, viaProxy,
        ...(input.secret ? { secret: input.secret } : {}),
        ...(error ? { error: error.slice(0, 200) } : {})
      }, context);
      try {
        const url = parseUrl(input.url);
        host = url.host;
        if (input.secret) {
          secretValue = await deps.readSecret(input.secret.trim(), context?.signal);
          if (!secretValue) throw new Error(`密钥库里没有叫 ${input.secret} 的 Key，先用 secret_list 看看准确的名字`);
        }
        const placement = parseAuth(input.auth);
        const request = buildRequest(method, input, url, secretValue, placement);
        const result = await sendWithFallback(deps, request, viaProxy, context?.signal);
        viaProxy = result.viaProxy;
        audit(result.response.status);
        const text = await describeResponse(result.response, method, result.finalUrl, Date.now() - started, result.fellBack);
        return mask(text, secretValue);
      } catch (error) {
        if (context?.signal?.aborted) throw error;
        const message = mask(friendlyError(error), secretValue);
        audit(null, message);
        throw new Error(message);
      }
    }
  };
}

type Placement = { kind: 'bearer' } | { kind: 'header'; name: string } | { kind: 'query'; name: string };

interface PreparedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
  /** Headers / query param that carry the secret; dropped on a cross-origin hop. */
  secretHeader: string | null;
  secretQuery: string | null;
}

function normalizeMethod(raw: unknown): string {
  const method = typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : 'GET';
  if (!(METHODS as readonly string[]).includes(method)) throw new RefusedError(`不支持的方法 ${method}，只能用 ${METHODS.join('/')}`);
  return method;
}

function parseUrl(raw: unknown): URL {
  const text = String(raw ?? '').trim();
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    return url;
  } catch {
    throw new RefusedError('url 要是完整的 http:// 或 https:// 地址');
  }
}

function parseAuth(raw: unknown): Placement {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.toLowerCase() === 'bearer') return { kind: 'bearer' };
  const match = /^(header|query):\s*([A-Za-z0-9_.-]+)$/i.exec(text);
  if (!match) throw new RefusedError('auth 只能是 bearer、header:<请求头名> 或 query:<参数名>');
  return { kind: match[1]!.toLowerCase() as 'header' | 'query', name: match[2]! };
}

function buildRequest(method: string, input: HttpRequestInput, url: URL, secret: string | null, placement: Placement): PreparedRequest {
  const headers = new Headers();
  if (input.headers && typeof input.headers === 'object') {
    for (const [key, value] of Object.entries(input.headers)) {
      if (value === undefined || value === null) continue;
      if (/^(host|content-length|connection|transfer-encoding)$/i.test(key)) continue;
      headers.set(key, String(value));
    }
  }
  let body: string | undefined;
  if (input.body !== undefined && input.body !== null && method !== 'GET' && method !== 'HEAD') {
    if (typeof input.body === 'string') body = input.body;
    else {
      body = JSON.stringify(input.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
  }
  if (!headers.has('accept')) headers.set('accept', 'application/json, text/plain;q=0.9, */*;q=0.5');
  if (!headers.has('user-agent')) headers.set('user-agent', 'SOOYA/1.0 (+http_request)');
  let secretHeader: string | null = null;
  let secretQuery: string | null = null;
  if (secret) {
    if (placement.kind === 'bearer') { headers.set('authorization', `Bearer ${secret}`); secretHeader = 'authorization'; }
    else if (placement.kind === 'header') { headers.set(placement.name, secret); secretHeader = placement.name; }
    else { url.searchParams.set(placement.name, secret); secretQuery = placement.name; }
  }
  return { url, method, headers, body, secretHeader, secretQuery };
}

interface SendResult {
  response: Response;
  finalUrl: URL;
  viaProxy: boolean;
  fellBack: boolean;
}

async function sendWithFallback(deps: HttpRequestDeps, request: PreparedRequest, useProxy: boolean, signal?: AbortSignal): Promise<SendResult> {
  const deadline = Date.now() + (deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  if (useProxy) return { ...(await follow(deps, request, true, deadline, signal)), viaProxy: true, fellBack: false };
  const started = Date.now();
  try {
    return { ...(await follow(deps, request, false, deadline, signal)), viaProxy: false, fellBack: false };
  } catch (error) {
    if (signal?.aborted || error instanceof RefusedError) throw error;
    if (Date.now() - started > FAST_FAILURE_MS || !looksBlocked(error)) throw error;
    return { ...(await follow(deps, request, true, deadline, signal)), viaProxy: true, fellBack: true };
  }
}

async function follow(deps: HttpRequestDeps, initial: PreparedRequest, viaProxy: boolean, deadline: number, signal?: AbortSignal): Promise<{ response: Response; finalUrl: URL }> {
  const fetchImpl = viaProxy ? deps.proxyFetchImpl : deps.directFetchImpl;
  const origin = initial.url.origin;
  let url = new URL(initial.url);
  let method = initial.method;
  let body = initial.body;
  const headers = new Headers(initial.headers);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await checkUrl(deps, url, viaProxy);
    const response = await fetchWithDeadline(fetchImpl, url, { method, headers, body, redirect: 'manual' }, deadline, signal);
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return { response, finalUrl: url };
    await response.body?.cancel().catch(() => undefined);
    const next = new URL(location, url);
    if (next.origin !== origin) {
      // Leaving the origin the key was meant for: it must not travel along.
      if (initial.secretHeader) headers.delete(initial.secretHeader);
      if (initial.secretQuery) next.searchParams.delete(initial.secretQuery);
      headers.delete('authorization');
      headers.delete('cookie');
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
    }
    url = next;
  }
  throw new Error('跳转次数太多');
}

async function checkUrl(deps: HttpRequestDeps, url: URL, viaProxy: boolean): Promise<void> {
  try {
    if (deps.assertUrl) await deps.assertUrl(url.toString());
    else await assertSafeUrl(url.toString(), false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Through a socks5h proxy the name is resolved on the far side, so a local
    // lookup failure (a blocked site) is no reason to refuse. Internal targets are.
    if (message.startsWith('dns ')) {
      if (viaProxy) return;
      throw new DnsFailure(message);
    }
    throw new RefusedError(`这个地址不能访问（${message.includes('private') ? '内网或本机地址' : message}）`);
  }
}

class DnsFailure extends Error {}

async function fetchWithDeadline(fetchImpl: typeof fetch, url: URL, init: RequestInit, deadline: number, signal?: AbortSignal): Promise<Response> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new TimeoutError();
  const controller = new AbortController();
  // Raced as well as passed down: a transport that ignores the signal must not hang the call.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  const timer = setTimeout(() => controller.abort(new TimeoutError()), remaining);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([fetchImpl(url.toString(), { ...init, signal: controller.signal }), aborted]);
  } catch (error) {
    if (controller.signal.reason instanceof TimeoutError) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

class TimeoutError extends Error {
  constructor() { super('请求超时（12 秒内没有响应）'); }
}

function looksBlocked(error: unknown): boolean {
  if (error instanceof DnsFailure) return true;
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const item = current as { code?: unknown; message?: unknown; cause?: unknown };
    parts.push(String(item.code ?? ''), String(item.message ?? ''));
    current = item.cause;
  }
  return /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|other side closed|UND_ERR_SOCKET/i.test(parts.join(' '));
}

async function describeResponse(response: Response, method: string, url: URL, durationMs: number, fellBack: boolean): Promise<string> {
  const lines = [`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''} · ${method} ${url.host}${url.pathname} · ${durationMs}ms${fellBack ? '（直连不通，已改走代理）' : ''}`];
  response.headers.forEach((value, key) => {
    if (KEPT_HEADERS.test(key)) lines.push(`${key}: ${value}`);
  });
  if (method === 'HEAD') {
    await response.body?.cancel().catch(() => undefined);
    return lines.join('\n');
  }
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (BINARY_TYPE.test(type)) {
    const { size, capped } = await drainSize(response);
    return [...lines, '', `（二进制内容，${type.split(';')[0]}，${capped ? `超过 ${formatBytes(size)}` : formatBytes(size)}，正文不显示）`].join('\n');
  }
  const { bytes, capped } = await readCapped(response, MAX_RESPONSE_BYTES);
  let text = new TextDecoder(charsetOf(type)).decode(bytes);
  if (type.includes('json') || /^\s*[[{]/.test(text)) {
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON after all; keep the raw text */ }
  }
  const clipped = clipBytes(text, MAX_BODY_RETURN_BYTES);
  const notes: string[] = [];
  if (capped) notes.push(`响应超过 ${formatBytes(MAX_RESPONSE_BYTES)}，只读了前面`);
  if (clipped.length < text.length) notes.push(`正文共 ${formatBytes(Buffer.byteLength(text))}，这里只给前 ${formatBytes(MAX_BODY_RETURN_BYTES)}`);
  return [...lines, '', clipped || '（空正文）', ...(notes.length ? ['', `（${notes.join('；')}）`] : [])].join('\n');
}

function charsetOf(type: string): string {
  const declared = /charset=["']?([\w-]+)/i.exec(type)?.[1]?.toLowerCase() ?? 'utf-8';
  const label = /^(gb2312|gbk|gb_2312-80)$/.test(declared) ? 'gbk' : declared;
  try { new TextDecoder(label); return label; } catch { return 'utf-8'; }
}

async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Buffer; capped: boolean }> {
  if (!response.body) return { bytes: Buffer.alloc(0), capped: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: Buffer.concat(chunks), capped: false };
    const room = maxBytes - total;
    if (value.byteLength > room) {
      chunks.push(Buffer.from(value.subarray(0, room)));
      await reader.cancel().catch(() => undefined);
      return { bytes: Buffer.concat(chunks), capped: true };
    }
    chunks.push(Buffer.from(value));
    total += value.byteLength;
  }
}

async function drainSize(response: Response): Promise<{ size: number; capped: boolean }> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > 0) {
    await response.body?.cancel().catch(() => undefined);
    return { size: declared, capped: false };
  }
  const { bytes, capped } = await readCapped(response, MAX_RESPONSE_BYTES);
  return { size: bytes.byteLength, capped };
}

function clipBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  return buffer.subarray(0, maxBytes).toString('utf8').replace(/�+$/u, '');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Masks the key itself and its URL-encoded form wherever it shows up. */
function mask(text: string, secret: string | null): string {
  if (!secret || secret.length < 4) return text;
  let out = text.split(secret).join(MASK);
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) out = out.split(encoded).join(MASK);
  return out;
}

function friendlyError(error: unknown): string {
  if (error instanceof RefusedError || error instanceof TimeoutError) return error.message;
  if (error instanceof DnsFailure) return '域名解析失败，代理也没连上；国外服务可以把 proxy 设为 true 再试';
  const message = error instanceof Error ? error.message : String(error);
  if (/^(密钥库|跳转|url |auth |不支持)/.test(message)) return message;
  if (looksBlocked(error)) return `连不上这个地址（${message}）；国外服务可以把 proxy 设为 true 再试`;
  return `请求失败：${message}`;
}

/**
 * Reads a vault value through the knowledge MCP's secret_read tool, called by
 * the host itself (never by the model), so the value never enters a turn.
 */
export function vaultSecretReader(lookup: () => ToolDescriptor | undefined): HttpRequestDeps['readSecret'] {
  return async (name, signal) => {
    const tool = lookup();
    if (!tool) throw new Error('密钥库现在连不上，稍后再试');
    const raw = await tool.handler({ name }, { phase: 'reply', ...(signal ? { signal } : {}) });
    const envelope = raw as { isError?: boolean; value?: unknown };
    if (envelope?.isError) return null;
    const value = envelope && typeof envelope === 'object' && 'value' in envelope ? envelope.value : raw;
    const record = typeof value === 'string' ? safeJson(value) : value;
    const secret = record && typeof record === 'object' ? (record as { value?: unknown }).value : undefined;
    return typeof secret === 'string' && secret.length > 0 ? secret : null;
  };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}
