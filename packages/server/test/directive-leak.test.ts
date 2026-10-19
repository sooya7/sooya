import { describe, it, expect } from 'vitest';
import { stripModelDirectives, StreamingDirectiveFilter } from '../src/core/directives.js';

/**
 * The system prompt teaches the [[marker]] form, but models routinely emit the
 * single-bracket variant (and attribute syntax such as [voice:emotion=gentle]).
 * Those used to reach the user as literal text.
 */
describe('single-bracket directive markers', () => {
  it('reads a sticker name from the single-bracket form', () => {
    const { text, directives } = stripModelDirectives('哈哈哈[sticker:开心]');
    expect(text).toBe('哈哈哈');
    expect(directives.sticker).toBe('开心');
  });

  it('strips Chinese sticker aliases emitted by the model', () => {
    const sticker = stripModelDirectives('\u5148\u966a\u4f60\u804a\u804a[\u8868\u60c5\u5305:\u59d4\u5c48\u5df4\u5df4]');
    expect(sticker.text).toBe('\u5148\u966a\u4f60\u804a\u804a');
    expect(sticker.directives.sticker).toBe('\u59d4\u5c48\u5df4\u5df4');
  });
});

/**
 * Pictures, clips and voice go through the media tools. A media marker the
 * model still writes out of habit, in any bracket count, alias or attribute
 * form, is stripped from the visible text and does nothing.
 */
describe('retired media markers', () => {
  it.each([
    ['晚安啦[voice]', '晚安啦'],
    ['我在呢[voice:emotion=gentle]', '我在呢'],
    ['[voice-only]听我说', '听我说'],
    ['好的[[voice]', '好的'],
    ['[[voice:emotion=shy_warm|intensity=0.3]]', ''],
    ['看这个[image:窗台上睡着的猫]', '看这个'],
    ['[[image:咖啡店窗边下雨]]', ''],
    ['[\u56fe\u7247:\u4e00\u53ea\u5728\u7a97\u8fb9\u7761\u89c9\u7684\u67ef\u57fa]', ''],
    ['稍等[[video:海边日落]]', '稍等'],
    ['稍等[视频:猫在追激光点]', '稍等'],
    ['晚安[语音]', '晚安'],
    ['给你看看[[image-self:晚上窝在卧室床上看手机]]', '给你看看'],
    ['[[video-self:我在窗边对你挥手]]', '']
  ])('strips %s and asks for nothing', (raw, visible) => {
    const { text, directives } = stripModelDirectives(raw);
    expect(text).toBe(visible);
    expect(directives).toEqual({});
  });
});

describe('marker edge cases', () => {
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

  it('drops a leaked image_generation_tool call', () => {
    const raw = `对不起对不起 忘了这就补！ <tool_call>
<function=image_generation_tool>
<parameter=prompt>${prompt}</parameter>
<parameter=aspect_ratio>3:4</parameter>
<parameter=system_prompt>You are generating a casual selfie/at-home photo of a young woman. Keep it natural and real.</parameter>
</function>
</tool_call>`;
    const { text, directives } = stripModelDirectives(raw);
    expect(text).toBe('对不起对不起 忘了这就补！');
    expect(directives.imagePrompt).toBeUndefined();
  });

  it('drops a generic leaked image tool call too', () => {
    const raw = `<tool_call><function=image_generation_tool><parameter=prompt>雨夜的东京街口</parameter></function></tool_call>`;
    const { text, directives } = stripModelDirectives(raw);
    expect(text).toBe('');
    expect(directives.imagePrompt).toBeUndefined();
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
