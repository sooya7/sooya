import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';
import { ImageEditUnsupportedError } from '../src/providers/types.js';

/** Smallest valid PNG, so the media store's sniffing accepts it. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

interface EditCall {
  prompt: string;
  image: Buffer;
  mime?: string;
}

function stubProvider(h: Harness) {
  const provider = h.app.services.capabilities.imageProvider() as unknown as {
    generate: (prompt: string) => Promise<{ data: Buffer; mime: string }>;
    edit: (prompt: string, image: Buffer, opts?: { mime?: string }) => Promise<{ data: Buffer; mime: string }>;
  };
  const calls: string[] = [];
  const edits: EditCall[] = [];
  provider.generate = async () => {
    calls.push('generate');
    return { data: PNG, mime: 'image/png' };
  };
  provider.edit = async (prompt, image, opts) => {
    calls.push('edit');
    edits.push({ prompt, image, mime: opts?.mime });
    return { data: PNG, mime: 'image/png' };
  };
  return { calls, edits };
}

async function sendImage(h: Harness, mediaId: string, text: string) {
  const res = await h.app.server.inject({
    method: 'POST',
    url: '/api/messages/sync',
    payload: {
      clientMsgId: `ref_${Math.random().toString(36).slice(2)}`,
      content: [{ type: 'image', mediaId }, { type: 'text', text }]
    }
  });
  return { res, body: res.json() as Record<string, any> };
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

describe('reference image', () => {
  it('edits the image the user just sent instead of generating from scratch', async () => {
    h = await createHarness({ image: 'ok', chat: { script: [['改好啦[[image:把猫换成橘色]]']] } });
    const stub = stubProvider(h);
    const saved = await h.app.services.mediaStore.save({
      kind: 'image',
      origin: 'upload',
      data: PNG,
      declaredMime: 'image/png',
      filename: 'cat.png'
    });

    const { body } = await sendImage(h, saved.id, '把猫换成橘色');

    expect(stub.calls).toEqual(['edit']);
    expect(stub.edits[0]?.prompt).toBe('把猫换成橘色');
    expect(stub.edits[0]?.image.equals(PNG)).toBe(true);
    expect(stub.edits[0]?.mime).toBe('image/png');
    const image = (body.reply.content as Array<Record<string, any>>).find((part) => part.type === 'image');
    expect(image?.status).toBe('sent');
    expect(image?.meta?.referenceMediaId).toBe(saved.id);
  });

  it('generates from the prompt alone when the user sent no image', async () => {
    h = await createHarness({ image: 'ok', chat: { script: [['看这个[[image:窗台上的猫]]']] } });
    const stub = stubProvider(h);

    const { body } = await sendText(h.app, '画只猫', 'no-ref');

    expect(stub.calls).toEqual(['generate']);
    const image = (body.reply.content as Array<Record<string, any>>).find((part) => part.type === 'image');
    expect(image?.status).toBe('sent');
    expect(image?.meta?.referenceMediaId).toBeUndefined();
  });

  it('still produces an image when the provider rejects the edits endpoint', async () => {
    h = await createHarness({ image: 'ok', chat: { script: [['试试看[[image:换个颜色]]']] } });
    const stub = stubProvider(h);
    const provider = h.app.services.capabilities.imageProvider() as unknown as {
      edit: () => Promise<never>;
    };
    provider.edit = async () => {
      stub.calls.push('edit');
      throw new ImageEditUnsupportedError('edits not supported');
    };
    const saved = await h.app.services.mediaStore.save({
      kind: 'image',
      origin: 'upload',
      data: PNG,
      declaredMime: 'image/png',
      filename: 'cat.png'
    });

    const { body } = await sendImage(h, saved.id, '换个颜色');

    expect(stub.calls).toEqual(['edit', 'generate']);
    const image = (body.reply.content as Array<Record<string, any>>).find((part) => part.type === 'image');
    expect(image?.status).toBe('sent');
  });

  it('does not hide a real edit failure by generating an unrelated image', async () => {
    h = await createHarness({ image: 'ok', chat: { script: [['我没能改好[image:换个颜色]']] } });
    const stub = stubProvider(h);
    const provider = h.app.services.capabilities.imageProvider() as unknown as { edit: () => Promise<never> };
    provider.edit = async () => {
      stub.calls.push('edit');
      throw new Error('upstream unavailable');
    };
    const saved = await h.app.services.mediaStore.save({
      kind: 'image', origin: 'upload', data: PNG, declaredMime: 'image/png', filename: 'cat.png'
    });

    const { body } = await sendImage(h, saved.id, '换个颜色');

    expect(stub.calls).toEqual(['edit']);
    const image = (body.reply.content as Array<Record<string, any>>).find((part) => part.type === 'image');
    expect(image?.status).toBe('failed');
  });
});
