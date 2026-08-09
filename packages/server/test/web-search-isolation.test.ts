import { describe, expect, it } from 'vitest';
import { renderMessageForSummary, textForMemoryExtraction } from '../src/core/web-search/isolation.js';
import type { ChatMessage } from '../src/core/types.js';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1', conversationId: 'c1', role: 'assistant',
    createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z',
    seq: 1, status: 'sent', content: [{
      id: 'p1', type: 'text', status: 'sent',
      text: '某地今天发生了未经长期验证的实时事件',
      meta: { webSearchUsed: true, webSearchProvider: 'tavily' }
    }],
    ...overrides
  };
}

describe('联网回答与长期记忆隔离', () => {
  it('不把联网生成的助手事实送进记忆抽取', () => {
    expect(textForMemoryExtraction(message())).toBe('');
  });

  it('阶段摘要只保留联网占位，不复制具体实时事实', () => {
    const rendered = renderMessageForSummary(message());
    expect(rendered).toContain('联网搜索回答');
    expect(rendered).not.toContain('某地今天发生');
  });

  it('用户原话和普通助手消息仍按原样进入相应流程', () => {
    const user = message({ role: 'user', content: [{ id: 'u', type: 'text', status: 'sent', text: '我长期不吃香菜' }] });
    const assistant = message({ content: [{ id: 'a', type: 'text', status: 'sent', text: '我记住了' }] });
    expect(textForMemoryExtraction(user)).toBe('我长期不吃香菜');
    expect(renderMessageForSummary(assistant)).toBe('SOOYA: 我记住了');
  });
});
