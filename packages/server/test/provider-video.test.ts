import { describe, expect, it } from 'vitest';
import { VideoModelSchema } from '../src/config/schema.js';
import { createVideoProvider, normalizeVideoStatus, OpenAIVideoProvider, UnconfiguredVideoProvider } from '../src/providers/video.js';
import { HttpSizeError, HttpTimeoutError } from '../src/util/http.js';
import { ProviderNotConfiguredError, ProviderRequestError } from '../src/providers/types.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const MP4 = Buffer.from('fake-mp4-bytes');

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null; form: Record<string, string> | null };

function recorder(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    let form: Record<string, string> | null = null;
    if (init?.body instanceof FormData) {
      form = {};
      for (const [key, value] of init.body.entries()) form[key] = typeof value === 'string' ? value : `file:${(value as File).name}:${(value as File).type}:${(value as File).size}`;
    }
    const call: Call = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null,
      form
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { calls, fetchImpl };
}

const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

function openai(overrides: Record<string, unknown> = {}) {
  return VideoModelSchema.parse({
    provider: 'openai-videos', baseUrl: 'https://gateway.example/v1', apiKey: 'sk-video', model: 'sora-2',
    size: '1280x720', durationSec: 8, timeoutMs: 5000, maxRetries: 0, ...overrides
  });
}

const deps = (fetchImpl: typeof fetch) => ({ allowPrivateNetwork: true, fetchImpl });

describe('video status normalisation', () => {
  it('maps every vendor spelling onto the five internal states', () => {
    expect(normalizeVideoStatus('queued')).toBe('queued');
    expect(normalizeVideoStatus('in_progress')).toBe('running');
    expect(normalizeVideoStatus('running')).toBe('running');
    expect(normalizeVideoStatus('completed')).toBe('succeeded');
    expect(normalizeVideoStatus('succeeded')).toBe('succeeded');
    expect(normalizeVideoStatus('failed')).toBe('failed');
    expect(normalizeVideoStatus('canceled')).toBe('cancelled');
    expect(normalizeVideoStatus('cancelled')).toBe('cancelled');
    // Unknown words keep the task alive rather than killing it.
    expect(normalizeVideoStatus('rendering')).toBe('running');
    expect(normalizeVideoStatus(undefined)).toBe('queued');
  });
});

