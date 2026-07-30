import { describe, expect, it } from 'vitest';
import { parseEmotionArg, stripModelDirectives } from '../src/core/directives.js';

describe('voice emotion directive', () => {
  it('reads the mood off a voice marker and keeps it out of the visible text', () => {
    const r = stripModelDirectives('[[voice:emotion=happy]]今天好开心呀');
    expect(r.directives.voice).toBe(true);
    expect(r.directives.voiceEmotion).toBe('happy');
    expect(r.text).toBe('今天好开心呀');
  });

  it('works on voice-only too, which is the mode she uses most', () => {
    const r = stripModelDirectives('[[voice-only:emotion=SAD]]我有点难过');
    expect(r.directives.voice).toBe(true);
    expect(r.directives.voiceOnly).toBe(true);
    expect(r.directives.voiceEmotion).toBe('sad');
  });

  it('leaves the mood unset when she does not ask for one', () => {
    expect(stripModelDirectives('[[voice]]随便说点什么').directives.voiceEmotion).toBeUndefined();
    expect(stripModelDirectives('就只是文字').directives.voiceEmotion).toBeUndefined();
  });

  it('bounds the word so a whole sentence cannot ride into a provider request', () => {
    expect(parseEmotionArg('emotion=happy')).toBe('happy');
    expect(parseEmotionArg('  emotion = Gentle ')).toBe('gentle');
    expect(parseEmotionArg('emotion=开心')).toBeNull();
    expect(parseEmotionArg('emotion=' + 'a'.repeat(40))).toBeNull();
    expect(parseEmotionArg('')).toBeNull();
    expect(parseEmotionArg(null)).toBeNull();
  });
});
