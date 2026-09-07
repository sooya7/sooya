import { describe, expect, it } from 'vitest';
import type { ChatProvider } from '../src/providers/types.js';
import { DirectorClient } from '../src/core/director/client.js';
import { fallbackVideoPrompt, MediaDirector } from '../src/core/mediaDirector.js';

function fakeChatProvider(reply: string, calls: string[] = []): ChatProvider {
  return {
    name: 'fake',
    configured: true,
    async complete(req) {
      calls.push(JSON.stringify(req));
      return { text: reply, model: 'fake' };
    },
    async stream() {
      return { text: reply, model: 'fake' };
    },
    async inspectHealth() {
      return { capability: 'chat', configured: true, ok: true, provider: 'fake', checkedAt: new Date().toISOString() };
    }
  };
}

describe('MediaDirector video', () => {
  it('expands a clip intent into a prompt and duration through the director model', async () => {
    const calls: string[] = [];
    const director = new MediaDirector(new DirectorClient(() => fakeChatProvider(JSON.stringify({
      prompt: 'Handheld smartphone clip: waves slowly rolling onto a quiet beach at golden hour, gentle camera drift, soft warm light.',
      durationSec: 6
    }), calls)));
    const result = await director.video({ scene: '海边日落，海浪涌上沙滩', intent: 'a short private clip' });
    expect(result.prompt).toContain('waves slowly rolling');
    expect(result.durationSec).toBe(6);
    // The director sees the intent as data and its own video instructions, never the persona prompt.
    expect(calls[0]).toContain('短视频提示词整理器');
    expect(calls[0]).toContain('海边日落');
  });

  it('falls back to a plain composition when the director returns prose', async () => {
    const director = new MediaDirector(new DirectorClient(() => fakeChatProvider('这个我不太会写……')));
    const result = await director.video({ scene: '猫在追激光点', self: false });
    expect(result.prompt).toContain('猫在追激光点');
    expect(result.prompt).toContain('single continuous shot');
    // The fallback still names a clip length, taken from the spec's lower bound.
    expect(result.durationSec).toBe(4);
  });

  it('pins identity to the first frame for a self clip in the fallback', () => {
    const prompt = fallbackVideoPrompt({ scene: '我在窗边挥手', self: true });
    expect(prompt).toMatch(/first frame/);
    expect(prompt).toMatch(/same person/);
    expect(fallbackVideoPrompt({ scene: '街景' })).not.toMatch(/first frame/);
  });
});
