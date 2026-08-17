import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { createHarness, TEST_PNG, type Harness } from './helpers/harness.js';
import { QqApiClient } from '../src/channels/qq/client.js';
import { QqDeliveryService } from '../src/channels/qq/outbound.js';
import { qqBotConfigFromEnv } from '../src/channels/qq/config.js';
import { QQ_CHANNEL_NAME } from '../src/channels/qq/types.js';

let h: Harness;

afterEach(async () => {
  if (h) await h.cleanup();
});

interface Call {
  url: string;
  init?: RequestInit;
}

function routedMock(routes: {
  files?: (init?: RequestInit) => { status: number; body: Record<string, unknown> };
  messages?: (init?: RequestInit) => { status: number; body: Record<string, unknown> };
}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const raw = String(url);
    calls.push({ url: raw, init });
    if (raw.includes('/getAppAccessToken')) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 7200 }), { status: 200 });
    }
    if (raw.includes('/files')) {
      const r = routes.files?.(init) ?? { status: 200, body: { file_uuid: 'uuid-1', file_info: 'info-1', ttl: 600 } };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    const r = routes.messages?.(init) ?? { status: 200, body: { id: 'ROBOT1.0_sent' } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function buildDelivery(script: { files?: (init?: RequestInit) => { status: number; body: Record<string, unknown> }; messages?: (init?: RequestInit) => { status: number; body: Record<string, unknown> } } = {}) {
  h = await createHarness({ startWorkers: false });
  const { fetchImpl, calls } = routedMock(script);
  const client = new QqApiClient(qqBotConfigFromEnv({ QQ_APP_ID: '102000000', QQ_APP_SECRET: 's', QQ_CALLBACK_SECRET: 'c' }), { fetchImpl });
  const delivery = new QqDeliveryService({
    deliveries: h.app.repos.channelDeliveries,
    identities: h.app.repos.channelIdentities,
    events: h.app.repos.channelEvents,
    messages: h.app.repos.messages,
    replyBatches: h.app.repos.replyBatches,
    media: h.app.repos.media,
    mediaStore: h.app.services.mediaStore,
    jobs: h.app.repos.jobs,
    errors: h.app.repos.errors,
    client
  });
  h.app.repos.channelIdentities.bindOwner({ channel: QQ_CHANNEL_NAME, externalUserId: 'owner-uuid', externalConversationId: 'owner-uuid' });
  return { delivery, calls };
}

async function assistantWithParts(parts: Array<Record<string, unknown>>) {
  return h!.app.repos.messages.create({
    role: 'assistant',
    status: 'sent',
    parts: parts as never
  }).message;
}

function parseJson(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init!.body)) as Record<string, unknown>;
}

