import { describe, expect, it } from 'vitest';
import { stripSpeakerPrefix } from './speakerPrefix.js';

describe('stripSpeakerPrefix', () => {
  it('去掉人格名前缀', () => {
    expect(stripSpeakerPrefix('SOOYA：今天也想你了。', ['SOOYA'])).toBe('今天也想你了。');
    expect(stripSpeakerPrefix('SOOYA: hello', ['SOOYA'])).toBe('hello');
  });

  it('去掉用户昵称前缀——这是一对一私聊，不该出现名牌', () => {
    expect(stripSpeakerPrefix('小七：你回来啦', ['SOOYA', '小七'])).toBe('你回来啦');
  });

  it('去掉通用称呼，不依赖调用方传名字', () => {
    expect(stripSpeakerPrefix('用户：在吗')).toBe('在吗');
    expect(stripSpeakerPrefix('assistant: sure')).toBe('sure');
    expect(stripSpeakerPrefix('助手： 好的')).toBe('好的');
  });

  it('剥掉方括号名牌，包括没有冒号的写法', () => {
    expect(stripSpeakerPrefix('【SOOYA】：晚安')).toBe('晚安');
    expect(stripSpeakerPrefix('[随便谁] 你好')).toBe('你好');
  });

  it('最多剥两层嵌套名牌', () => {
    expect(stripSpeakerPrefix('【SOOYA】：SOOYA：来了', ['SOOYA'])).toBe('来了');
  });

  it('保留正常的句首冒号用法，不能误伤', () => {
    expect(stripSpeakerPrefix('结论：这样最省钱')).toBe('结论：这样最省钱');
    expect(stripSpeakerPrefix('提醒：记得吃饭')).toBe('提醒：记得吃饭');
    expect(stripSpeakerPrefix('注意: 路上小心')).toBe('注意: 路上小心');
  });

  it('名牌出现在句子中间时不动它', () => {
    expect(stripSpeakerPrefix('我刚看到用户：这个词很奇怪')).toBe('我刚看到用户：这个词很奇怪');
  });

  it('整句只有一个名牌时保持原样，避免把内容清空', () => {
    expect(stripSpeakerPrefix('用户：', ['SOOYA'])).toBe('用户：');
  });

  it('空输入与无前缀输入原样返回', () => {
    expect(stripSpeakerPrefix('')).toBe('');
    expect(stripSpeakerPrefix('今天天气不错')).toBe('今天天气不错');
  });

  it('忽略空名字，避免生成能匹配任意内容的正则', () => {
    expect(stripSpeakerPrefix('你好：世界', ['', null, undefined])).toBe('你好：世界');
  });
});
