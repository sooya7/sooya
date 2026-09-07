import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MP4, TEST_PNG, type Harness, type HarnessOptions } from './helpers/harness.js';
import { VideoGenerationService, type PublicVideoTask } from '../src/core/video/service.js';
import { ProviderRequestError, type VideoProvider, type VideoTaskSnapshot } from '../src/providers/types.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
  vi.unstubAllGlobals();
});

const ADMIN = { 'x-admin-token': 'test-admin-token' };
const boot = (opts: HarnessOptions = {}) => createHarness({ video: 'ok', ...opts });

async function post(body: unknown) {
  const res = await h!.app.server.inject({ method: 'POST', url: '/api/admin/video/generations', headers: ADMIN, payload: body });
  return { res, body: res.json() as { task?: PublicVideoTask; error?: string; message?: string } };
}

async function getTask(id: string) {
  const res = await h!.app.server.inject({ method: 'GET', url: `/api/admin/video/generations/${id}`, headers: ADMIN });
  return { res, task: (res.json() as { task: PublicVideoTask }).task };
}

function multipart(fields: Record<string, string>, file?: { name: string; data: Buffer; type: string; field?: string }) {
  const boundary = 'sooya-video-test';
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${file.field ?? 'image'}"; filename="${file.name}"\r\ncontent-type: ${file.type}\r\n\r\n`));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { ...ADMIN, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('文生视频 / 图生视频 admin API', () => {
  it('runs a text-to-video task end to end: 202, remote job, polls, downloaded file served as video', async () => {
    h = await boot();
    const { res, body } = await post({ prompt: '海边日落，慢镜头推进', durationSec: 4 });
    expect(res.statusCode).toBe(202);
    const task = body.task!;
    expect(task.status).toBe('queued');
    expect(task.mode).toBe('text');
    expect(task.provider).toBe('openai-videos');
    expect(task.model).toBe('fake-video');
    expect(task.params).toEqual({ durationSec: 4 });

    // The first step is a durable job with no delay: the worker starts the vendor job.
    expect(h.app.repos.jobs.list(10).some((job) => job.type === 'video.generate' && job.status === 'pending')).toBe(true);
    await h.app.services.worker.drain();
    let current = (await getTask(task.id)).task;
    expect(current.status).toBe('running');
    expect(current.remoteId).toBe('video_fake_1');
    expect(h.state.videoRequests[0]).toMatchObject({ method: 'POST', body: { model: 'fake-video', prompt: '海边日落，慢镜头推进', seconds: '4', size: '1280x720' } });

    // Subsequent steps poll; the fake reports progress once, then completion.
    await h.app.services.video.step(task.id);
    current = (await getTask(task.id)).task;
    expect(current.status).toBe('running');
    expect(current.progress).toBe(50);

    await h.app.services.video.step(task.id);
    current = (await getTask(task.id)).task;
    expect(current.status).toBe('succeeded');
    expect(current.progress).toBe(100);
    expect(current.completedAt).toBeTruthy();
    expect(current.media).toMatchObject({ kind: 'file', mime: 'video/mp4', bytes: TEST_MP4.byteLength });
    expect(current.media!.url).toBe(`/api/media/${current.media!.id}`);

    const media = await h.app.server.inject({ method: 'GET', url: current.media!.url });
    expect(media.statusCode).toBe(200);
    expect(media.headers['content-type']).toBe('video/mp4');
    // Videos play inline; only documents are forced to download.
    expect(media.headers['content-disposition']).toBeUndefined();
    expect(media.rawPayload).toEqual(TEST_MP4);

    const row = h.app.repos.media.get(current.media!.id)!;
    expect(row.origin).toBe('generated');
    expect(JSON.parse(row.meta_json)).toMatchObject({ video: true, videoTaskId: task.id, mode: 'text' });

    // A finished task is inert: another step does nothing and calls nothing.
    const calls = h.state.videoRequests.length;
    await h.app.services.video.step(task.id);
    expect(h.state.videoRequests).toHaveLength(calls);
  });

  it('accepts a multipart upload as the first frame for image-to-video', async () => {
    h = await boot();
    const form = multipart({ prompt: '让照片里的人物慢慢转头', durationSec: '4' }, { name: 'frame.png', data: TEST_PNG, type: 'image/png' });
    const res = await h.app.server.inject({ method: 'POST', url: '/api/admin/video/generations', ...form });
    expect(res.statusCode).toBe(202);
    const task = (res.json() as { task: PublicVideoTask }).task;
    expect(task.mode).toBe('image');
    expect(task.sourceMedia).toMatchObject({ kind: 'image', mime: 'image/png' });

    await h.app.services.video.step(task.id);
    const create = h.state.videoRequests[0]!;
    expect(create.body).toBeNull();
    expect(create.form).toMatchObject({ model: 'fake-video', prompt: '让照片里的人物慢慢转头', seconds: '4', input_reference: 'file:reference.png:image/png' });
    expect((await getTask(task.id)).task.status).toBe('running');
  });

  it('accepts an existing media id as the first frame', async () => {
    h = await boot();
    const upload = multipart({}, { name: 'still.png', data: TEST_PNG, type: 'image/png', field: 'image' });
    const uploaded = await h.app.server.inject({ method: 'POST', url: '/api/admin/media', ...upload });
    expect(uploaded.statusCode).toBe(200);
    const mediaId = (uploaded.json() as { media: Array<{ id: string }> }).media[0]!.id;

    const { res, body } = await post({ prompt: '云在天上流动', imageMediaId: mediaId });
    expect(res.statusCode).toBe(202);
    expect(body.task!.mode).toBe('image');
    expect(body.task!.sourceMedia!.id).toBe(mediaId);
  });

  it('fetches a first frame from a URL through the SSRF-guarded fetcher', async () => {
    h = await boot();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(TEST_PNG), { status: 200, headers: { 'content-type': 'image/png' } })));
    const { res, body } = await post({ prompt: '风吹过麦田', imageUrl: 'https://images.example/wheat.png' });
    expect(res.statusCode).toBe(202);
    expect(body.task!.mode).toBe('image');
    expect(h.app.repos.media.get(body.task!.sourceMedia!.id)!.origin).toBe('remote');

    const blocked = await post({ prompt: 'p', imageUrl: 'file:///etc/passwd' });
    expect(blocked.res.statusCode).toBe(400);
  });

  it('rejects bad requests before anything is billed', async () => {
    h = await boot();
    expect((await post({})).res.statusCode).toBe(400);
    expect((await post({ prompt: '' })).res.statusCode).toBe(400);
    expect((await post({ prompt: 'p', durationSec: 999 })).res.statusCode).toBe(400);
    const missing = await post({ prompt: 'p', imageMediaId: 'media_does_not_exist' });
    expect(missing.res.statusCode).toBe(404);
    expect(missing.body.error).toBe('source_not_found');
    const both = await post({ prompt: 'p', imageMediaId: 'media_x', imageUrl: 'https://images.example/a.png' });
    expect(both.res.statusCode).toBe(400);
    expect(h.state.videoRequests).toHaveLength(0);
  });

  it('answers 503 while no video model is configured, and 429 past the active-task cap', async () => {
    h = await boot({ video: 'off' });
    const off = await post({ prompt: 'p' });
    expect(off.res.statusCode).toBe(503);
    expect(off.body.error).toBe('video_not_configured');

    const saved = await h.app.server.inject({
      method: 'PUT', url: '/api/admin/video', headers: ADMIN,
      payload: { model: { provider: 'openai-videos', baseUrl: 'https://fake.example.com/v1', apiKey: 'sk-test-key-000000', model: 'fake-video', maxActiveTasks: 1, maxRetries: 0, timeoutMs: 5000 } }
    });
    expect(saved.statusCode).toBe(200);
    const view = saved.json() as { model: Record<string, unknown>; capability: { configured: boolean } };
    expect(view.model.apiKeyConfigured).toBe(true);
    expect(view.model).not.toHaveProperty('apiKey');
    expect(view.capability.configured).toBe(true);

    h.setVideoMode('ok');
    expect((await post({ prompt: '第一条' })).res.statusCode).toBe(202);
    const capped = await post({ prompt: '第二条' });
    expect(capped.res.statusCode).toBe(429);
    expect(capped.body.error).toBe('too_many_active_tasks');
  });

  it('fails a task immediately on a 4xx and keeps retrying on 5xx up to the limit', async () => {
    h = await boot({ video: 'reject' });
    const rejected = (await post({ prompt: 'p' })).body.task!;
    await h.app.services.video.step(rejected.id);
    let current = (await getTask(rejected.id)).task;
    expect(current.status).toBe('failed');
    expect(current.error).toContain('400');
    expect(h.app.repos.errors.list(5).map((row) => row.scope)).toContain('video.generate');

    h.setVideoMode('fail');
    const flaky = (await post({ prompt: 'q' })).body.task!;
    for (let i = 0; i < 4; i++) {
      await h.app.services.video.step(flaky.id);
      current = (await getTask(flaky.id)).task;
      expect(current.status).toBe('queued');
      expect(current.error).toContain('500');
    }
    await h.app.services.video.step(flaky.id);
    current = (await getTask(flaky.id)).task;
    expect(current.status).toBe('failed');
    expect(current.error).toContain('连续 5 次');
  });

  it('cancels an in-flight task, tells the vendor, and only deletes finished records', async () => {
    h = await boot();
    const task = (await post({ prompt: 'p' })).body.task!;
    await h.app.services.video.step(task.id);
    expect((await getTask(task.id)).task.status).toBe('running');

    const active = await h.app.server.inject({ method: 'DELETE', url: `/api/admin/video/generations/${task.id}`, headers: ADMIN });
    expect(active.statusCode).toBe(409);

    const cancelled = await h.app.server.inject({ method: 'POST', url: `/api/admin/video/generations/${task.id}/cancel`, headers: ADMIN });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { task: PublicVideoTask }).task.status).toBe('cancelled');
    expect(h.state.videoRequests.some((call) => call.method === 'DELETE' && call.url.endsWith('/videos/video_fake_1'))).toBe(true);

    // Late polls are ignored.
    const calls = h.state.videoRequests.length;
    await h.app.services.video.step(task.id);
    expect(h.state.videoRequests).toHaveLength(calls);

    const deleted = await h.app.server.inject({ method: 'DELETE', url: `/api/admin/video/generations/${task.id}`, headers: ADMIN });
    expect(deleted.statusCode).toBe(200);
    expect((await getTask(task.id)).res.statusCode).toBe(404);
  });

  it('lists tasks with counts and a status filter', async () => {
    h = await boot();
    const a = (await post({ prompt: 'a' })).body.task!;
    await post({ prompt: 'b' });
    await h.app.server.inject({ method: 'POST', url: `/api/admin/video/generations/${a.id}/cancel`, headers: ADMIN });

    const all = await h.app.server.inject({ method: 'GET', url: '/api/admin/video/generations', headers: ADMIN });
    const body = all.json() as { tasks: PublicVideoTask[]; total: number; active: number };
    expect(body.total).toBe(2);
    expect(body.active).toBe(1);
    expect(body.tasks.map((t) => t.prompt)).toEqual(['b', 'a']);

    const queued = await h.app.server.inject({ method: 'GET', url: '/api/admin/video/generations?status=queued', headers: ADMIN });
    expect((queued.json() as { tasks: PublicVideoTask[] }).tasks.map((t) => t.prompt)).toEqual(['b']);

    const overview = await h.app.server.inject({ method: 'GET', url: '/api/admin/video', headers: ADMIN });
    expect(overview.json()).toMatchObject({ active: 1, total: 2, capability: { capability: 'video', configured: true } });
  });

  it('refuses the generic connection probe for the video slot instead of billing a whole video', async () => {
    h = await boot();
    const res = await h.app.server.inject({ method: 'POST', url: '/api/admin/models/video/test', headers: ADMIN, payload: { force: true } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('test_unsupported');
    expect(h.state.videoRequests).toHaveLength(0);
  });

  it('shows the video slot in capabilities and the model library', async () => {
    h = await boot();
    const caps = await h.app.server.inject({ method: 'GET', url: '/api/admin/capabilities', headers: ADMIN });
    expect((caps.json() as { capabilities: Record<string, { configured: boolean; provider: string }> }).capabilities.video).toMatchObject({ configured: true, provider: 'openai-videos' });
    const presets = await h.app.server.inject({ method: 'GET', url: '/api/admin/model-presets', headers: ADMIN });
    expect((presets.json() as { slots: string[] }).slots).toContain('video');
  });
});

