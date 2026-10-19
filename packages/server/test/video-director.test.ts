import { describe, expect, it } from 'vitest';
import { MediaPromptSpecSchema } from '../src/config/media-spec.js';
import { composeVideoPrompt, MediaDirector } from '../src/core/mediaDirector.js';

describe('media clip composition', () => {
  it('composes the clip prompt from the intent and the spec, with no model call', () => {
    const result = new MediaDirector().video({ scene: '海边日落，海浪涌上沙滩', intent: 'a short private clip' });
    expect(result.prompt).toContain('海边日落，海浪涌上沙滩');
    expect(result.prompt).toContain('single continuous shot');
    expect(result.durationSec).toBe(4);
  });

  it('uses the operator\u2019s camera vocabulary when it is configured', () => {
    const spec = MediaPromptSpecSchema.parse({ video: { camera: ['slow push in'] } });
    const director = new MediaDirector(() => spec);
    expect(director.video({ scene: '海浪' }).prompt).toContain('slow push in');
  });

  it('pins identity to the first frame only for a clip of her', () => {
    expect(composeVideoPrompt({ scene: '我在窗边挥手', self: true })).toMatch(/first frame/);
    expect(composeVideoPrompt({ scene: '我在窗边挥手', self: true })).toMatch(/same person/);
    expect(composeVideoPrompt({ scene: '街景' })).not.toMatch(/first frame/);
  });

  it('carries the continuity facts it is given', () => {
    const prompt = composeVideoPrompt({ scene: '海浪' }, undefined, {
      dateKey: '2026-10-19',
      outfit: null,
      activity: '在阳台吹风',
      location: '家',
      lighting: 'soft warm morning sunlight',
      depictedDayPeriod: 'morning',
      timeMode: 'current'
    });
    expect(prompt).toContain('Real current activity: 在阳台吹风');
    expect(prompt).toContain('Required lighting: soft warm morning sunlight');
  });
});
