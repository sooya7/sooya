import { describe, expect, it, vi } from 'vitest';
import { ImageModelSchema } from '../src/config/schema.js';
import { AnumaImageProvider, OpenAIImageProvider } from '../src/providers/image.js';
import { ImageEditUnsupportedError, ImageReferenceError, ProviderRequestError } from '../src/providers/types.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function config(overrides: Record<string, unknown> = {}) {
  return ImageModelSchema.parse({
    provider: 'anuma-input-images',
    baseUrl: 'https://anuma.example/v1',
    apiKey: 'test-key',
    model: 'anuma-image',
    timeoutMs: 5000,
    uploadTimeoutMs: 1000,
    uploadMaxRetries: 0,
    ...overrides
  });
}

function deps(fetchImpl: typeof fetch) {
  return { allowPrivateNetwork: true, fetchImpl };
}

describe('Anuma input_images image provider', () => {
  it('generates without a reference image using only confirmed request fields', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new AnumaImageProvider(config(), deps(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(input), body });
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
    }));

    const result = await provider.generate('a red umbrella');

    expect(result.data).toEqual(PNG);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/images/generations');
    expect(calls[0]?.body).toEqual({ model: 'anuma-image', prompt: 'a red umbrella', n: 1 });
  });

  it('uploads one reference image then passes the returned HTTPS URL as input_images', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new AnumaImageProvider(config(), deps(async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).includes('/media/upload')) {
        return new Response(JSON.stringify({ url: 'https://cdn.example/reference.png?sig=secret' }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
    }));

    await provider.edit('keep the pose', PNG, { mime: 'image/png' });

    expect(calls).toHaveLength(2);
    const upload = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(upload).toEqual({ filename: 'reference.png', content_type: 'image/png', data: PNG.toString('base64') });
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer test-key', 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      model: 'anuma-image',
      prompt: 'keep the pose',
      n: 1,
      input_images: ['https://cdn.example/reference.png?sig=secret']
    });
  });

  it('materializes a URL response without exposing the signed URL in provider errors', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const provider = new AnumaImageProvider(config(), deps(async () =>
        new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/generated.png?sig=secret' }] }), { status: 200 })
      ));
      const result = await provider.generate('a blue cup');
      expect(result.data).toEqual(PNG);
      expect(fetchSpy).toHaveBeenCalledWith('https://cdn.example/generated.png?sig=secret', expect.anything());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects empty, unsupported, oversized, and non-HTTPS upload inputs', async () => {
    const provider = new AnumaImageProvider(config(), deps(async () => new Response('{}', { status: 200 })));
    await expect(provider.edit('x', Buffer.alloc(0), { mime: 'image/png' })).rejects.toMatchObject({ code: 'reference_image_too_large' });
    await expect(provider.edit('x', PNG, { mime: 'image/tiff' })).rejects.toMatchObject({ code: 'reference_image_type_unsupported' });
    await expect(provider.edit('x', Buffer.alloc(10 * 1024 * 1024 + 1), { mime: 'image/png' })).rejects.toMatchObject({ code: 'reference_image_too_large' });

    const invalidUrl = new AnumaImageProvider(config(), deps(async () =>
      new Response(JSON.stringify({ url: 'http://cdn.example/reference.png' }), { status: 200 })
    ));
    await expect(invalidUrl.edit('x', PNG, { mime: 'image/png' })).rejects.toMatchObject({
      code: 'reference_upload_invalid_response'
    });
  });

  it('retries transient upload failures but not client failures', async () => {
    let transientAttempts = 0;
    const transient = new AnumaImageProvider(config({ uploadMaxRetries: 1 }), deps(async (input) => {
      if (String(input).includes('/media/upload')) {
        transientAttempts++;
        if (transientAttempts === 1) return new Response('busy', { status: 503 });
        return new Response(JSON.stringify({ url: 'https://cdn.example/reference.png' }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
    }));
    await transient.edit('x', PNG, { mime: 'image/png' });
    expect(transientAttempts).toBe(2);

    let clientAttempts = 0;
    const client = new AnumaImageProvider(config({ uploadMaxRetries: 3 }), deps(async (input) => {
      if (String(input).includes('/media/upload')) clientAttempts++;
      return new Response('bad request', { status: 400 });
    }));
    await expect(client.edit('x', PNG, { mime: 'image/png' })).rejects.toBeInstanceOf(ImageReferenceError);
    expect(clientAttempts).toBe(1);
  });

  it('only treats explicit edit capability failures as fallback-worthy', async () => {
    const openAiConfig = ImageModelSchema.parse({
      provider: 'openai-images', baseUrl: 'https://openai.example/v1', apiKey: 'test-key', model: 'image-model', maxRetries: 0
    });
    const unsupported = new OpenAIImageProvider(openAiConfig, deps(async () => new Response('image edits not supported', { status: 400 })));
    await expect(unsupported.edit('x', PNG, { mime: 'image/png' })).rejects.toBeInstanceOf(ImageEditUnsupportedError);

    const generic = new OpenAIImageProvider(openAiConfig, deps(async () => new Response('bad prompt', { status: 400 })));
    await expect(generic.edit('x', PNG, { mime: 'image/png' })).rejects.toBeInstanceOf(ProviderRequestError);
  });
});
