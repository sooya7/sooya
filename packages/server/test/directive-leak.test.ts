import { describe, it, expect } from 'vitest';
import { stripModelDirectives, StreamingDirectiveFilter } from '../src/core/directives.js';

/**
 * The system prompt teaches the [[marker]] form, but models routinely emit the
 * single-bracket variant (and attribute syntax such as [voice:emotion=gentle]).
 * Those used to reach the user as literal text.
 */
describe('single-bracket directive markers', () => {
  it('strips [voice] and requests voice', () => {
    const { text, directives } = stripModelDirectives('晚安啦[voice]');
    expect(text).toBe('晚安啦');
    expect(directives.voice).toBe(true);
  });

  it('strips [voice:emotion=gentle] and ignores the unknown attribute', () => {
    const { text, directives } = stripModelDirectives('我在呢[voice:emotion=gentle]');
    expect(text).toBe('我在呢');
    expect(directives.voice).toBe(true);
  });

  it('strips [voice-only] and marks the reply voice-only', () => {
    const { text, directives } = stripModelDirectives('[voice-only]听我说');
    expect(text).toBe('听我说');
    expect(directives.voice).toBe(true);
    expect(directives.voiceOnly).toBe(true);
  });

  it('reads a sticker name from the single-bracket form', () => {
    const { text, directives } = stripModelDirectives('哈哈哈[sticker:开心]');
    expect(text).toBe('哈哈哈');
    expect(directives.sticker).toBe('开心');
  });

  it('reads an image prompt from the single-bracket form', () => {
    const { text, directives } = stripModelDirectives('看这个[image:窗台上睡着的猫]');
    expect(text).toBe('看这个');
    expect(directives.imagePrompt).toBe('窗台上睡着的猫');
  });

  it('still handles a mismatched bracket count', () => {
    const { text, directives } = stripModelDirectives('好的[[voice]');
    expect(text).toBe('好的');
    expect(directives.voice).toBe(true);
  });

  it('leaves ordinary bracketed text alone', () => {
    for (const raw of ['[笑]', '看注释[1]', '[备注: 明天再说]', '数组是 [a, b]']) {
      expect(stripModelDirectives(raw).text).toBe(raw);
    }
  });

  it('leaves a word that merely starts like a marker alone', () => {
    expect(stripModelDirectives('[imagine]').text).toBe('[imagine]');
  });
});

describe('StreamingDirectiveFilter with single brackets', () => {
  function stream(chunks: string[]): string {
    const f = new StreamingDirectiveFilter();
    return chunks.map((c) => f.push(c)).join('') + f.flush();
  }

  it('never emits a single-bracket marker, however it is chunked', () => {
    expect(stream(['晚安', '[voi', 'ce]'])).toBe('晚安');
    expect(stream(['晚安[', 'voice:emotion=gen', 'tle]再见'])).toBe('晚安再见');
    expect(stream(['[voice]'])).toBe('');
  });

  it('still passes ordinary bracketed text through', () => {
    expect(stream(['哈哈', '[笑', ']', '啦'])).toBe('哈哈[笑]啦');
  });

  it('does not buffer plain text forever when no closing bracket arrives', () => {
    const long = '这是一段很长的说明文字，里面有个方括号但一直没有关闭，不应该被吞掉，也不应该无限等待下去。';
    expect(stream(['[', long])).toBe(`[${long}`);
  });

  it('drops an unterminated marker at the end of a stream', () => {
    expect(stream(['好的', '[voic'])).toBe('好的');
    expect(stream(['好的', '[[stick'])).toBe('好的');
  });

  it('keeps double-bracket behaviour intact', () => {
    expect(stream(['你好', '[[voice]]', '再见'])).toBe('你好再见');
    expect(stream(['你好[[stic', 'ker:开心]]'])).toBe('你好');
  });
});
