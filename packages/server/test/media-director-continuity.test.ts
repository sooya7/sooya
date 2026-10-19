import { describe, expect, it } from 'vitest';
import { MediaDirector } from '../src/core/mediaDirector.js';
import { visualDayPeriodLighting, type VisualTimeContext } from '../src/core/visual-time.js';

const visualTime: VisualTimeContext = {
  timeZone: 'Asia/Shanghai',
  currentInstant: '2026-08-22T04:00:00.000Z',
  currentLocalDate: '2026-08-22',
  currentLocalTime: '12:00:00',
  currentDayPeriod: 'midday',
  mode: 'current',
  depictedLocalDate: '2026-08-22',
  depictedDayPeriod: 'midday',
  requestedDayPeriod: null
};

describe('image continuity constraints', () => {
  it('carries the reality facts and keeps a locked outfit for a picture of her', () => {
    const outfit = '黑色轻便休闲外套、浅色内搭、深色长裤和白色休闲鞋';
    const result = new MediaDirector().image({ scene: '图书馆窗边自拍', intent: 'selfie', self: true }, {
      continuity: {
        dateKey: '2026-08-22',
        currentActivity: '在图书馆看小说',
        currentLocation: '市图书馆',
        previousOutfit: outfit,
        outfitMode: 'locked',
        changeReason: null,
        visualTime
      }
    });

    expect(result.outfit).toBe(outfit);
    expect(result.prompt).toContain('图书馆窗边自拍');
    expect(result.prompt).toContain('Real current activity: 在图书馆看小说');
    expect(result.prompt).toContain('Real current location: 市图书馆');
    expect(result.prompt).toContain(`Same-day outfit: ${outfit}`);
    expect(result.prompt).toContain('Keep every garment, color, material, and layer exactly unchanged');
    expect(result.prompt).toContain('Real current local time: 2026-08-22 12:00:00');
    expect(result.prompt).toContain(visualDayPeriodLighting('midday'));
  });

  it('leaves the outfit out of a plain scene picture', () => {
    const result = new MediaDirector().image({ scene: '图书馆窗边', action: '喝咖啡' }, {
      continuity: {
        currentActivity: '喝咖啡',
        currentLocation: '街角咖啡店',
        previousOutfit: '黑色外套、白色上衣、深色长裤和白色休闲鞋',
        outfitMode: 'locked',
        visualTime
      }
    });

    expect(result.outfit).toBeUndefined();
    expect(result.prompt).not.toContain('Same-day outfit');
    expect(result.prompt).toContain('Action: 喝咖啡.');
    expect(result.prompt).toContain('Real current activity: 喝咖啡');
  });
});
