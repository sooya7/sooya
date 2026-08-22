import { describe, expect, it } from 'vitest';
import type { SettingsRepo } from '../src/db/repos/misc.repo.js';
import {
  DAILY_IMAGE_CONTINUITY_KEY,
  ImageContinuityService,
  type PreparedImageContinuity
} from '../src/core/image-continuity.js';

class MemorySettings {
  readonly values = new Map<string, unknown>();

  get<T>(key: string, fallback: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T;
  }

  set<T>(key: string, value: T): void {
    this.values.set(key, value);
  }
}

function serviceAt(settings: MemorySettings, iso = '2026-08-22T04:00:00.000Z'): ImageContinuityService {
  return new ImageContinuityService(settings as unknown as SettingsRepo, {
    clock: () => new Date(iso),
    timeZone: 'Asia/Shanghai'
  });
}

function ordinary(service: ImageContinuityService, extra: Partial<Parameters<ImageContinuityService['prepare']>[0]> = {}): PreparedImageContinuity {
  return service.prepare({
    scene: '图书馆窗边的自然自拍',
    activity: '在图书馆看小说',
    activityKind: 'study',
    activityStartedAt: '2026-08-22T03:00:00.000Z',
    location: '市图书馆',
    now: '2026-08-22T04:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    ...extra
  });
}

function commit(service: ImageContinuityService, decision: PreparedImageContinuity, outfit: string, mediaId = 'media_1') {
  return service.commit(decision, {
    outfit,
    scene: '图书馆窗边的自然自拍',
    mediaId
  });
}

