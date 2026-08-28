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

describe('flattened pseudo tool calls', () => {
  const prompt = 'A young East Asian woman with long dark hair, wearing a loose cream/beige oversized sweater, lying comfortably on a beige sofa at night';

  it('turns the leaked image_generation_tool selfie call into the existing self-image directive', () => {
    const raw = `对不起对不起 忘了这就补！ <tool_call>
<function=image_generation_tool>
<parameter=prompt>${prompt}</parameter>
<parameter=aspect_ratio>3:4</parameter>
<parameter=system_prompt>You are generating a casual selfie/at-home photo of a young woman. Keep it natural and real.</parameter>
</function>
</tool_call>`;
    const { text, directives } = stripModelDirectives(raw);
    expect(text).toBe('对不起对不起 忘了这就补！');
    expect(directives.selfImagePrompt).toBe(prompt);
    expect(directives.imagePrompt).toBeUndefined();
  });

  it('maps a generic image tool call to a normal image directive', () => {
    const raw = `<tool_call><function=image_generation_tool><parameter=prompt>雨夜的东京街口</parameter></function></tool_call>`;
    const { text, directives } = stripModelDirectives(raw);
    expect(text).toBe('');
    expect(directives.imagePrompt).toBe('雨夜的东京街口');
    expect(directives.selfImagePrompt).toBeUndefined();
  });

  it('strips unknown pseudo tools without executing them', () => {
    const { text, directives } = stripModelDirectives('前面<tool_call><function=shell_exec><parameter=prompt>rm -rf /</parameter></function></tool_call>后面');
    expect(text).toBe('前面后面');
    expect(directives).toEqual({});
  });

  it('drops an incomplete pseudo tool call instead of exposing or executing it', () => {
    const { text, directives } = stripModelDirectives('先等等<tool_call><function=image_generation_tool><parameter=prompt>未完成');
    expect(text).toBe('先等等');
    expect(directives).toEqual({});
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

  it('never flashes a pseudo tool call even when every tag is split across chunks', () => {
    expect(stream([
      '这就补！ <too',
      'l_call><function=image_generation_tool><parameter=prompt>沙发自拍',
      '</parameter><parameter=system_prompt>casual selfie</parameter></function></tool_',
      'call>好了'
    ])).toBe('这就补！ 好了');
  });

  it('drops an unterminated pseudo tool call at end of stream', () => {
    expect(stream(['前面<tool_', 'call><function=image_generation_tool><parameter=prompt>还没写完'])).toBe('前面');
  });
});
