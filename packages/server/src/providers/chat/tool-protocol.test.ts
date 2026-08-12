import { describe, expect, it } from 'vitest';
import type { ChatModelConfig } from '../../config/schema.js';
import type { ChatRequest } from '../types.js';
import { AnthropicChatProvider, OpenAIChatProvider, OpenAIResponsesProvider } from './openai.js';

function cfg(provider: ChatModelConfig['provider']): ChatModelConfig {
  return {
    provider,
    // The SSRF guard runs even when fetch is mocked; use a public IP so this
    // protocol-only test does not depend on CI DNS availability.
    baseUrl: 'https://93.184.216.34/v1',
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 10_000,
    maxTokens: 256,
    temperature: 0.2,
    contextWindow: 8_000,
    supportsVision: true,
    supportsTools: true,
    supportsStreaming: false,
    maxRetries: 0,
    extraHeaders: {}
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const request: ChatRequest = {
  system: '你有记忆工具。',
  messages: [
    { role: 'user', content: [{ type: 'text', text: '我最近在准备考试。' }] },
    { role: 'assistant_tool_call', calls: [{ id: 'call-1', name: 'ombre.breath_search', arguments: { query: '考试' } }] },
    { role: 'tool_result', callId: 'call-1', name: 'ombre.breath_search', content: '历史记忆' }
  ],
  tools: [{ name: 'ombre.breath_search', description: 'Search memory.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
  toolChoice: 'auto'
};

describe('provider tool protocol adapters', () => {
  it('maps OpenAI Chat tool calls and model history', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAIChatProvider(cfg('openai-chat'), {
      allowPrivateNetwork: false,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ choices: [{ message: { content: null, tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'ombre.breath', arguments: '{"query":"你好"}' } }] }, finish_reason: 'tool_calls' }] });
      }
    });
    const result = await provider.complete(request);
    expect(result.toolCalls).toEqual([{ id: 'call-2', name: 'ombre.breath', arguments: { query: '你好' } }]);
    expect((body?.tools as Array<{ function: { parameters: unknown } }>)[0]?.function.parameters).toEqual(request.tools?.[0]?.inputSchema);
    expect((body?.messages as Array<Record<string, unknown>>).some((message) => message.role === 'tool')).toBe(true);
  });

  it('keeps malformed JSON arguments explicit for the runtime to reject', async () => {
    const provider = new OpenAIChatProvider(cfg('openai-chat'), {
      allowPrivateNetwork: false,
      fetchImpl: async () => response({ choices: [{ message: { content: null, tool_calls: [{ id: 'bad', function: { name: 'ombre.breath', arguments: '{' } }] } }] })
    });
    const result = await provider.complete(request);
    expect(result.toolCalls?.[0]).toMatchObject({ id: 'bad', name: 'ombre.breath', arguments: {}, argumentsError: 'invalid JSON arguments' });
  });

  it('maps Responses function calls while preserving hosted web search', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAIResponsesProvider(cfg('openai-responses'), {
      allowPrivateNetwork: false,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ output: [
          { type: 'function_call', call_id: 'call-3', name: 'ombre.breath', arguments: '{"query":"考试"}' },
          { type: 'web_search_call', action: { type: 'search' } }
        ] });
      }
    });
    const result = await provider.complete({ ...request, webSearch: { enabled: true } });
    expect(result.toolCalls).toEqual([{ id: 'call-3', name: 'ombre.breath', arguments: { query: '考试' } }]);
    expect((body?.tools as Array<{ type: string }>).map((tool) => tool.type)).toEqual(['function', 'web_search']);
    expect(result.webSearch?.used).toBe(true);
  });

  it('maps Anthropic tool_use and tool_result blocks', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new AnthropicChatProvider(cfg('anthropic-messages'), {
      allowPrivateNetwork: false,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ content: [{ type: 'tool_use', id: 'call-4', name: 'ombre.breath', input: { query: '考试' } }], stop_reason: 'tool_use' });
      }
    });
    const result = await provider.complete(request);
    expect(result.toolCalls).toEqual([{ id: 'call-4', name: 'ombre.breath', arguments: { query: '考试' } }]);
    expect((body?.tools as Array<{ input_schema: unknown }>)[0]?.input_schema).toEqual(request.tools?.[0]?.inputSchema);
    expect(JSON.stringify(body?.messages)).toContain('tool_result');
  });
});