describe('ImageContinuityService', () => {
  it('establishes one outfit and locks it across ordinary same-day activity/location changes', () => {
    const settings = new MemorySettings();
    const service = serviceAt(settings);
    const first = ordinary(service);
    expect(first).toMatchObject({
      dateKey: '2026-08-22',
      outfitMode: 'new_day',
      outfitRevision: 1,
      previousOutfit: null
    });

    const baseline = '黑色轻便休闲外套、浅色内搭、深色直筒长裤和白色休闲鞋';
    commit(service, first, baseline);
    const next = ordinary(service, {
      scene: '咖啡店靠窗座位的第二张自拍',
      activity: '在咖啡店喝咖啡',
      activityKind: 'out',
      location: '街角咖啡店',
      now: '2026-08-22T07:00:00.000Z'
    });

    expect(next).toMatchObject({
      outfitMode: 'locked',
      outfitRevision: 1,
      previousOutfit: baseline,
      currentActivity: '在咖啡店喝咖啡',
      currentLocation: '街角咖啡店'
    });
    expect(service.resolveOutfit('蓝色连衣裙和高跟鞋', next)).toBe(baseline);
  });

  it('does not mistake clothing questions, discrepancy reports, or compliments for a change request', () => {
    const settings = new MemorySettings();
    const service = serviceAt(settings);
    commit(service, ordinary(service), '黑色外套、白色上衣、深色长裤和白色鞋');

    for (const userText of [
      '你穿的是什么？',
      '怎么两张照片衣服不一样？',
      '你是不是换衣服了？',
      '你把外套脱掉了吗？',
      '黑色外套挺好看'
    ]) {
      expect(ordinary(service, { userText }).outfitMode).toBe('locked');
    }
    const requested = ordinary(service, { userText: '换一套浅色连衣裙吧' });
    expect(requested).toMatchObject({
      outfitMode: 'full_change',
      changeReason: 'user_request',
      explicitOutfitRequest: '换一套浅色连衣裙吧'
    });
    expect(service.resolveOutfit(null, requested)).toContain('浅色连衣裙');
  });

  it('allows only an outer-layer adjustment for explicit coat changes', () => {
    const settings = new MemorySettings();
    const service = serviceAt(settings);
    commit(service, ordinary(service), '黑色外套、白色上衣、深色长裤和白色鞋');
    const decision = ordinary(service, { userText: '进屋后把外套脱掉，其他都别动' });
    expect(decision).toMatchObject({
      outfitMode: 'layer_adjustment',
      changeReason: 'user_layer_request'
    });
    expect(ordinary(service, { userText: '天气冷，穿件外套' }).outfitMode).toBe('layer_adjustment');
    expect(ordinary(service, { userText: '换件红色外套吧' })).toMatchObject({
      outfitMode: 'full_change',
      changeReason: 'user_request'
    });
  });

  it('does not let a creative scene override an authoritative ordinary Life activity', () => {
    const settings = new MemorySettings();
    const service = serviceAt(settings);
    commit(service, ordinary(service), '黑色外套、白色上衣、深色长裤和白色鞋');

    const decision = ordinary(service, {
      scene: '模型擅自写成健身房跑步自拍',
      activity: '在图书馆看小说',
      activityKind: 'study',
      location: '市图书馆'
    });
    expect(decision.outfitMode).toBe('locked');
    expect(decision.currentActivity).toBe('在图书馆看小说');

    const incomplete = service.prepare({
      scene: '模型擅自写成健身房跑步自拍',
      activity: null,
      activityKind: null,
      location: null,
      now: '2026-08-22T08:00:00.000Z',
      timeZone: 'Asia/Shanghai'
    });
    expect(incomplete).toMatchObject({
      outfitMode: 'locked',
      currentActivity: '在图书馆看小说',
      currentLocation: '市图书馆'
    });
  });

  it('allows reasonable full changes into and out of special activities', () => {
    const settings = new MemorySettings();
    const service = serviceAt(settings);
    commit(service, ordinary(service), '黑色外套、白色上衣、深色长裤和白色鞋');

    const exercise = ordinary(service, {
      scene: '健身房镜前的运动自拍',
      activity: '在健身房跑步',
      activityKind: 'exercise',
      location: '社区健身房'
    });
    expect(exercise).toMatchObject({ outfitMode: 'full_change', changeReason: 'exercise' });
    commit(service, exercise, '透气运动上衣、黑色运动长裤和白色运动鞋', 'media_2');

    const sameWorkout = ordinary(service, {
      scene: '跑步机旁换角度的自拍',
      activity: '在健身房跑步',
      activityKind: 'exercise',
      location: '社区健身房'
    });
    expect(sameWorkout.outfitMode).toBe('locked');

    const backToOrdinary = ordinary(service, {
      scene: '回家后客厅里的自拍',
      activity: '在客厅看书',
      activityKind: 'home',
      location: '家里'
    });
    expect(backToOrdinary).toMatchObject({
      outfitMode: 'full_change',
      changeReason: 'exercise_ended'
    });
  });

  it('honors an explicit keep request even when the scene would normally permit a change', () => {
    const settings = new MemorySettings();
    const service = serviceAt(settings);
    commit(service, ordinary(service), '黑色外套、白色上衣、深色长裤和白色鞋');
    const decision = ordinary(service, {
      userText: '还是同一套衣服，不要换',
      scene: '健身房里的自拍',
      activity: '在健身房锻炼',
      activityKind: 'exercise'
    });
    expect(decision).toMatchObject({ outfitMode: 'locked', changeReason: 'user_keep_request' });
  });

  it('starts a new baseline on the next local calendar day and persists across service instances', () => {
    const settings = new MemorySettings();
    const firstService = serviceAt(settings);
    const first = ordinary(firstService);
    commit(firstService, first, '黑色外套、白色上衣、深色长裤和白色鞋');

    const restarted = serviceAt(settings, '2026-08-23T04:00:00.000Z');
    expect(restarted.current()?.outfit.fullDescription).toContain('黑色外套');
    const nextDay = restarted.prepare({
      scene: '第二天早晨的自拍',
      activity: '吃早餐',
      activityKind: 'meal',
      location: '家里餐桌',
      now: '2026-08-23T04:00:00.000Z',
      timeZone: 'Asia/Shanghai'
    });
    expect(nextDay).toMatchObject({
      dateKey: '2026-08-23',
      outfitMode: 'new_day',
      previousOutfit: null,
      outfitRevision: 1
    });
  });

  it('does not mutate persisted state until commit succeeds', () => {
    const settings = new MemorySettings();
    const service = serviceAt(settings);
    const prepared = ordinary(service);
    expect(service.current()).toBeNull();
    expect(settings.values.has(DAILY_IMAGE_CONTINUITY_KEY)).toBe(false);

    // A failed provider/save path simply never calls commit.
    service.resolveOutfit(null, prepared);
    expect(service.current()).toBeNull();
    expect(settings.values.has(DAILY_IMAGE_CONTINUITY_KEY)).toBe(false);
  });

  it('appends authoritative activity, location, and exact outfit as the final prompt layer', () => {
    const settings = new MemorySettings();
    const service = serviceAt(settings);
    const first = ordinary(service);
    const outfit = service.resolveOutfit(null, first);
    const prompt = service.applyToPrompt('Earlier artistic prompt.', first, outfit);

    expect(prompt).toContain('DAILY VISUAL CONTINUITY — HARD CONSTRAINTS');
    expect(prompt).toContain('Real current activity: 在图书馆看小说');
    expect(prompt).toContain('Real current location: 市图书馆');
    expect(prompt).toContain(`SOOYA's complete outfit: ${outfit}`);
    expect(prompt.endsWith('A new angle, composition, or ordinary location change must not create a different activity or outfit.')).toBe(true);
  });

  it('serializes concurrent selfie work so the second task observes the first commit', async () => {
    const settings = new MemorySettings();
    const service = serviceAt(settings);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = service.runExclusive(async () => {
      order.push('first:start');
      await gate;
      commit(service, ordinary(service), '黑色外套、白色上衣、深色长裤和白色鞋');
      order.push('first:end');
    });
    const second = service.runExclusive(async () => {
      order.push('second:start');
      const decision = ordinary(service);
      expect(decision.outfitMode).toBe('locked');
      order.push('second:end');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });
});
