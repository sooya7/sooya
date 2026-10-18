import { describe, it, expect } from 'vitest';
import { bubblePauseMs, splitIntoBubbles } from './bubbles.js';

describe('splitIntoBubbles', () => {
  it('gives each chat line its own bubble', () => {
    expect(splitIntoBubbles('醒啦～\n早安呀\n\n昨晚睡得好吗', 5)).toEqual(['醒啦～', '早安呀', '昨晚睡得好吗']);
  });

  it('keeps lists and lead-in lines with the sentence they belong to', () => {
    expect(splitIntoBubbles('可以这样试试：\n先重启\n再看日志\n\n不行再叫我', 5)).toEqual(['可以这样试试：\n先重启\n再看日志', '不行再叫我']);
    expect(splitIntoBubbles('两个办法\n- 重启\n- 换端口', 5)).toEqual(['两个办法\n- 重启\n- 换端口']);
  });

  it('falls back to paragraphs and folds the overflow into the last bubble', () => {
    const text = 'a1\na2\n\nb1\nb2\n\nc1\n\nd1\n\ne1\n\nf1';
    expect(splitIntoBubbles(text, 3)).toEqual(['a1\na2', 'b1\nb2', 'c1\n\nd1\n\ne1\n\nf1']);
  });

  it('never splits code or when only one send is allowed', () => {
    expect(splitIntoBubbles('看这个\n```\nls\n```', 5)).toHaveLength(1);
    expect(splitIntoBubbles('一\n二', 1)).toEqual(['一\n二']);
    expect(splitIntoBubbles('一\n二', 0)).toEqual(['一\n二']);
    expect(splitIntoBubbles('   ', 5)).toEqual([]);
  });

  it('pauses longer for longer bubbles within bounds', () => {
    expect(bubblePauseMs('嗯')).toBe(500);
    expect(bubblePauseMs('这是一句稍微长一点的话呀')).toBeGreaterThan(500);
    expect(bubblePauseMs('长'.repeat(200))).toBe(2200);
  });
});
