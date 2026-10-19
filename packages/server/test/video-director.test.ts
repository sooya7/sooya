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

  it('composes a clip from the scene alone', () => {
    const prompt = composeVideoPrompt({ scene: '街景' });
    expect(prompt).toContain('街景');
    expect(prompt).not.toMatch(/first frame|same person|Real current|outfit/);
  });
});
