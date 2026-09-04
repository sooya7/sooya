import type { ImageModelConfig } from '../config/schema.js';
import { assertSafeUrl, safeFetch, withRetry, HttpTimeoutError, defaultRetryable } from '../util/http.js';
import {
  ImageEditUnsupportedError,
  ImageReferenceError,
  ProviderNotConfiguredError,
  ProviderRequestError,
  type GeneratedImage,
  type HealthStatus,
  type ImageProvider
} from './types.js';
import { normalizeAbort, safeText, type ProviderDeps } from './chat/openai.js';
import { inspectGeneratedImage } from './image-provenance.js';

type ImageApiResponse = { data?: Array<{ b64_json?: string; url?: string; mime_type?: string }> };

async function materializeImage(
  json: ImageApiResponse,
  cfg: ImageModelConfig,
  deps: ProviderDeps,
  requestedSize?: string | null
): Promise<GeneratedImage> {
  const first = json.data?.[0];
  if (!first) throw new ProviderRequestError('image response contained no data');
  if (first.b64_json) {
    const buf = Buffer.from(first.b64_json, 'base64');
    if (buf.byteLength === 0) throw new ProviderRequestError('image response was empty');
    return reportProvenance({ data: buf, mime: first.mime_type ?? 'image/png' }, cfg, deps, requestedSize);
  }
  if (first.url) {
    const { response, body } = await safeFetch(first.url, {
      timeoutMs: cfg.timeoutMs,
      allowPrivateNetwork: deps.allowPrivateNetwork
    });
    if (!response.ok) throw new ProviderRequestError(`downloading generated image failed: ${response.status}`);
    if (body.byteLength === 0) throw new ProviderRequestError('downloaded image was empty');
    return reportProvenance({ data: body, mime: response.headers.get('content-type') ?? 'image/png' }, cfg, deps, requestedSize);
  }
  throw new ProviderRequestError('image response contained neither b64_json nor url');
}

/**
 * The single choke point every generated image passes through, for both the
 * OpenAI-style and Anuma providers. Checks what actually came back against
 * what was asked for and reports a mismatch without failing the request: the
 * caller has a usable image, and a degraded one is better than no reply. What
 * must not happen is the substitution going unnoticed, which is exactly what
 * happened for three weeks in production (see image-provenance.ts).
 *
 * Dimensions are also returned on the GeneratedImage so callers can persist
 * them without re-probing.
 */
function reportProvenance(
  image: GeneratedImage,
  cfg: ImageModelConfig,
  deps: ProviderDeps,
  requestedSize?: string | null
): GeneratedImage {
  const report = inspectGeneratedImage({
    data: image.data,
    requestedModel: cfg.model,
    requestedSize: requestedSize ?? cfg.size
  });
  if (report.summary) {
    deps.onProviderNotice?.({
      scope: 'image.provenance',
      message: report.summary,
      detail: {
        requestedModel: report.requestedModel,
        requestedSize: report.requestedSize,
        actualSize: report.actualSize,
        softwareAgent: report.softwareAgent,
        provenance: report.provenance
      }
    });
  }
  return {
    ...image,
    ...(report.actualSize
      ? { width: Number(report.actualSize.split('x')[0]), height: Number(report.actualSize.split('x')[1]) }
      : {})
  };
}

