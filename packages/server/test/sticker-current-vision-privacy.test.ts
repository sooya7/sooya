import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TEST_PNG, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

async function makeSticker() {
  const media = await harness!.app.services.mediaStore.save({
    kind: 'sticker',
    origin: 'upload',
    data: TEST_PNG,
    filename: 'privacy-sticker.png',
    meta: {}
  });
  const sticker = harness!.app.repos.stickers.create({
    mediaId: media.id,
    name: '隐私测试猫',
    emotion: '害羞',
    tags: ['猫', '害羞'],
    description: '内部视觉描述绝对不能出现在当前表情包提示里',
    imageText: '内部图片文字',
    userMeaning: '内部用户用法',
    nameSource: 'manual',
    analysisSource: 'manual',
    analysisStatus: 'ready'
  });
  return { media, sticker };
}

async function sendSticker(mediaId: string, stickerId: string) {
  return harness!.app.server.inject({
    method: 'POST',
    url: '/api/messages/sync',
    payload: {
      clientMsgId: `privacy-${Date.now()}-${Math.random()}`,
      content: [{ type: 'sticker', mediaId, meta: { stickerId } }]
    }
  });
}

function latestUserContent(): string {
  const body = harness!.state.chatCalls.at(-1)!.body as { messages?: Array<{ role?: string; content?: unknown }> };
  const user = [...(body.messages ?? [])].reverse().find((message) => message.role === 'user');
  return JSON.stringify(user?.content ?? null);
}

describe('current sticker vision privacy', () => {
  it('sends the current sticker image without private semantic metadata when vision is available', async () => {
    harness = await createHarness({ skipStickerImport: true, vision: true });
    const { media, sticker } = await makeSticker();

    const response = await sendSticker(media.id, sticker.id);
    expect(response.statusCode).toBe(200);
    expect(harness.state.chatCalls.length).toBeGreaterThan(0);

    const content = latestUserContent();
    expect(content).toContain('image_url');
    expect(content).toContain('[用户发送了表情包]');
    expect(content).not.toContain('内部视觉描述绝对不能出现在当前表情包提示里');
    expect(content).not.toContain('内部图片文字');
    expect(content).not.toContain('内部用户用法');
    expect(content).not.toContain('含义：');
    expect(content).not.toContain('图片文字：');
  });

  it('keeps semantic text as the fallback when the chat model cannot see images', async () => {
    harness = await createHarness({ skipStickerImport: true, vision: false });
    const { media, sticker } = await makeSticker();

    const response = await sendSticker(media.id, sticker.id);
    expect(response.statusCode).toBe(200);

    const content = latestUserContent();
    expect(content).not.toContain('image_url');
    expect(content).toContain('内部视觉描述绝对不能出现在当前表情包提示里');
    expect(content).toContain('内部图片文字');
  });
});