describe('VideoGenerationService with a scripted provider', () => {
  function scripted(script: Partial<VideoProvider> & { downloads?: Buffer }) {
    const provider: VideoProvider = {
      name: 'scripted',
      configured: true,
      createTask: script.createTask ?? (async () => ({ remoteId: 'r1', status: 'queued' })),
      pollTask: script.pollTask ?? (async () => ({ remoteId: 'r1', status: 'running', progress: 10 })),
      download: script.download ?? (async () => ({ data: script.downloads ?? TEST_MP4, mime: 'video/mp4' })),
      cancelTask: script.cancelTask ?? (async () => undefined),
      inspectHealth: async () => ({ capability: 'video', configured: true, ok: true, provider: 'scripted', checkedAt: new Date().toISOString() })
    };
    return provider;
  }

  function service(provider: VideoProvider, now?: () => Date) {
    const app = h!.app;
    return new VideoGenerationService({
      tasks: app.repos.videoTasks,
      media: app.repos.media,
      mediaStore: app.services.mediaStore,
      jobs: app.repos.jobs,
      errors: app.repos.errors,
      capabilities: { videoProvider: () => provider },
      config: app.config,
      now
    });
  }

  it('gives up once the overall deadline passes and cancels upstream', async () => {
    h = await boot();
    const cancelled: string[] = [];
    const provider = scripted({ cancelTask: async (id) => { cancelled.push(id); } });
    const svc = service(provider);
    const task = await svc.create({ prompt: 'p' });
    await svc.step(task.id);
    expect(svc.get(task.id)!.status).toBe('running');

    const late = service(provider, () => new Date(Date.now() + 2 * 60 * 60_000));
    await late.step(task.id);
    const done = late.get(task.id)!;
    expect(done.status).toBe('failed');
    expect(done.error).toContain('分钟');
    expect(cancelled).toEqual(['r1']);
  });

  it('treats a vendor-declared failure and a permanent request error as final', async () => {
    h = await boot();
    const failing = service(scripted({ pollTask: async () => ({ remoteId: 'r1', status: 'failed', error: 'content policy' }) }));
    const a = await failing.create({ prompt: 'a' });
    await failing.step(a.id);
    await failing.step(a.id);
    expect(failing.get(a.id)).toMatchObject({ status: 'failed', error: 'content policy' });

    const unauthorized = service(scripted({ createTask: async () => { throw new ProviderRequestError('video generation failed with status 401: nope', 401); } }));
    const b = await unauthorized.create({ prompt: 'b' });
    await unauthorized.step(b.id);
    expect(unauthorized.get(b.id)!.status).toBe('failed');
    expect(unauthorized.get(b.id)!.error).toContain('401');
  });

  it('rejects a finished file the media store cannot identify as a video', async () => {
    h = await boot();
    const svc = service(scripted({
      pollTask: async (): Promise<VideoTaskSnapshot> => ({ remoteId: 'r1', status: 'succeeded' }),
      download: async () => ({ data: Buffer.from('<html>not a video</html>'), mime: 'video/mp4' })
    }));
    const task = await svc.create({ prompt: 'p' });
    await svc.step(task.id);
    await svc.step(task.id);
    const done = svc.get(task.id)!;
    expect(done.status).toBe('failed');
    expect(done.media).toBeNull();
  });
});