export class OpenAIImageProvider implements ImageProvider {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly cfg: ImageModelConfig,
    private readonly deps: ProviderDeps
  ) {
    this.name = cfg.provider;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.cfg.provider !== 'none' && !!this.cfg.baseUrl && !!this.cfg.model && !!this.cfg.apiKey;
  }

  private endpoint(suffix: string): string {
    const b = this.cfg.baseUrl.replace(/\/+$/, '');
    return b.endsWith(suffix) ? b : `${b}${suffix}`;
  }

  async generate(
    prompt: string,
    opts: { size?: string; signal?: AbortSignal; referenceImages?: Array<{ data: Buffer; mime: string }> } = {}
  ): Promise<GeneratedImage> {
    if (!this.configured) throw new ProviderNotConfiguredError('image');
    const refs = opts.referenceImages ?? [];
    if (refs.length > 1) {
      throw new ImageReferenceError('too_many_reference_images', '一次图生图只能使用一张参考图', `received ${refs.length} reference images`);
    }
    if (refs.length === 1) {
      const ref = refs[0]!;
      return this.edit(prompt, ref.data, { mime: ref.mime, signal: opts.signal });
    }
    return withRetry(
      async () => {
        const url = this.endpoint('/images/generations');
        const { signal, cancel } = this.timeout(opts.signal);
        try {
          await assertSafeUrl(url, this.deps.allowPrivateNetwork);
          const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
            body: JSON.stringify({
              model: this.cfg.model,
              prompt,
              size: opts.size ?? this.cfg.size,
              n: 1,
              ...(this.cfg.responseFormat ? { response_format: this.cfg.responseFormat } : {})
            }),
            signal
          });
          if (!res.ok)
            throw new ProviderRequestError(`image generation failed with status ${res.status}: ${await safeText(res)}`, res.status);
          const json = (await res.json()) as ImageApiResponse;
          return await materializeImage(json, this.cfg, this.deps, opts.size ?? this.cfg.size);
        } catch (err) {
          throw normalizeAbort(err, this.cfg.timeoutMs);
        } finally {
          cancel();
        }
      },
      { retries: this.cfg.maxRetries }
    );
  }

  async edit(prompt: string, image: Buffer, opts: { mime?: string; signal?: AbortSignal } = {}): Promise<GeneratedImage> {
    if (!this.configured) throw new ProviderNotConfiguredError('image');
    const url = this.endpoint('/images/edits');
    const { signal, cancel } = this.timeout(opts.signal);
    try {
      await assertSafeUrl(url, this.deps.allowPrivateNetwork);
      const form = new FormData();
      form.set('model', this.cfg.model);
      form.set('prompt', prompt);
      form.set('n', '1');
      if (this.cfg.responseFormat) form.set('response_format', this.cfg.responseFormat);
      const mime = opts.mime ?? 'image/png';
      form.set('image', new Blob([new Uint8Array(image)], { type: mime }), `image.${mime.split('/')[1] ?? 'png'}`);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.apiKey}` },
        body: form,
        signal
      });
      if (!res.ok) {
        const body = await safeText(res);
        const message = `image edit failed with status ${res.status}: ${body}`;
        if (isExplicitEditUnsupported(res.status, body)) {
          throw new ImageEditUnsupportedError(message);
        }
        throw new ProviderRequestError(message, res.status);
      }
      const json = (await res.json()) as ImageApiResponse;
      // No requested size: this form deliberately does not send one (the
      // endpoint supports it, but changing that here is untested), so there is
      // nothing to compare against and a size check would only false-positive.
      // The model provenance check still applies.
      return await materializeImage(json, this.cfg, this.deps, null);
    } catch (err) {
      throw normalizeAbort(err, this.cfg.timeoutMs);
    } finally {
      cancel();
    }
  }

  private timeout(external?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new HttpTimeoutError(`image request timed out after ${this.cfg.timeoutMs}ms`)),
      this.cfg.timeoutMs
    );
    const onAbort = () => controller.abort(external?.reason);
    external?.addEventListener('abort', onAbort, { once: true });
    return {
      signal: controller.signal,
      cancel: () => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
      }
    };
  }

  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'image',
      configured: this.configured,
      ok: this.configured,
      provider: this.cfg.provider,
      model: this.cfg.model || undefined,
      detail: this.configured ? 'configured (endpoint not called)' : 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

const ANUMA_REFERENCE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ANUMA_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;

export class AnumaImageProvider implements ImageProvider {
  readonly name = 'anuma-input-images';
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly cfg: ImageModelConfig,
    private readonly deps: ProviderDeps
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.cfg.provider === 'anuma-input-images' && !!this.cfg.baseUrl && !!this.cfg.model && !!this.cfg.apiKey;
  }

  private endpoint(suffix: string): string {
    const b = this.cfg.baseUrl.replace(/\/+$/, '');
    return b.endsWith(suffix) ? b : `${b}${suffix}`;
  }

  /*
   * `size` used to be absent from this signature entirely. The ImageProvider
   * interface declares it, but a narrower parameter list is still assignable,
   * so nothing flagged that the configured `size` was silently discarded on
   * this provider — models.json could say 1024x1024 while the request never
   * mentioned a size at all. Accepting and forwarding it makes the intent
   * explicit and gives the provenance check something to compare against.
   */
  async generate(prompt: string, opts: { size?: string; signal?: AbortSignal; referenceImages?: Array<{ data: Buffer; mime: string }> } = {}): Promise<GeneratedImage> {
    if (!this.configured) throw new ProviderNotConfiguredError('image');
    const refs = opts.referenceImages ?? [];
    const size = opts.size ?? this.cfg.size;
    if (refs.length === 0) {
      const json = await this.postGeneration(prompt, undefined, opts.signal);
      return materializeImage(json, this.cfg, this.deps, size);
    }
    // 只取第一张：anuma 参考图验证路径为单图（config/image-persona.json verification 记录）
    const ref = refs[0]!;
    return this.edit(prompt, ref.data, { mime: ref.mime, signal: opts.signal, size });
  }

  async edit(prompt: string, image: Buffer, opts: { mime?: string; signal?: AbortSignal; size?: string } = {}): Promise<GeneratedImage> {
    if (!this.configured) throw new ProviderNotConfiguredError('image');
    const mime = (opts.mime ?? 'image/png').split(';')[0]!.trim().toLowerCase();
    if (!ANUMA_REFERENCE_MIMES.has(mime)) {
      throw new ImageReferenceError('reference_image_type_unsupported', '参考图格式不受支持', `unsupported reference image type: ${mime}`);
    }
    if (image.byteLength === 0 || image.byteLength > ANUMA_REFERENCE_MAX_BYTES) {
      throw new ImageReferenceError('reference_image_too_large', '参考图为空或超过 10MB', `reference image size is ${image.byteLength} bytes`);
    }
    const url = await this.upload(image, mime, opts.signal);
    const size = opts.size ?? this.cfg.size;
    let json: ImageApiResponse;
    try {
      json = await this.postGeneration(prompt, [url], opts.signal);
    } catch (err) {
      if (err instanceof ImageReferenceError) throw err;
      const e = err as Error;
      throw new ImageReferenceError('reference_generation_failed', '参考图生成失败，请稍后重试', e.message);
    }
    try {
      return await materializeImage(json, this.cfg, this.deps, size);
    } catch (err) {
      const e = err as Error;
      throw new ImageReferenceError('reference_generation_failed', '参考图生成结果无效，请稍后重试', e.message);
    }
  }

  private async upload(image: Buffer, mime: string, external?: AbortSignal): Promise<string> {
    const filename = `reference.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`;
    return withRetry(
      async () => {
        const { signal, cancel } = this.timeout(this.cfg.uploadTimeoutMs, external);
        try {
          const url = this.endpoint('/media/upload');
          await assertSafeUrl(url, this.deps.allowPrivateNetwork);
          const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
            body: JSON.stringify({ filename, content_type: mime, data: image.toString('base64') }),
            signal
          });
          if (!res.ok) {
            throw new ImageReferenceError('reference_upload_failed', '参考图上传失败，请稍后重试', `reference upload failed with status ${res.status}`);
          }
          let json: unknown;
          try {
            json = await res.json();
          } catch {
            throw new ImageReferenceError('reference_upload_invalid_response', '参考图上传返回无效，请稍后重试', 'reference upload returned invalid JSON');
          }
          const returned = (json as { url?: unknown }).url;
          if (typeof returned !== 'string' || !returned || !returned.startsWith('https://')) {
            throw new ImageReferenceError('reference_upload_invalid_response', '参考图上传返回无效，请稍后重试', 'reference upload did not return an HTTPS URL');
          }
          try {
            new URL(returned);
          } catch {
            throw new ImageReferenceError('reference_upload_invalid_response', '参考图上传返回无效，请稍后重试', 'reference upload returned an invalid HTTPS URL');
          }
          return returned;
        } catch (err) {
          throw normalizeAbort(err, this.cfg.uploadTimeoutMs);
        } finally {
          cancel();
        }
      },
      { retries: this.cfg.uploadMaxRetries, isRetryable: isAnumaUploadRetryable, signal: external }
    );
  }

  private async postGeneration(prompt: string, inputImages?: string[], external?: AbortSignal): Promise<ImageApiResponse> {
    const { signal, cancel } = this.timeout(this.cfg.timeoutMs, external);
    try {
      const url = this.endpoint('/images/generations');
      await assertSafeUrl(url, this.deps.allowPrivateNetwork);
      /*
       * Only fields confirmed against the real endpoint go in the body — see
       * the "confirmed request fields" test. `size` is deliberately NOT sent:
       * the gateway in front of this endpoint reduces size to an aspect ratio
       * (its MCP image tool exposes no resolution parameter at all), so it buys
       * nothing, and posting an unverified field to a reverse-engineered
       * endpoint risks a 400 on the whole reply. The requested size is threaded
       * through in-process instead, purely so the provenance check knows what
       * was intended.
       */
      const body: Record<string, unknown> = { model: this.cfg.model, prompt, n: 1 };
      if (inputImages) body.input_images = inputImages;
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify(body),
        signal
      });
      if (!res.ok) {
        if (inputImages) {
          throw new ImageReferenceError('reference_generation_failed', '参考图生成失败，请稍后重试', `reference generation failed with status ${res.status}`);
        }
        throw new ProviderRequestError(`image generation failed with status ${res.status}`, res.status);
      }
      try {
        return (await res.json()) as ImageApiResponse;
      } catch {
        if (inputImages) {
          throw new ImageReferenceError('reference_generation_failed', '参考图生成结果无效，请稍后重试', 'reference generation returned invalid JSON');
        }
        throw new ProviderRequestError('image generation returned invalid JSON');
      }
    } catch (err) {
      throw normalizeAbort(err, this.cfg.timeoutMs);
    } finally {
      cancel();
    }
  }

  private timeout(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new HttpTimeoutError(`image request timed out after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => controller.abort(external?.reason);
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener('abort', onAbort, { once: true });
    }
    return { signal: controller.signal, cancel: () => { clearTimeout(timer); external?.removeEventListener('abort', onAbort); } };
  }

  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'image', configured: this.configured, ok: this.configured,
      provider: this.name, model: this.cfg.model || undefined,
      detail: this.configured ? 'configured (endpoint not called)' : 'not configured', checkedAt: new Date().toISOString()
    };
  }
}

