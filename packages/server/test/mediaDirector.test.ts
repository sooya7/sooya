import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider } from '../src/providers/types.js';
import { ConfigStore } from '../src/config/store.js';
import {
  MediaDirector,
  fallbackImagePrompt,
  parseJsonLoose,
  sanitizeFishText
} from '../src/core/mediaDirector.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeChatProvider(reply: string): ChatProvider {
  return {
    name: 'fake',
    configured: true,
    async complete() {
      return { text: reply, usage: undefined };
    },
    async stream(_req, _onChunk) {
      return { text: reply, usage: undefined };
    },
    async inspectHealth() {
      return { capability: 'chat', configured: true, ok: true, provider: 'fake', checkedAt: new Date().toISOString() };
    }
  };
}

function makeDirector(reply: string): MediaDirector {
  const dir = mkdtempSync(join(tmpdir(), 'director-'));
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ storageVersion: 2 }));
  const store = new ConfigStore({ configDir: dir, env: {} });
  let provider = fakeChatProvider(reply);
  const director = new MediaDirector({
    config: store,
    chatProvider: () => provider
  });
  // Let tests swap the reply mid-flight.
  const setReply = (next: string) => { provider = fakeChatProvider(next); };
  return Object.assign(director, { setReply }) as MediaDirector & { setReply: (s: string) => void };
}

describe('MediaDirector voice', () => {
  it('parses the director JSON into {text, speed} and strips any stray cue', async () => {
    // The director must never emit Fish cues (single-producer rule); a model
    // that drifts anyway gets its cue removed wholesale.
    const director = makeDirector(JSON.stringify({ text: '[slightly shy] 嗯……我刚刚有点想你。', speed: 0.97 }));
    const result = await director.voice({ content: '我刚刚突然想到你了', emotion: 'shy_warm', intensity: 0.3 });
    expect(result.text).toBe('嗯……我刚刚有点想你。');
    expect(result.speed).toBe(0.97);
  });

  it('strips cue that is not on the whitelist (no cue > wrong cue)', async () => {
    const director = makeDirector(JSON.stringify({ text: '[dramatic movie voice] 我来了', speed: 1 }));
    const result = await director.voice({ content: '我来了' });
    expect(result.text).toBe('我来了');
    expect(result.speed).toBe(1);
  });

  it('falls back to the raw content when the model returns prose instead of JSON', async () => {
    const director = makeDirector('好的，我帮你整理一下：这里的重点是……');
    const result = await director.voice({ content: '我刚刚突然想到你了' });
    expect(result.text).toBe('我刚刚突然想到你了');
    expect(result.speed).toBe(1);
  });

  it('clamps the director speed to 0.94–1.05', async () => {
    const director = makeDirector(JSON.stringify({ text: '快一点', speed: 2.5 }));
    expect((await director.voice({ content: '快一点' })).speed).toBe(1.05);
    const slow = makeDirector(JSON.stringify({ text: '慢一点', speed: 0.5 }));
    expect((await slow.voice({ content: '慢一点' })).speed).toBe(0.94);
  });

  it('falls back when the chat provider is unconfigured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'director-'));
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ storageVersion: 2 }));
    const store = new ConfigStore({ configDir: dir, env: {} });
    const director = new MediaDirector({
      config: store,
      chatProvider: () => ({ ...fakeChatProvider(''), configured: false } as ChatProvider)
    });
    const result = await director.voice({ content: '你好' });
    expect(result.text).toBe('你好');
    expect(result.speed).toBe(1);
  });
});

describe('MediaDirector image', () => {
  it('expands an intent into a prompt and keeps the identity reference line', async () => {
    const reply = JSON.stringify({
      prompt: 'Use the provided reference image as the identity reference for Sooya. Preserve the same person and facial identity without redesigning her appearance. A quiet late-night bedroom moment.',
      aspectRatio: '4:5'
    });
    const director = makeDirector(reply);
    const result = await director.image({ scene: 'late night bedroom', action: 'lying in bed', mood: 'sleepy', intent: 'private snapshot' });
    expect(result.prompt).toContain('identity reference for Sooya');
    expect(result.prompt).toContain('bedroom');
    expect(result.aspectRatio).toBe('4:5');
  });

  it('falls back to the intent-built prompt when the model fails', async () => {
    const director = makeDirector('抱歉，我无法生成图片描述。');
    const result = await director.image({ scene: 'coffee shop', action: 'drinking coffee', mood: 'calm' });
    expect(result.prompt).toContain('identity reference for Sooya');
    expect(result.prompt).toContain('coffee shop');
    expect(result.prompt).toContain('drinking coffee');
  });

  it('falls back when the chat provider errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'director-'));
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ storageVersion: 2 }));
    const store = new ConfigStore({ configDir: dir, env: {} });
    const failing: ChatProvider = {
      name: 'fake', configured: true,
      async complete() { throw new Error('provider down'); },
      async stream() { throw new Error('provider down'); },
      async inspectHealth() { return { capability: 'chat', configured: true, ok: true, provider: 'fake', checkedAt: new Date().toISOString() }; }
    };
    const director = new MediaDirector({ config: store, chatProvider: () => failing });
    const result = await director.image({ scene: 'park bench', action: 'reading' });
    expect(result.prompt).toContain('identity reference for Sooya');
    expect(result.prompt).toContain('park bench');
  });
});

describe('helpers', () => {
  it('sanitizeFishText strips ANY leading bracket cue — cues come from FishCueRenderer only', () => {
    expect(sanitizeFishText('[speaking softly] 我在呢')).toBe('我在呢');
    expect(sanitizeFishText('[gently reassuring] 别担心')).toBe('别担心');
    expect(sanitizeFishText('[screaming] 救命')).toBe('救命');
    expect(sanitizeFishText('普通陈述没有 cue')).toBe('普通陈述没有 cue');
  });

  it('parseJsonLoose extracts JSON wrapped in prose', () => {
    expect(parseJsonLoose<{ a: number }>('好的，结果是 {"a": 1} 就这样')).toEqual({ a: 1 });
    expect(parseJsonLoose('no json here')).toBeNull();
    expect(parseJsonLoose('{"broken": ')).toBeNull();
  });

  it('fallbackImagePrompt always carries the identity line and intent fields', () => {
    const prompt = fallbackImagePrompt({ scene: '卧室', action: '躺着', mood: '困' });
    expect(prompt).toContain('identity reference for Sooya');
    expect(prompt).toContain('卧室');
    expect(prompt).toContain('躺着');
    expect(prompt).toContain('natural smartphone photography');
  });
});
