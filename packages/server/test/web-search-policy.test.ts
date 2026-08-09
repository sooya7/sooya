import { describe, expect, it } from 'vitest';
import { decideWebSearch } from '../src/core/web-search/policy.js';

describe('decideWebSearch', () => {
  it.each([
    ['帮我联网查一下这条消息', 'explicit'],
    ['最近有什么重要新闻', 'fresh_external'],
    ['DeepSeek 最新版本是多少', 'fresh_external'],
    ['附近有什么好吃的', 'local'],
    ['宁波今天有什么活动', 'fresh_external'],
    ['现在人民币汇率是多少', 'fresh_external']
  ] as const)('offers search for %s', (text, reason) => {
    expect(decideWebSearch(text)).toMatchObject({ offer: true, reason });
  });

  it('derives a one-day freshness window for current questions', () => {
    expect(decideWebSearch('今天宁波有什么新闻')).toEqual({
      offer: true,
      reason: 'fresh_external',
      freshness: 'day'
    });
  });

  it.each([
    '你好',
    '我今天很难过',
    '你现在在做什么',
    '你记得我不吃香菜吗',
    '我们之前聊过什么',
    '陪我说会儿话'
  ])('does not offer search for %s', (text) => {
    expect(decideWebSearch(text)).toEqual({ offer: false, reason: 'none' });
  });
});
