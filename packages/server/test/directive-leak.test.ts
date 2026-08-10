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

  it('reads a selfie intent from [[image-self:...]] and leaves the prose clean', () => {
    const { text, directives } = stripModelDirectives('给你看看[[image-self:晚上窝在卧室床上看手机，有点困，穿着宽松的家居服]]');
    expect(text).toBe('给你看看');
    expect(directives.selfImagePrompt).toBe('晚上窝在卧室床上看手机，有点困，穿着宽松的家居服');
    expect(directives.imagePrompt).toBeUndefined();
  });

  it('keeps [[image:...]] as a regular image intent, not a selfie', () => {
    const { directives } = stripModelDirectives('[[image:咖啡店窗边下雨]]');
    expect(directives.imagePrompt).toBe('咖啡店窗边下雨');
    expect(directives.selfImagePrompt).toBeUndefined();
  });

  it('reads emotion and intensity from a voice marker', () => {
    const { directives } = stripModelDirectives('[[voice:emotion=shy_warm|intensity=0.3]]');
    expect(directives.voice).toBe(true);
    expect(directives.voiceEmotion).toBe('shy_warm');
    expect(directives.voiceIntensity).toBe(0.3);
  });

  it('clamps a voice intensity outside 0–1 and ignores malformed values', () => {
    const high = stripModelDirectives('[[voice:emotion=happy|intensity=1.7]]');
    expect(high.directives.voiceIntensity).toBe(1);
    // Negative or malformed intensities are not parsed at all (undefined).
    const negative = stripModelDirectives('[[voice:emotion=happy|intensity=-0.2]]');
    expect(negative.directives.voiceIntensity).toBeUndefined();
    const none = stripModelDirectives('[[voice:emotion=happy]]');
    expect(none.directives.voiceIntensity).toBeUndefined();
  });

  it('strips Chinese aliases emitted by the model', () => {
    const sticker = stripModelDirectives('\u5148\u966a\u4f60\u804a\u804a[\u8868\u60c5\u5305:\u59d4\u5c48\u5df4\u5df4]');
    expect(sticker.text).toBe('\u5148\u966a\u4f60\u804a\u804a');
    expect(sticker.directives.sticker).toBe('\u59d4\u5c48\u5df4\u5df4');

    const image = stripModelDirectives('[\u56fe\u7247:\u4e00\u53ea\u5728\u7a97\u8fb9\u7761\u89c9\u7684\u67ef\u57fa]');
    expect(image.text).toBe('');
    expect(image.directives.imagePrompt).toBe('\u4e00\u53ea\u5728\u7a97\u8fb9\u7761\u89c9\u7684\u67ef\u57fa');
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

  it('never emits a Chinese sticker alias while streaming', () => {
    expect(stream(['\u597d\u7684', '[\u8868\u60c5', '\u5305:\u59d4\u5c48\u5df4\u5df4]', '\u518d\u804a'])).toBe('\u597d\u7684\u518d\u804a');
  });

  it('keeps double-bracket behaviour intact', () => {
    const prompt = 'A young woman sleeping peacefully in bed, hugging a soft white blanket, dim warm nightlight on bedside table, a cute corgi plushie tucked beside her, realistic photography, soft warm tones';
    const imageMarker = `[[image:${prompt}]]`;
    expect(stream([imageMarker.slice(0, 49), imageMarker.slice(49)])).toBe('');

    const hint = 'a warm celebratory reaction with a smiling character and confetti';
    const stickerMarker = `[[sticker:${hint}]]`;
    expect(stream([stickerMarker.slice(0, 49), stickerMarker.slice(49)])).toBe('');
    expect(stream(['你好', '[[voice]]', '再见'])).toBe('你好再见');
    expect(stream(['你好[[stic', 'ker:开心]]'])).toBe('你好');
  });
});
