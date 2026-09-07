import type { VideoModelConfig } from '../config/schema.js';
import { assertSafeUrl, defaultRetryable, HttpSizeError, HttpTimeoutError, withRetry } from '../util/http.js';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type GeneratedVideo,
  type HealthStatus,
  type VideoProvider,
  type VideoRemoteStatus,
  type VideoTaskRequest,
  type VideoTaskSnapshot
} from './types.js';
import { normalizeAbort, safeText, type ProviderDeps } from './chat/openai.js';

const DEFAULT_MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

/**
 * Turns a director-chosen aspect ratio into a concrete `size` for the request.
 *
 * The configured size supplies the resolution; only the orientation is
 * reinterpreted, so a deployment that paid for 1280x720 never silently gets a
 * larger (more expensive) frame because a clip should be vertical. An
 * unparseable or absent ratio keeps the configured size untouched.
 */
export function resolveVideoSize(configuredSize: string, aspectRatio?: string | null): string {
  const dims = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec((configuredSize ?? '').trim());
  const ratio = /^(\d{1,3})\s*[:：]\s*(\d{1,3})$/.exec((aspectRatio ?? '').trim());
  if (!dims || !ratio) return configuredSize;
  const long = Math.max(Number(dims[1]), Number(dims[2]));
  const short = Math.min(Number(dims[1]), Number(dims[2]));
  const [w, h] = [Number(ratio[1]), Number(ratio[2])];
  if (!w || !h) return configuredSize;
  if (w === h) return `${short}x${short}`;
  return w > h ? `${long}x${short}` : `${short}x${long}`;
}

/**
 * Vendors spell the same lifecycle differently; everything downstream only
 * needs the five states. Unknown words are treated as "still running" rather
 * than as a failure so a new vendor status never kills a task that would have
 * finished a minute later.
 */
export function normalizeVideoStatus(raw: unknown): VideoRemoteStatus {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value || value === 'queued' || value === 'pending' || value === 'submitted' || value === 'waiting') return 'queued';
  if (value === 'succeeded' || value === 'success' || value === 'completed' || value === 'complete' || value === 'done') return 'succeeded';
  if (value === 'failed' || value === 'error' || value === 'failure') return 'failed';
  if (value === 'cancelled' || value === 'canceled' || value === 'expired') return 'cancelled';
  return 'running';
}

function progressOf(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n <= 1 && n > 0 ? n * 100 : n)));
}

function errorMessageOf(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') return raw.slice(0, 300);
  if (typeof raw === 'object') {
    const err = raw as { message?: unknown; code?: unknown };
    const message = typeof err.message === 'string' ? err.message : '';
    const code = typeof err.code === 'string' || typeof err.code === 'number' ? String(err.code) : '';
    const text = [code, message].filter(Boolean).join(': ');
    return text ? text.slice(0, 300) : null;
  }
  return null;
}

function joinEndpoint(baseUrl: string, suffix: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return b.endsWith(suffix) ? b : `${b}${suffix}`;
}

function withTimeout(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new HttpTimeoutError(`video request timed out after ${timeoutMs}ms`)), timeoutMs);
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
 * Starting a job is not idempotent: a retry after a timeout could bill two
 * videos for one request. Only retry when the request provably never landed.
 */
