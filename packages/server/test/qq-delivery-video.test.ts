import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TEST_MP4, type Harness } from './helpers/harness.js';
import { QqApiClient } from '../src/channels/qq/client.js';
import { QqDeliveryService } from '../src/channels/qq/outbound.js';
import { qqBotConfigFromEnv } from '../src/channels/qq/config.js';
import { QQ_CHANNEL_NAME } from '../src/channels/qq/types.js';
import { classifyQqMedia, mediaSizeLimit, QQ_MEDIA_SIZE_LIMITS } from '../src/channels/qq/media.js';
import type { MediaRow } from '../src/db/repos/media.repo.js';

let h: Harness;
afterEach(async () => {
  if (h) await h.cleanup();
});

interface Call { url: string; init?: RequestInit }

async function buildDelivery() {
  h = await createHarness({ startWorkers: false });
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const raw = String(url);
    calls.push({ url: raw, init });
    if (raw.includes('/getAppAccessToken')) return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 7200 }), { status: 200 });
    if (raw.includes('/files')) return new Response(JSON.stringify({ file_uuid: 'uuid-v', file_info: 'info-v', ttl: 600 }), { status: 200 });
    return new Response(JSON.stringify({ id: 'ROBOT1.0_video' }), { status: 200 });
  }) as typeof fetch;
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

describe('QQ delivery: generated video', () => {
  it('uploads an mp4 file part as a QQ video (file_type 2) and sends a rich media message', async () => {
    const { delivery, calls } = await buildDelivery();
    const media = await h.app.services.mediaStore.save({ kind: 'file', origin: 'generated', data: Buffer.from(TEST_MP4), filename: 'clip.mp4', declaredMime: 'video/mp4' });
    expect(media.mime).toBe('video/mp4');
    const message = h.app.repos.messages.create({
      role: 'assistant',
      status: 'sent',
      parts: [{ type: 'file', mediaId: media.id, status: 'sent', meta: { video: true } }]
    }).message;

    expect(await delivery.deliver({ messageId: message.id })).toBe('sent');

    const upload = calls.find((c) => c.url.includes('/files'));
    const uploadBody = JSON.parse(String(upload!.init!.body)) as { file_type: number; file_data: string };
    expect(uploadBody.file_type).toBe(2);
    expect(Buffer.from(uploadBody.file_data, 'base64')).toEqual(Buffer.from(TEST_MP4));
    const send = calls.find((c) => c.url.includes('/messages') && String(c.init!.body).includes('"msg_type":7'));
    expect(JSON.parse(String(send!.init!.body))).toMatchObject({ msg_type: 7, media: { file_uuid: 'uuid-v', file_info: 'info-v' } });
  });

  it('classifies video containers by MIME and caps their size separately', () => {
    const row = (mime: string): MediaRow => ({ kind: 'file', mime } as MediaRow);
    expect(classifyQqMedia(row('video/mp4'))).toEqual({ fileType: 2, supported: true });
    expect(classifyQqMedia(row('video/webm'))).toMatchObject({ fileType: 2, supported: false });
    expect(classifyQqMedia(row('application/pdf'))).toEqual({ fileType: 4, supported: true });
    expect(mediaSizeLimit(2)).toBe(QQ_MEDIA_SIZE_LIMITS.video);
  });
});