describe('OpenAI Videos provider', () => {
  it('starts a text-to-video job with JSON and the saved defaults', async () => {
    const { calls, fetchImpl } = recorder(() => json(200, { id: 'video_1', status: 'queued', progress: 0 }));
    const provider = new OpenAIVideoProvider(openai(), deps(fetchImpl));
    const snapshot = await provider.createTask({ prompt: '海边日落，慢镜头' });
    expect(snapshot).toEqual({ remoteId: 'video_1', status: 'queued', progress: 0, error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gateway.example/v1/videos');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-video');
    expect(calls[0]!.body).toEqual({ model: 'sora-2', prompt: '海边日落，慢镜头', seconds: '8', size: '1280x720' });
  });

  it('accepts a base url that already ends in /videos and honours per-request overrides', async () => {
    const { calls, fetchImpl } = recorder(() => json(200, { id: 'video_2', status: 'queued' }));
    const provider = new OpenAIVideoProvider(openai({ baseUrl: 'https://gateway.example/v1/videos' }), deps(fetchImpl));
    await provider.createTask({ prompt: 'p', durationSec: 4, size: '720x1280' });
    expect(calls[0]!.url).toBe('https://gateway.example/v1/videos');
    expect(calls[0]!.body).toMatchObject({ seconds: '4', size: '720x1280' });
  });

  it('switches to multipart with input_reference for image-to-video', async () => {
    const { calls, fetchImpl } = recorder(() => json(200, { id: 'video_3', status: 'queued' }));
    const provider = new OpenAIVideoProvider(openai(), deps(fetchImpl));
    await provider.createTask({ prompt: '让画面动起来', image: { data: PNG, mime: 'image/png' } });
    expect(calls[0]!.body).toBeNull();
    expect(calls[0]!.form).toEqual({
      model: 'sora-2', prompt: '让画面动起来', seconds: '8', size: '1280x720', input_reference: 'file:reference.png:image/png:4'
    });
    expect(calls[0]!.headers['content-type']).toBeUndefined();
  });

  // Agnes AI rejects the protocol above twice over: `mode` is mandatory, and a
  // first frame has to arrive as base64 inside JSON. Both were 400s in
  // production, so each shape is pinned here.
  describe('agnes dialect', () => {
    it('sends mode=text as JSON for a text-to-video job', async () => {
      const { calls, fetchImpl } = recorder(() => json(200, { id: 'task_1', status: 'queued' }));
      const provider = new OpenAIVideoProvider(
        openai({ dialect: 'agnes', size: '720P', durationSec: 5 }), deps(fetchImpl)
      );
      await provider.createTask({ prompt: '图书馆靠窗' });
      expect(calls[0]!.headers['content-type']).toBe('application/json');
      expect(calls[0]!.body).toEqual({ model: 'sora-2', prompt: '图书馆靠窗', seconds: '5', size: '720P', mode: 'text' });
    });

    it('sends mode=keyframe with a base64 data URI instead of multipart', async () => {
      const { calls, fetchImpl } = recorder(() => json(200, { id: 'task_2', status: 'queued' }));
      const provider = new OpenAIVideoProvider(
        openai({ dialect: 'agnes', size: '720P' }), deps(fetchImpl)
      );
      await provider.createTask({ prompt: '让画面动起来', image: { data: PNG, mime: 'image/png' }, aspectRatio: '9:16' });
      expect(calls[0]!.form).toBeNull();
      expect(calls[0]!.body).toEqual({
        model: 'sora-2',
        prompt: '让画面动起来',
        seconds: '8',
        size: '720P',
        mode: 'keyframe',
        aspect_ratio: '9:16',
        first_frame: `data:image/png;base64,${PNG.toString('base64')}`
      });
    });

    it('omits aspect_ratio when the director did not choose one', async () => {
      const { calls, fetchImpl } = recorder(() => json(200, { id: 'task_3', status: 'queued' }));
      const provider = new OpenAIVideoProvider(openai({ dialect: 'agnes', size: '720P' }), deps(fetchImpl));
      await provider.createTask({ prompt: 'p' });
      expect(calls[0]!.body).not.toHaveProperty('aspect_ratio');
    });
  });

  it('polls the job and maps progress and status', async () => {
    const { calls, fetchImpl } = recorder(() => json(200, { id: 'video_1', status: 'in_progress', progress: 42 }));
    const provider = new OpenAIVideoProvider(openai(), deps(fetchImpl));
    const snapshot = await provider.pollTask('video_1');
    expect(calls[0]!.url).toBe('https://gateway.example/v1/videos/video_1');
    expect(calls[0]!.method).toBe('GET');
    expect(snapshot).toMatchObject({ remoteId: 'video_1', status: 'running', progress: 42 });
  });

  it('surfaces the vendor error message on a failed job', async () => {
    const { fetchImpl } = recorder(() => json(200, { id: 'video_1', status: 'failed', error: { code: 'moderation_blocked', message: 'prompt rejected' } }));
    const provider = new OpenAIVideoProvider(openai(), deps(fetchImpl));
    const snapshot = await provider.pollTask('video_1');
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toBe('moderation_blocked: prompt rejected');
  });

  it('downloads the finished file from /videos/{id}/content with the bearer token', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(new Uint8Array(MP4), { status: 200, headers: { 'content-type': 'video/mp4' } }));
    const provider = new OpenAIVideoProvider(openai(), deps(fetchImpl));
    const video = await provider.download({ remoteId: 'video_1', status: 'succeeded' });
    expect(calls[0]!.url).toBe('https://gateway.example/v1/videos/video_1/content');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-video');
    expect(video.mime).toBe('video/mp4');
    expect(video.data).toEqual(MP4);
  });

  it('follows a download URL handed out by a gateway without forwarding the API key', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(new Uint8Array(MP4), { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
    const provider = new OpenAIVideoProvider(openai(), deps(fetchImpl));
    const video = await provider.download({ remoteId: 'video_1', status: 'succeeded', videoUrl: 'https://cdn.example/out.mp4?sig=secret' });
    expect(calls[0]!.url).toBe('https://cdn.example/out.mp4?sig=secret');
    expect(calls[0]!.headers.authorization).toBeUndefined();
    // Object stores answer octet-stream; the media store sniffs the container later.
    expect(video.mime).toBe('video/mp4');
  });

  it('refuses a download that exceeds the configured size', async () => {
    const { fetchImpl } = recorder(() => new Response(new Uint8Array(Buffer.alloc(64)), { status: 200, headers: { 'content-type': 'video/mp4' } }));
    const provider = new OpenAIVideoProvider(openai(), deps(fetchImpl));
    await expect(provider.download({ remoteId: 'video_1', status: 'succeeded' }, { maxBytes: 16 })).rejects.toBeInstanceOf(HttpSizeError);
  });

  it('reports HTTP failures with their status so callers can tell auth from outages', async () => {
    const { fetchImpl } = recorder(() => json(401, { error: { message: 'bad key' } }));
    const provider = new OpenAIVideoProvider(openai(), deps(fetchImpl));
    const err = await provider.createTask({ prompt: 'p' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect((err as ProviderRequestError).status).toBe(401);
  });

  it('retries a 5xx on creation but never a timeout, which could bill twice', async () => {
    const flaky = recorder((_call, index) => index === 0 ? new Response('boom', { status: 503 }) : json(200, { id: 'video_9', status: 'queued' }));
    const retried = new OpenAIVideoProvider(openai({ maxRetries: 1 }), deps(flaky.fetchImpl));
    await expect(retried.createTask({ prompt: 'p' })).resolves.toMatchObject({ remoteId: 'video_9' });
    expect(flaky.calls).toHaveLength(2);

    const slow = recorder(() => { throw new HttpTimeoutError('video request timed out after 5000ms'); });
    const timedOut = new OpenAIVideoProvider(openai({ maxRetries: 2 }), deps(slow.fetchImpl));
    await expect(timedOut.createTask({ prompt: 'p' })).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(slow.calls).toHaveLength(1);
  });

  it('cancels with DELETE and swallows vendor errors', async () => {
    const { calls, fetchImpl } = recorder(() => new Response('gone', { status: 404 }));
    const provider = new OpenAIVideoProvider(openai(), deps(fetchImpl));
    await expect(provider.cancelTask('video_1')).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ url: 'https://gateway.example/v1/videos/video_1', method: 'DELETE' });
  });

  it('is not configured until protocol, address, model and key are all present', async () => {
    expect(new OpenAIVideoProvider(openai({ apiKey: '' }), deps(fetch)).configured).toBe(false);
    await expect(new OpenAIVideoProvider(openai({ model: '' }), deps(fetch)).createTask({ prompt: 'p' })).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(createVideoProvider(VideoModelSchema.parse({}), deps(fetch))).toBeInstanceOf(UnconfiguredVideoProvider);
    expect(createVideoProvider(openai(), deps(fetch))).toBeInstanceOf(OpenAIVideoProvider);
    expect(createVideoProvider(openai({ provider: 'openai-compatible' }), deps(fetch))).toBeInstanceOf(OpenAIVideoProvider);
  });
});