function createRetryable(err: Error): boolean {
  if (err instanceof HttpTimeoutError) return false;
  return defaultRetryable(err);
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared && declared > maxBytes) throw new HttpSizeError(`video too large: ${declared} > ${maxBytes}`);
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new HttpSizeError(`video too large: exceeded ${maxBytes} bytes`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

function videoMimeOf(header: string | null, fallback = 'video/mp4'): string {
  const mime = (header ?? '').split(';')[0]!.trim().toLowerCase();
  if (mime.startsWith('video/')) return mime;
  // Signed object-store URLs frequently answer application/octet-stream; the
  // media store sniffs the real container before anything is persisted.
  return fallback;
}

/** Shared plumbing: auth, timeouts, JSON handling, capped downloads. */
abstract class HttpVideoProvider implements VideoProvider {
  abstract readonly name: string;
  protected readonly fetchImpl: typeof fetch;

  constructor(
    protected readonly cfg: VideoModelConfig,
    protected readonly deps: ProviderDeps
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.cfg.provider !== 'none' && !!this.cfg.baseUrl && !!this.cfg.model && !!this.cfg.apiKey;
  }

  abstract createTask(req: VideoTaskRequest): Promise<VideoTaskSnapshot>;
  abstract pollTask(remoteId: string, signal?: AbortSignal): Promise<VideoTaskSnapshot>;
  abstract download(task: VideoTaskSnapshot, opts?: { signal?: AbortSignal; maxBytes?: number }): Promise<GeneratedVideo>;
  abstract cancelTask(remoteId: string, signal?: AbortSignal): Promise<void>;

  protected endpoint(suffix: string): string {
    return joinEndpoint(this.cfg.baseUrl, suffix);
  }

  protected async request(
    url: string,
    init: RequestInit,
    external?: AbortSignal
  ): Promise<Response> {
    const { signal, cancel } = withTimeout(this.cfg.timeoutMs, external);
    try {
      await assertSafeUrl(url, this.deps.allowPrivateNetwork);
      return await this.fetchImpl(url, { ...init, signal });
    } catch (err) {
      throw normalizeAbort(err, this.cfg.timeoutMs);
    } finally {
      cancel();
    }
  }

  protected async requestJson(url: string, init: RequestInit, external: AbortSignal | undefined, what: string): Promise<Record<string, unknown>> {
    const res = await this.request(url, init, external);
    if (!res.ok) throw new ProviderRequestError(`${what} failed with status ${res.status}: ${await safeText(res)}`, res.status);
    try {
      const json = (await res.json()) as unknown;
      if (!json || typeof json !== 'object') throw new Error('not an object');
      return json as Record<string, unknown>;
    } catch {
      throw new ProviderRequestError(`${what} returned invalid JSON`);
    }
  }

  protected async downloadUrl(url: string, opts: { signal?: AbortSignal; maxBytes?: number; headers?: Record<string, string> } = {}): Promise<GeneratedVideo> {
    const maxBytes = opts.maxBytes ?? this.cfg.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    // The whole file must arrive inside one window; the per-call timeout is
    // sized for JSON, so give the transfer a wider one.
    const timeoutMs = Math.max(this.cfg.timeoutMs, 5 * 60_000);
    const { signal, cancel } = withTimeout(timeoutMs, opts.signal);
    try {
      await assertSafeUrl(url, this.deps.allowPrivateNetwork);
      const res = await this.fetchImpl(url, { method: 'GET', headers: opts.headers ?? {}, signal, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        // Object stores redirect to a CDN edge; one hop, re-checked against SSRF rules.
        const next = new URL(res.headers.get('location')!, url).toString();
        await assertSafeUrl(next, this.deps.allowPrivateNetwork);
        const hop = await this.fetchImpl(next, { method: 'GET', signal, redirect: 'manual' });
        if (!hop.ok) throw new ProviderRequestError(`downloading generated video failed: ${hop.status}`, hop.status);
        const data = await readCapped(hop, maxBytes);
        if (data.byteLength === 0) throw new ProviderRequestError('downloaded video was empty');
        return { data, mime: videoMimeOf(hop.headers.get('content-type')) };
      }
      if (!res.ok) throw new ProviderRequestError(`downloading generated video failed: ${res.status}`, res.status);
      const data = await readCapped(res, maxBytes);
      if (data.byteLength === 0) throw new ProviderRequestError('downloaded video was empty');
      return { data, mime: videoMimeOf(res.headers.get('content-type')) };
    } catch (err) {
      throw normalizeAbort(err, timeoutMs);
    } finally {
      cancel();
    }
  }

  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'video',
      configured: this.configured,
      ok: this.configured,
      provider: this.name,
      model: this.cfg.model || undefined,
      detail: this.configured ? 'configured (endpoint not called)' : 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

/**
 * OpenAI Videos protocol (`POST /videos`, `GET /videos/{id}`,
 * `GET /videos/{id}/content`), also spoken by OpenAI-compatible gateways.
 * Text-only requests go as JSON; a first-frame image switches to multipart
 * because the reference has to travel as a file part (`input_reference`).
 */
export class OpenAIVideoProvider extends HttpVideoProvider {
  readonly name: string;

  constructor(cfg: VideoModelConfig, deps: ProviderDeps) {
    super(cfg, deps);
    this.name = cfg.provider;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.cfg.apiKey}`, ...extra };
  }

  private snapshot(json: Record<string, unknown>, fallbackId?: string): VideoTaskSnapshot {
    const id = typeof json.id === 'string' && json.id ? json.id : fallbackId;
    if (!id) throw new ProviderRequestError('video response did not include a task id');
    return {
      remoteId: id,
      status: normalizeVideoStatus(json.status),
      progress: progressOf(json.progress),
      error: errorMessageOf(json.error)
    };
  }

  async createTask(req: VideoTaskRequest): Promise<VideoTaskSnapshot> {
    if (!this.configured) throw new ProviderNotConfiguredError('video');
    const url = this.endpoint('/videos');
    const seconds = String(req.durationSec ?? this.cfg.durationSec);
    const size = req.size ?? this.cfg.size;
    return withRetry(
      async () => {
        let init: RequestInit;
        if (req.image) {
          const form = new FormData();
          form.set('model', this.cfg.model);
          form.set('prompt', req.prompt);
          form.set('seconds', seconds);
          if (size) form.set('size', size);
          const ext = req.image.mime.split('/')[1] ?? 'png';
          form.set('input_reference', new Blob([new Uint8Array(req.image.data)], { type: req.image.mime }), `reference.${ext === 'jpeg' ? 'jpg' : ext}`);
          init = { method: 'POST', headers: this.authHeaders(), body: form };
        } else {
          const body: Record<string, unknown> = { model: this.cfg.model, prompt: req.prompt, seconds };
          if (size) body.size = size;
          init = { method: 'POST', headers: this.authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) };
        }
        const json = await this.requestJson(url, init, req.signal, 'video generation');
        return this.snapshot(json);
      },
      { retries: this.cfg.maxRetries, isRetryable: createRetryable, signal: req.signal }
    );
  }

  async pollTask(remoteId: string, signal?: AbortSignal): Promise<VideoTaskSnapshot> {
    if (!this.configured) throw new ProviderNotConfiguredError('video');
    const url = `${this.endpoint('/videos')}/${encodeURIComponent(remoteId)}`;
    return withRetry(
      async () => this.snapshot(await this.requestJson(url, { method: 'GET', headers: this.authHeaders() }, signal, 'video status'), remoteId),
      { retries: this.cfg.maxRetries, signal }
    );
  }

  async download(task: VideoTaskSnapshot, opts: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<GeneratedVideo> {
    if (!this.configured) throw new ProviderNotConfiguredError('video');
    if (task.videoUrl) return this.downloadUrl(task.videoUrl, opts);
    const url = `${this.endpoint('/videos')}/${encodeURIComponent(task.remoteId)}/content`;
    return this.downloadUrl(url, { ...opts, headers: this.authHeaders() });
  }

  async cancelTask(remoteId: string, signal?: AbortSignal): Promise<void> {
    if (!this.configured) return;
    const url = `${this.endpoint('/videos')}/${encodeURIComponent(remoteId)}`;
    try {
      await this.request(url, { method: 'DELETE', headers: this.authHeaders() }, signal);
    } catch {
      /* best-effort: the local task is already marked cancelled */
    }
  }
}

export class UnconfiguredVideoProvider implements VideoProvider {
  readonly name = 'none';
  readonly configured = false;
  async createTask(): Promise<VideoTaskSnapshot> {
    throw new ProviderNotConfiguredError('video');
  }
  async pollTask(): Promise<VideoTaskSnapshot> {
    throw new ProviderNotConfiguredError('video');
  }
  async download(): Promise<GeneratedVideo> {
    throw new ProviderNotConfiguredError('video');
  }
  async cancelTask(): Promise<void> {
    /* nothing to cancel */
  }
  async inspectHealth(): Promise<HealthStatus> {
    return { capability: 'video', configured: false, ok: false, provider: 'none', detail: 'not configured', checkedAt: new Date().toISOString() };
  }
}

export function createVideoProvider(cfg: VideoModelConfig, deps: ProviderDeps): VideoProvider {
  if (cfg.provider === 'none') return new UnconfiguredVideoProvider();
  return new OpenAIVideoProvider(cfg, deps);
}
