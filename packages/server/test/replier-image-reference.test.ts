import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TEST_PNG, type Harness } from './helpers/harness.js';

let h: Harness;

afterEach(async () => {
  if (h) await h.cleanup();
});

async function uploadImage(filename: string): Promise<string> {
  const form = new FormData();
  form.set('image', new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' }), filename);
  const response = await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form });
  expect(response.statusCode).toBe(200);
  return response.json().media[0].id as string;
}

describe('image reference reply orchestration', () => {
  it('uses edit for one reference image and persists its media id in generated metadata', async () => {
    h = await createHarness({ image: 'ok', chat: { script: [['我来改一下[[image:保持主体，换成夜景]]']] } });
    const referenceId = await uploadImage('reference.png');
    const response = await h.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: {
        clientMsgId: 'reference-one',
        content: [{ type: 'text', text: '把这张图改成夜景' }, { type: 'image', mediaId: referenceId }]
      }
    });

    const body = response.json();
    const image = body.reply.content.find((part: any) => part.type === 'image');
    expect(image.status).toBe('sent');
    expect(image.meta.referenceMediaId).toBe(referenceId);
    expect(h.state.imageCalls).toBe(1);
  });

  it('rejects multiple reference images before calling the provider and keeps text', async () => {
    h = await createHarness({ image: 'ok', chat: { script: [['我看到了，暂时不能同时处理[[image:合成]]']] } });
    const first = await uploadImage('first.png');
    const second = await uploadImage('second.png');
    const response = await h.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: {
        clientMsgId: 'reference-many',
        content: [
          { type: 'text', text: '同时参考这两张图' },
          { type: 'image', mediaId: first },
          { type: 'image', mediaId: second }
        ]
      }
    });

    const body = response.json();
    const image = body.reply.content.find((part: any) => part.type === 'image');
    const text = body.reply.content.find((part: any) => part.type === 'text');
    expect(image.status).toBe('failed');
    expect(image.error).toContain('一次图生图只能使用一张参考图');
    expect(text.status).toBe('sent');
    expect(h.state.imageCalls).toBe(0);
  });

  it('uses persona references for an [[image-self]] selfie and marks it in metadata', async () => {
    h = await createHarness({ image: 'anuma', chat: { script: [['发一张[[image-self:我站在窗边的自拍]]']] } });
    const response = await h.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: { clientMsgId: 'selfie-1', content: [{ type: 'text', text: '给我看看你' }] }
    });

    const body = response.json();
    const image = body.reply.content.find((part: any) => part.type === 'image');
    expect(image.status).toBe('sent');
    expect(image.meta.selfie).toBe(true);

    const gen = h.state.imageRequests.filter((r) => r.url.includes('/images/generations')).pop();
    expect(gen?.body).toMatchObject({ input_images: ['https://cdn.example/reference.png'] });
  });
});

