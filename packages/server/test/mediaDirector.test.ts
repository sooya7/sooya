import { describe, expect, it } from 'vitest';
import { DEFAULT_MEDIA_PROMPT_SPEC } from '../src/config/media-spec.js';
import { MediaDirector, composeImagePrompt, composeVideoPrompt, sanitizeFishText } from '../src/core/mediaDirector.js';
import { resolveVisualTime } from '../src/core/visual-time.js';

const visualTime = resolveVisualTime({ now: new Date('2026-10-19T01:20:00.000Z'), timeZone: 'Asia/Shanghai' });

describe('media prompt composition', () => {
  it('keeps what she asked for and adds the operator vocabulary', () => {
    const prompt = composeImagePrompt({ scene: '一只橘猫蜷在窗台上睡觉', intent: 'private snapshot' });
    expect(prompt).toContain('一只橘猫蜷在窗台上睡觉');
    expect(prompt).toContain('Intent: private snapshot.');
    expect(prompt).toContain(DEFAULT_MEDIA_PROMPT_SPEC.image.style[0]!);
    expect(prompt).toContain(`Avoid: ${DEFAULT_MEDIA_PROMPT_SPEC.image.avoid[0]!}`);
  });

  it('no longer asks for photographic realism', () => {
    const prompt = composeImagePrompt({ scene: '窗台上的猫' });
    expect(prompt).not.toContain('realistic smartphone photography');
    expect(prompt).not.toContain('candid daily-life moment');
  });

  it('carries the identity wording only for a picture of her', () => {
    expect(composeImagePrompt({ scene: '窗边的猫' })).not.toContain('identity reference');
    expect(composeImagePrompt({ scene: '窗边的她', self: true })).toContain('identity reference');
  });

  it('keeps the reality constraints when they are supplied', () => {
    const prompt = composeImagePrompt({ scene: '在厨房煮面' }, DEFAULT_MEDIA_PROMPT_SPEC, {
      dateKey: '2026-10-19',
      currentActivity: '煮一碗面',
      currentLocation: '家',
      previousOutfit: null,
      outfitMode: 'new_day',
      visualTime
    });
    expect(prompt).toContain('Real current activity: 煮一碗面.');
    expect(prompt).toContain('Required lighting:');
  });

  it('composes clips with the same rules', () => {
    const prompt = composeVideoPrompt({ scene: '海浪涌上沙滩', intent: 'a short private clip for the user' });
    expect(prompt).toContain('海浪涌上沙滩');
    expect(prompt).toContain('single continuous shot');
    expect(prompt).not.toContain('realistic smartphone video');
  });

  it('composes synchronously and never needs a director model', () => {
    const director = new MediaDirector();
    expect(director.image({ scene: '一只猫' }).prompt).toContain('一只猫');
    expect(director.video({ scene: '海浪' }).durationSec).toBe(DEFAULT_MEDIA_PROMPT_SPEC.video.durationSec.min);
  });

  it('strips a leading cue from a spoken script', () => {
    expect(sanitizeFishText('[slightly shy] 嗯……我刚刚有点想你。')).toBe('嗯……我刚刚有点想你。');
    expect(sanitizeFishText('我来了')).toBe('我来了');
  });
});
