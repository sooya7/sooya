import dns from 'node:dns/promises';
import net from 'node:net';

export class SsrfError extends Error {
  override name = 'SsrfError';
}
export class HttpTimeoutError extends Error {
  override name = 'HttpTimeoutError';
}
export class HttpSizeError extends Error {
  override name = 'HttpSizeError';
}

const BLOCKED_PROTOCOLS = new Set(['file:', 'ftp:', 'data:', 'gopher:', 'ws:', 'wss:', 'blob:']);

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number) as [number, number, number, number];
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('ff')) return true; // multicast
    // IPv4-mapped
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (m) return isPrivateIp(m[1]!);
    return false;
  }
  return false;
}

export interface SafeFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivateNetwork?: boolean;
  /** When true, resolves DNS and rejects private addresses (default true). */
  ssrfGuard?: boolean;
}

/** Validate an outbound URL against SSRF rules. Throws SsrfError. */
export async function assertSafeUrl(rawUrl: string, allowPrivateNetwork = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`invalid url: ${rawUrl}`);
  }
  if (BLOCKED_PROTOCOLS.has(url.protocol)) throw new SsrfError(`protocol not allowed: ${url.protocol}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError(`protocol not allowed: ${url.protocol}`);
  if (allowPrivateNetwork) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new SsrfError(`private address blocked: ${host}`);
    return url;
  }
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) {
    throw new SsrfError(`private hostname blocked: ${host}`);
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch (err) {
    throw new SsrfError(`dns resolution failed for ${host}: ${(err as Error).message}`);
  }
  if (addresses.length === 0) throw new SsrfError(`dns returned no records for ${host}`);
  for (const a of addresses) {
    if (isPrivateIp(a.address)) throw new SsrfError(`private address blocked: ${host} -> ${a.address}`);
  }
  return url;
}

/** fetch with timeout, size cap and SSRF guard. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<{ response: Response; body: Buffer }> {
  const { timeoutMs = 20_000, maxBytes = 15 * 1024 * 1024, allowPrivateNetwork = false, ssrfGuard = true, ...init } = opts;
  if (ssrfGuard) await assertSafeUrl(rawUrl, allowPrivateNetwork);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new HttpTimeoutError(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  let response: Response;
  try {
    response = await fetch(rawUrl, { ...init, signal: controller.signal, redirect: 'manual' });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError' || err instanceof HttpTimeoutError) {
      throw new HttpTimeoutError(`request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  try {
    // Manual redirect handling so every hop is SSRF-checked.
    let hops = 0;
    while (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (++hops > 3) throw new SsrfError('too many redirects');
      const next = new URL(response.headers.get('location')!, rawUrl).toString();
      if (ssrfGuard) await assertSafeUrl(next, allowPrivateNetwork);
      response = await fetch(next, { ...init, signal: controller.signal, redirect: 'manual' });
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared && declared > maxBytes) throw new HttpSizeError(`response too large: ${declared} > ${maxBytes}`);
    const body = await readCapped(response, maxBytes);
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpSizeError(`response exceeded ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
  isRetryable?: (error: Error) => boolean;
  signal?: AbortSignal;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const { retries, baseDelayMs = 400, onRetry, isRetryable = defaultRetryable } = opts;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err as Error;
      if (attempt === retries || !isRetryable(lastError)) throw lastError;
      onRetry?.(attempt + 1, lastError);
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
      await new Promise((r) => setTimeout(r, delay));
      if (opts.signal?.aborted) throw lastError;
    }
  }
  throw lastError ?? new Error('retry failed');
}

export function defaultRetryable(err: Error): boolean {
  if (err instanceof SsrfError) return false;
  if (err instanceof HttpSizeError) return false;
  if (err instanceof HttpTimeoutError) return true;
  const msg = err.message.toLowerCase();
  if (/status (?:5\d\d|429)/.test(msg)) return true;
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up') || msg.includes('fetch failed'))
    return true;
  return false;
}
