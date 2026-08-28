import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

async function sendSelfie(h: Harness, clientMsgId: string, text: string) {
  const response = await h.app.server.inject({
    method: 'POST',
    url: '/api/messages/sync',
    payload: { clientMsgId, content: [{ type: 'text', text }] }
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

function directorReply(prompt: string, outfit: string): string {
  return JSON.stringify({ prompt, aspectRatio: '3:4', outfit });
}

function stageCandidate(h: Harness): void {
  const oldUser = h.app.repos.messages.create({
    role: 'user',
    status: 'sent',
    parts: [{ type: 'text', text: '早上好' }]
  });
  h.app.db.raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?')
    .run(localTime('2026-08-22T09:00').toISOString(), oldUser.message.id);
  h.app.repos.life.advance({
    activity: '去公园看猫',
    kind: 'out',
    mood: '好奇',
    startedAt: localTime('2026-08-22T14:00').toISOString(),
    endsAt: localTime('2026-08-22T17:00').toISOString()
  });
  h.app.repos.life.advance({
    activity: '练琴',
    kind: 'play',
    mood: '专注',
    startedAt: localTime('2026-08-22T17:00').toISOString(),
    endsAt: localTime('2026-08-22T18:00').toISOString()
  });
}

const baselineOutfit = '黑色轻便休闲外套、浅色简洁内搭、深色直筒长裤和白色休闲鞋';

describe('daily visual continuity integration', () => {
  it('keeps two ordinary same-day chat selfies in one outfit even if the second director drifts', async () => {
    harness = await createHarness({
      image: 'anuma',
      startWorkers: false,
      clock: () => localTime('2026-08-22T15:30'),
      env: {
        ENABLE_BACKGROUND_JOBS: 'false',
        ENABLE_LIFE_ENGINE: 'true',
        LIFE_TIME_ZONE: 'Asia/Shanghai'
      },
      chat: {
        script: [
          ['给你看[[image-self:我在图书馆窗边看小说的自然自拍]]'],
          [directorReply('Natural library-window phone selfie, wearing a black casual jacket and dark trousers.', baselineOutfit)],
          ['再来一张[[image-self:我换个角度坐在咖啡店窗边的自拍]]'],
          [directorReply('A cafe selfie in a bright blue dress and red heels.', '亮蓝色连衣裙和红色高跟鞋')]
        ]
      }
    });

    const first = await sendSelfie(harness, 'continuity-chat-1', '给我看看你今天的样子');
    expect(first.reply.content.find((part: any) => part.type === 'image')?.status).toBe('sent');
    expect(harness.app.services.imageContinuity.current()).toMatchObject({
      dateKey: '2026-08-22',
      outfit: { fullDescription: baselineOutfit },
      outfitRevision: 1
    });

    const second = await sendSelfie(harness, 'continuity-chat-2', '换个地方再拍一张，衣服保持一样');
    const secondImage = second.reply.content.find((part: any) => part.type === 'image');
    expect(secondImage).toMatchObject({
      status: 'sent',
      meta: {
        selfie: true,
        continuity: {
          outfit: baselineOutfit,
          outfitMode: 'locked',
          outfitRevision: 1
        }
      }
    });

    expect(harness.state.imageRequests).toHaveLength(2);
    const finalPrompt = JSON.stringify(harness.state.imageRequests[1]!.body);
    expect(finalPrompt).toContain('DAILY VISUAL CONTINUITY — HARD CONSTRAINTS');
    expect(finalPrompt).toContain(baselineOutfit);
    expect(finalPrompt).toContain('Keep every garment type, color, material, and layer unchanged');
    expect(harness.app.services.imageContinuity.current()).toMatchObject({
      outfit: { fullDescription: baselineOutfit },
      outfitRevision: 1
    });
  });

  it('does not commit an outfit when image generation fails', async () => {
    harness = await createHarness({
      image: 'fail',
      startWorkers: false,
      clock: () => localTime('2026-08-22T15:30'),
      env: { ENABLE_BACKGROUND_JOBS: 'false', LIFE_TIME_ZONE: 'Asia/Shanghai' },
      chat: {
        script: [
          ['试试看[[image-self:我在窗边的自拍]]'],
          [directorReply('Natural window selfie in soft daylight.', baselineOutfit)]
        ]
      }
    });

    const body = await sendSelfie(harness, 'continuity-fail-1', '发张自拍');
    expect(body.reply.content.find((part: any) => part.type === 'image')?.status).toBe('failed');
    expect(harness.app.services.imageContinuity.current()).toBeNull();
  });

  it('forces an unspecified 13:17 continuation back to current midday despite a stale night director prompt', async () => {
    harness = await createHarness({
      image: 'anuma',
      startWorkers: false,
      clock: () => localTime('2026-08-26T13:17'),
      env: { ENABLE_BACKGROUND_JOBS: 'false', LIFE_TIME_ZONE: 'Asia/Shanghai' },
      chat: {
        script: [
          ['再给你一张[[image-self:晚上在家，借着落地灯暖光看书]]'],
          [directorReply('At night at home, reading under a warm floor lamp.', baselineOutfit)]
        ]
      }
    });

    const body = await sendSelfie(harness, 'visual-time-current-1', '再来一张');
    const image = body.reply.content.find((part: any) => part.type === 'image');
    const media = harness.app.repos.media.get(image.mediaId)!;
    const providerPrompt = JSON.stringify(harness.state.imageRequests[0]!.body);

    expect(providerPrompt).toContain('Real current local time: 2026-08-26 13:17:00');
    expect(providerPrompt).toContain('Depicted day period: midday');
    expect(providerPrompt).toContain('clear bright midday daylight');
    expect(image.meta.continuity).toMatchObject({
      timeMode: 'current',
      currentDayPeriod: 'midday',
      depictedLocalDate: '2026-08-26',
      depictedDayPeriod: 'midday',
      requestedDayPeriod: null,
      outfit: baselineOutfit,
      outfitRevision: 1
    });
    expect(JSON.parse(media.meta_json).continuity).toEqual(image.meta.continuity);
  });

  it('allows a new night image at 13:17 only as yesterday without leaking current Life facts or continuity state', async () => {
    harness = await createHarness({
      image: 'anuma',
      startWorkers: false,
      clock: () => localTime('2026-08-26T13:17'),
      env: {
        ENABLE_BACKGROUND_JOBS: 'false',
        ENABLE_LIFE_ENGINE: 'true',
        LIFE_TIME_ZONE: 'Asia/Shanghai',
        WORLD_CONTEXT_ENABLED: 'true',
        LOCATION_MODEL_ENABLED: 'true'
      },
      chat: {
        script: [
          ['好呀，现在拍给你。[[image-self:晚上在家穿着家居服准备睡觉]]'],
          [directorReply('At night at home, getting ready to sleep.', '宽松浅色家居上衣、深色柔软家居长裤和室内拖鞋')]
        ]
      }
    });
    const home = harness.app.services.location.list().find((location) => location.kind === 'home')!;
    harness.app.services.location.override(home.id, 'test: establish current home location');
    harness.app.repos.life.advance({
      activity: '午睡一会儿',
      kind: 'rest',
      mood: '平静',
      startedAt: localTime('2026-08-26T13:00').toISOString(),
      endsAt: localTime('2026-08-26T14:00').toISOString()
    });
    const lifeEventCount = harness.app.repos.life.events().length;

    const body = await sendSelfie(harness, 'visual-time-retro-1', '发张晚上睡觉的照片');
    const text = body.reply.content.find((part: any) => part.type === 'text')?.text;
    const image = body.reply.content.find((part: any) => part.type === 'image');
    const media = harness.app.repos.media.get(image.mediaId)!;
    const directorBody = harness.state.chatCalls[1]!.body as {
      messages: Array<{ role: string; content: string }>;
    };
    const directorInput = directorBody.messages.find((message) => message.role === 'user')!.content;
    const directorContinuity = JSON.parse(directorInput.slice(directorInput.indexOf('{'))).continuity;
    const providerPrompt = JSON.stringify(harness.state.imageRequests[0]!.body);
    const messageContinuity = image.meta.continuity;
    const mediaContinuity = JSON.parse(media.meta_json).continuity;

    expect(text).toBe('现在还是中午，不过昨天倒是有一张这种。');
    expect(directorContinuity).toMatchObject({ currentActivity: null, currentLocation: null });
    expect(JSON.stringify(directorContinuity)).not.toContain('午睡一会儿');
    expect(providerPrompt).toContain('newly generated retrospective depiction');
    expect(providerPrompt).toContain('Depicted local date: 2026-08-25');
    expect(providerPrompt).toContain('Depicted day period: evening');
    expect(providerPrompt).toContain('宽松浅色家居上衣');
    expect(messageContinuity).toMatchObject({
      timeMode: 'retrospective',
      currentDayPeriod: 'midday',
      depictedLocalDate: '2026-08-25',
      depictedDayPeriod: 'evening',
      requestedDayPeriod: 'evening',
      commitState: 'skipped',
      commitReason: 'retrospective_scene'
    });
    expect(messageContinuity).not.toHaveProperty('outfitRevision');
    expect(messageContinuity).not.toHaveProperty('activity');
    expect(messageContinuity).not.toHaveProperty('activityKind');
    expect(messageContinuity).not.toHaveProperty('location');
    expect(mediaContinuity).toEqual(messageContinuity);
    expect(harness.app.services.imageContinuity.current()).toBeNull();
    expect(harness.app.repos.life.events()).toHaveLength(lifeEventCount);
  });

  it('shares the same persisted outfit between chat selfies and proactive lifestyle Moments', async () => {
    harness = await createHarness({
      image: 'anuma',
      startWorkers: false,
      clock: () => localTime('2026-08-22T17:30'),
      env: {
        ENABLE_LIFE_ENGINE: 'true',
        ENABLE_LIFE_REACH_OUT: 'true',
        LIFE_QUIET_GAP_MINUTES: '60',
        ENABLE_BACKGROUND_JOBS: 'false',
        ADMIN_API_TOKEN: 'admin-test-token',
        LIFE_TIME_ZONE: 'Asia/Shanghai'
      },
      chat: {
        script: [
          ['好呀[[image-self:我在琴房窗边的生活自拍]]'],
          [directorReply('Natural selfie beside a piano-room window.', baselineOutfit)],
          [JSON.stringify({
            text: '公园那只橘猫今天格外黏人，踩着我的鞋不肯走。',
            image: { kind: 'lifestyle', scene: 'SOOYA 蹲在社区公园步道旁和橘猫玩' }
          })],
          [directorReply('SOOYA crouching beside a park path playing with an orange cat, wearing a white dress.', '白色连衣裙和棕色短靴')]
        ]
      }
    });
    stageCandidate(harness);

    await sendSelfie(harness, 'continuity-shared-chat', '练琴的时候拍张自拍给我');
    const chatState = harness.app.services.imageContinuity.current();
    expect(chatState).toMatchObject({
      outfit: { fullDescription: baselineOutfit },
      outfitRevision: 1,
      activity: '练琴'
    });

    const result = await harness.app.services.proactive.run({ mode: 'image' });
    expect(result.status).toBe('sent');
    expect(result.finalMode).toBe('image');
    expect(harness.state.imageRequests).toHaveLength(2);
    const proactivePrompt = JSON.stringify(harness.state.imageRequests[1]!.body);
    expect(proactivePrompt).toContain('Real current activity: 去公园看猫');
    expect(proactivePrompt).toContain(baselineOutfit);
    expect(proactivePrompt).toContain('Keep every garment type');
    expect(proactivePrompt).toContain('LIFESTYLE COMPOSITION');
    expect(harness.state.imageRequests[1]!.body.input_images).toBeDefined();

    const state = harness.app.services.imageContinuity.current();
    expect(state).toMatchObject({
      outfit: { fullDescription: baselineOutfit },
      outfitRevision: 1,
      activity: '去公园看猫'
    });
    expect(harness.app.repos.proactive.list(1)[0]!.detail).toMatchObject({
      photoKind: 'lifestyle',
      continuity: {
        outfit: baselineOutfit,
        outfitMode: 'locked',
        outfitRevision: 1
      }
    });
    expect(harness.app.repos.moments.get(result.momentId!)!.image_kind).toBe('lifestyle');
  });

  it('proactive lifestyle photos participate in outfit continuity and commit only after successful generation', async () => {
    harness = await createHarness({
      image: 'fail',
      startWorkers: false,
      clock: () => localTime('2026-08-22T17:30'),
      env: {
        ENABLE_LIFE_ENGINE: 'true',
        ENABLE_LIFE_REACH_OUT: 'true',
        LIFE_QUIET_GAP_MINUTES: '60',
        ENABLE_BACKGROUND_JOBS: 'false',
        ADMIN_API_TOKEN: 'admin-test-token',
        LIFE_TIME_ZONE: 'Asia/Shanghai'
      },
      chat: {
        script: [
          [JSON.stringify({
            text: '公园的小路刚下过雨，我还是蹲下来看了会儿猫。',
            image: { kind: 'lifestyle', scene: 'SOOYA 蹲在雨后公园步道旁看橘猫' }
          })],
          [JSON.stringify({
            prompt: 'Candid photo of SOOYA crouching beside a wet park path watching a cat.',
            aspectRatio: '3:4',
            outfit: baselineOutfit
          })]
        ]
      }
    });
    stageCandidate(harness);

    const result = await harness.app.services.proactive.run({ mode: 'image' });
    expect(result.status).toBe('sent');
    expect(result.finalMode).toBe('text');
    expect(result.fallbackReason).toBe('image_failed');
    // The lifestyle plan entered the continuity flow, but a failed generation
    // must not leave any persisted outfit behind.
    expect(harness.app.services.imageContinuity.current()).toBeNull();
    expect(harness.app.repos.moments.get(result.momentId!)!.image_media_id).toBeNull();
  });

});
