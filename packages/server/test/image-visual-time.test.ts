import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

/**
 * A new picture is drawn at the real time of day; a scene asked for at another
 * time of day becomes yesterday's. Pictures of her are not something she sends:
 * an [[image-self]] marker is stripped and produces nothing.
 */

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

async function send(h: Harness, clientMsgId: string, text: string) {
  const response = await h.app.server.inject({
    method: 'POST',
    url: '/api/messages/sync',
    payload: { clientMsgId, content: [{ type: 'text', text }] }
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe('image visual time', () => {
  it('draws a new picture at the current time of day', async () => {
    harness = await createHarness({
      image: 'ok',
      startWorkers: false,
      clock: () => localTime('2026-08-26T13:17'),
      env: { ENABLE_BACKGROUND_JOBS: 'false', LIFE_TIME_ZONE: 'Asia/Shanghai' },
      chat: { script: [['换一张普通场景图[[image:晚上客厅里只亮着一盏落地灯]]']] }
    });

    const body = await send(harness, 'visual-time-current-1', '再来一张普通场景图');
    const image = body.reply.content.find((part: any) => part.type === 'image');
    const media = harness.app.repos.media.get(image.mediaId)!;
    const providerPrompt = JSON.stringify(harness.state.imageRequests[0]!.body);

    expect(providerPrompt).toContain('VISUAL TIME CONTINUITY — FINAL HARD CONSTRAINTS');
    expect(providerPrompt).toContain('Real current local time: 2026-08-26 13:17:00');
    expect(providerPrompt).toContain('Depicted day period: midday');
    expect(providerPrompt).toContain('clear bright midday daylight');
    expect(providerPrompt).not.toMatch(/outfit|identity reference/i);
    expect(image.meta.visualTime).toMatchObject({
      timeMode: 'current',
      currentDayPeriod: 'midday',
      depictedLocalDate: '2026-08-26',
      depictedDayPeriod: 'midday',
      requestedDayPeriod: null
    });
    expect(JSON.parse(media.meta_json).visualTime).toEqual(image.meta.visualTime);
  });

  it('turns a night scene asked for at midday into yesterday', async () => {
    harness = await createHarness({
      image: 'ok',
      startWorkers: false,
      clock: () => localTime('2026-08-26T13:17'),
      env: { ENABLE_BACKGROUND_JOBS: 'false', LIFE_TIME_ZONE: 'Asia/Shanghai' },
      chat: { script: [['好呀，现在做给你。[[image:晚上准备睡觉的安静卧室]]']] }
    });

    const body = await send(harness, 'visual-time-retro-1', '发张晚上睡觉的房间图');
    const text = body.reply.content.find((part: any) => part.type === 'text')?.text;
    const image = body.reply.content.find((part: any) => part.type === 'image');
    const providerPrompt = JSON.stringify(harness.state.imageRequests[0]!.body);

    expect(text).toBe('现在还是中午，不过昨天倒是有一张这种。');
    expect(providerPrompt).toContain('newly generated retrospective depiction');
    expect(providerPrompt).toContain('Depicted local date: 2026-08-25');
    expect(providerPrompt).toContain('Depicted day period: evening');
    expect(image.meta.visualTime).toMatchObject({
      timeMode: 'retrospective',
      currentDayPeriod: 'midday',
      depictedLocalDate: '2026-08-25',
      depictedDayPeriod: 'evening',
      requestedDayPeriod: 'evening'
    });
  });

  it('strips an [[image-self]] marker and draws nothing', async () => {
    harness = await createHarness({
      image: 'ok',
      startWorkers: false,
      env: { ENABLE_BACKGROUND_JOBS: 'false' },
      chat: { script: [['在呢～[[image-self:窝在沙发上看书]]']] }
    });

    const body = await send(harness, 'self-marker-1', '在干嘛');
    expect(harness.state.imageCalls).toBe(0);
    expect(body.reply.content.some((part: any) => part.type === 'image')).toBe(false);
    expect(JSON.stringify(body.reply.content)).not.toContain('image-self');
    expect(body.reply.content.find((part: any) => part.type === 'text')?.text).toBe('在呢～');
  });
});