function isAnumaUploadRetryable(err: Error): boolean {
  if (err instanceof HttpTimeoutError) return true;
  if (err instanceof ImageReferenceError) return /status (408|429|502|503|504)(?:\b|:)/.test(err.message);
  return defaultRetryable(err) && /econnreset|etimedout|socket hang up|fetch failed/i.test(err.message);
}

function isExplicitEditUnsupported(status: number, body: string): boolean {
  if (status === 405 || status === 501) return true;
  const normalized = body.toLowerCase();
  const namesEditCapability = /(?:image\s+edits?|images\/edits|edit(?:ing)?\s+(?:endpoint|capability|operation))/.test(normalized);
  const saysUnavailable = /(?:not\s+supported|unsupported|not\s+implemented|unknown\s+endpoint|route\s+not\s+found)/.test(normalized);
  return (status === 400 || status === 404) && namesEditCapability && saysUnavailable;
}

export class UnconfiguredImageProvider implements ImageProvider {
  readonly name = 'none';
  readonly configured = false;
  async generate(): Promise<GeneratedImage> {
    throw new ProviderNotConfiguredError('image');
  }
  async edit(): Promise<GeneratedImage> {
    throw new ProviderNotConfiguredError('image');
  }
  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'image',
      configured: false,
      ok: false,
      provider: 'none',
      detail: 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

export function createImageProvider(cfg: ImageModelConfig, deps: ProviderDeps): ImageProvider {
  if (cfg.provider === 'none') return new UnconfiguredImageProvider();
  if (cfg.provider === 'anuma-input-images') return new AnumaImageProvider(cfg, deps);
  return new OpenAIImageProvider(cfg, deps);
}

