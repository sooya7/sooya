import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SettingsRepo } from '../src/db/repos/misc.repo.js';
import { migrate } from '../src/db/index.js';
import { DbHandle } from '../src/db/handle.js';
import { ImageContinuityService, DAILY_IMAGE_CONTINUITY_KEY } from '../src/core/image-continuity.js';
import { applyVideoContinuity, prepareVideoContinuity, videoContinuityMetadata } from '../src/core/video/continuity.js';
import { resolveVisualTime } from '../src/core/visual-time.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function settings(): SettingsRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sooya-video-continuity-'));
  dirs.push(dir);
  const db = new Database(path.join(dir, 'test.db'));
  migrate(db);
  return new SettingsRepo(new DbHandle(db));
}

const AFTERNOON = new Date('2026-09-08T06:30:00.000Z'); // 14:30 Asia/Shanghai
const LATE_NIGHT = new Date('2026-09-08T17:30:00.000Z'); // 01:30 next day

function service(repo: SettingsRepo, now: Date) {
  return new ImageContinuityService(repo, { clock: () => now, timeZone: 'Asia/Shanghai' });
}

function storeOutfit(repo: SettingsRepo, dateKey: string, outfit: string) {
  repo.set(DAILY_IMAGE_CONTINUITY_KEY, {
    version: 1,
    dateKey,
    outfit: { fullDescription: outfit },
    outfitRevision: 1,
    activity: '在家看书',
    activityKind: 'home',
    activityStartedAt: null,
    location: '家',
    scene: '客厅沙发上的自拍',
    changeReason: null,
    sourceMediaId: 'media_prev',
    updatedAt: new Date().toISOString()
  });
}

describe('video continuity', () => {
  it('locks a clip to the outfit an earlier photo already established, without committing anything', () => {
    const repo = settings();
    const svc = service(repo, AFTERNOON);
    const dateKey = resolveVisualTime({ now: AFTERNOON, timeZone: 'Asia/Shanghai' }).currentLocalDate;
    storeOutfit(repo, dateKey, '米色针织开衫、白色内搭和浅蓝直筒牛仔裤');
    const before = repo.get<unknown>(DAILY_IMAGE_CONTINUITY_KEY, null);

    const continuity = prepareVideoContinuity(svc, { scene: '我在沙发上对你挥手', activity: '在家看书', location: '家' });
    expect(continuity.outfit).toBe('米色针织开衫、白色内搭和浅蓝直筒牛仔裤');
    expect(continuity.activity).toBe('在家看书');
    expect(continuity.location).toBe('家');

    const prompt = applyVideoContinuity('A short clip of her waving.', continuity, true);
    expect(prompt).toContain('米色针织开衫');
    expect(prompt).toContain('Keep every garment type, color, material and layer unchanged');
    expect(prompt).toContain('Real current activity: 在家看书');
    expect(prompt).toContain('Required lighting:');

    // Read-only: a clip must never redefine the day's outfit baseline.
    expect(repo.get<unknown>(DAILY_IMAGE_CONTINUITY_KEY, null)).toEqual(before);
  });

  it('omits outfit constraints for a clip she is not in, but still pins the time of day', () => {
    const repo = settings();
    const svc = service(repo, LATE_NIGHT);
    const dateKey = resolveVisualTime({ now: LATE_NIGHT, timeZone: 'Asia/Shanghai' }).currentLocalDate;
    storeOutfit(repo, dateKey, '深灰卫衣和黑色运动长裤');

    const continuity = prepareVideoContinuity(svc, { scene: '窗外的车流', location: '家' });
    const prompt = applyVideoContinuity('A short clip of traffic outside the window.', continuity, false);
    expect(prompt).not.toContain('深灰卫衣');
    expect(prompt).not.toContain("SOOYA's complete outfit");
    expect(prompt).toContain('Required lighting:');
    expect(continuity.visualTime.depictedDayPeriod).toBe('late-night');
  });

  it('does not pin an outfit when the day has none yet, or when the user asked her to change', () => {
    const repo = settings();
    const fresh = prepareVideoContinuity(service(repo, AFTERNOON), { scene: '我在窗边' });
    expect(fresh.outfit).toBeNull();

    const dateKey = resolveVisualTime({ now: AFTERNOON, timeZone: 'Asia/Shanghai' }).currentLocalDate;
    storeOutfit(repo, dateKey, '米色针织开衫、白色内搭和浅蓝直筒牛仔裤');
    const changed = prepareVideoContinuity(service(repo, AFTERNOON), { scene: '我在窗边', userText: '换一套裙子给我看看' });
    expect(changed.outfit).toBeNull();
  });

  it('drops current activity and location for a past scene', () => {
    const repo = settings();
    const continuity = prepareVideoContinuity(service(repo, LATE_NIGHT), {
      scene: '今天下午在咖啡店',
      userText: '拍一段今天下午的视频',
      activity: '在家看书',
      location: '家'
    });
    expect(continuity.visualTime.mode).toBe('retrospective');
    expect(continuity.activity).toBeNull();
    expect(continuity.location).toBeNull();
    expect(videoContinuityMetadata(continuity, true)).toMatchObject({ timeMode: 'retrospective' });
  });
});
