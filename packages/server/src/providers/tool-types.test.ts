import { describe, expect, it } from 'vitest';
import type { ChatRequest, ModelTurn } from './types.js';

describe('provider-neutral tool types', () => {
  it('keeps tool rounds independent from vendor wire roles', () => {
    const turns: ModelTurn[] = [
      { role: 'user', content: [{ type: 'text', text: '记得我不吃香菜' }] },
      {
        role: 'assistant_tool_call',
        calls: [{ id: 'call-1', name: 'ombre.breath', arguments: {} }]
      },
      {
        role: 'tool_result',
        callId: 'call-1',
        name: 'ombre.breath',
        content: '历史材料',
        isError: false
      }
    ];
    const request: ChatRequest = {
      messages: turns,
      tools: [{ name: 'ombre.breath', description: 'Surface memory.', inputSchema: { type: 'object' } }],
      toolChoice: 'auto'
    };
    expect(request.messages[1]?.role).toBe('assistant_tool_call');
    expect(request.tools?.[0]?.name).toBe('ombre.breath');
  });
});