describe('QQ delivery: image media', () => {
  it('uploads a saved image and sends it as a rich media message', async () => {
    const { delivery, calls } = await buildDelivery();
    const media = await h!.app.services.mediaStore.save({ kind: 'image', data: Buffer.from(TEST_PNG), filename: 'a.png', origin: 'upload' });
    const message = await assistantWithParts([
      { type: 'text', text: '看看这个' },
      { type: 'image', mediaId: media.id, status: 'sent' }
    ]);

    expect(await delivery.deliver({ messageId: message.id })).toBe('sent');

    const upload = calls.find((c) => c.url.includes('/files'));
    expect(upload).toBeTruthy();
    const uploadBody = parseJson(upload!);
    expect(uploadBody.file_type).toBe(1);
    expect(Buffer.from(String(uploadBody.file_data), 'base64').subarray(0, 8)).toEqual(Buffer.from(TEST_PNG).subarray(0, 8));

    const send = calls.find((c) => c.url.includes('/messages') && String(c.init!.body).includes('"msg_type":7'));
    expect(send).toBeTruthy();
    expect(parseJson(send!)).toMatchObject({ msg_type: 7, media: { file_uuid: 'uuid-1', file_info: 'info-1' } });

    const row = h!.app.repos.channelDeliveries.find('qq', message.id, 'owner-uuid');
    expect(row?.status).toBe('sent');
    expect(row?.remote_message_id).toBe('ROBOT1.0_sent');
  });

  it('converts webp images to png before uploading', async () => {
    const { delivery, calls } = await buildDelivery();
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 0, b: 0 } } }).webp().toBuffer();
    const media = await h!.app.services.mediaStore.save({ kind: 'image', data: webp, filename: 'a.webp', origin: 'upload' });
    const message = await assistantWithParts([{ type: 'image', mediaId: media.id, status: 'sent' }]);

    expect(await delivery.deliver({ messageId: message.id })).toBe('sent');
    const upload = calls.find((c) => c.url.includes('/files'));
    const uploaded = Buffer.from(String(parseJson(upload!).file_data), 'base64');
    // PNG magic: 89 50 4E 47
    expect(uploaded.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe('QQ delivery: media fallback', () => {
  it('skips a failed image upload without failing the whole delivery (text still goes)', async () => {
    const { delivery, calls } = await buildDelivery({
      files: () => ({ status: 400, body: { err_code: 11253, message: 'no privilege' } })
    });
    const media = await h!.app.services.mediaStore.save({ kind: 'image', data: Buffer.from(TEST_PNG), filename: 'a.png', origin: 'upload' });
    const message = await assistantWithParts([
      { type: 'text', text: '文字还在' },
      { type: 'image', mediaId: media.id, status: 'sent' }
    ]);

    expect(await delivery.deliver({ messageId: message.id })).toBe('sent');
    const textSend = calls.find((c) => c.url.includes('/messages'));
    expect(parseJson(textSend!)).toMatchObject({ msg_type: 0, content: '文字还在' });
    expect(h!.app.repos.channelDeliveries.find('qq', message.id, 'owner-uuid')?.status).toBe('sent');
    const mediaErrors = h!.app.repos.errors.list(50).filter((e) => e.scope === "qq.media");
    expect(mediaErrors.length).toBeGreaterThan(0);
  });

  it('falls back a sticker to its meaning text when upload fails', async () => {
    const { delivery, calls } = await buildDelivery({
      files: () => ({ status: 500, body: { err_code: 0, message: 'boom' } })
    });
    const media = await h!.app.services.mediaStore.save({ kind: 'sticker', data: Buffer.from(TEST_PNG), filename: 's.png', origin: 'builtin' });
    const message = await assistantWithParts([
      { type: 'sticker', mediaId: media.id, status: 'sent', meta: { stickerId: 'st1', stickerName: '开心', stickerMeaning: '开心地笑了' } }
    ]);

    expect(await delivery.deliver({ messageId: message.id })).toBe('sent');
    const textSends = calls.filter((c) => c.url.includes('/messages'));
    expect(textSends).toHaveLength(1);
    expect(parseJson(textSends[0]!)).toMatchObject({ msg_type: 0, content: '开心地笑了' });
  });

  it('falls back unsupported audio to its transcript text', async () => {
    const { delivery, calls } = await buildDelivery();
    // 伪造 OggS 音频行（audio/ogg → QQ 不支持）→ 走 transcript 降级。
    // MediaStore.save 有 mime 白名单，这里直接造行 + 写文件。
    const oggBytes = Buffer.concat([Buffer.from('OggS', 'utf8'), Buffer.alloc(64)]);
    const media = h!.app.repos.media.create({
      kind: 'audio',
      relPath: 'test-ogg.bin',
      mime: 'audio/ogg',
      bytes: oggBytes.byteLength,
      sha256: 'x',
      origin: 'generated',
      transcript: '语音内容：我在散步'
    });
    await fs.writeFile(h!.app.services.mediaStore.absolutePath(media), oggBytes);
    const message = await assistantWithParts([{ type: 'audio', mediaId: media.id, status: 'sent' }]);

    expect(await delivery.deliver({ messageId: message.id })).toBe('sent');
    const textSends = calls.filter((c) => c.url.includes('/messages'));
    expect(textSends).toHaveLength(1);
    expect(parseJson(textSends[0]!)).toMatchObject({ msg_type: 0, content: '语音内容：我在散步' });
  });
});