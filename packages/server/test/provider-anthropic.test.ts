import { describe, expect, it } from 'vitest';
import { ChatModelSchema } from '../src/config/schema.js';
import { AnthropicChatProvider, createChatProvider } from '../src/providers/chat/openai.js';
import { ProviderNotConfiguredError, ProviderRequestError, type ChatChunk, type ChatRequest } from '../src/providers/types.js';

/**
 * Protocol-level coverage for the Anthropic Messages adapter. The shared test
 * harness only ever configures `openai-chat`, so this branch was never
 * exercised: the provider is instantiated directly with an injected `fetchImpl`
 * that records the outgoing request and answers with hand-written payloads.
 */

const BASE_URL = 'https://anthropic.example.com/v1';

function config(overrides: Record<string, unknown> = {}) {
  return ChatModelSchema.parse({
    provider: 'anthropic-messages',
    baseUrl: BASE_URL,
    apiKey: 'sk-ant-test',
    model: 'claude-test',
    maxTokens: 512,
    temperature: 0.3,
    maxRetries: 0,
    ...overrides
  });
}

interface Sent {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

/** Wires a provider to a fake endpoint and records what it sent. */
function provider(respond: () => Response, overrides: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const p = new AnthropicChatProvider(config(overrides), {
    allowPrivateNetwork: true,
    fetchImpl: async (input, init) => {
      sent.push({
        url: String(input),
        method: init?.method,
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        body: JSON.parse(String(init?.body))
      });
      return respond();
    }
  });
  return { p, sent };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * SSE body in Anthropic's shape: each event carries both an `event:` name line
 * and a `data:` line, and the stream ends with `message_stop` rather than the
 * OpenAI-style `[DONE]` sentinel.
 */
function sse(events: Array<{ type: string; [k: string]: unknown }>): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function collect(): { onChunk: (c: ChatChunk) => void; deltas: string[] } {
  const deltas: string[] = [];
  return { onChunk: (c) => deltas.push(c.delta), deltas };
}

const TEXT_REQ: ChatRequest = { messages: [{ role: 'user', content: [{ type: 'text', text: '在吗' }] }] };

const OK = { content: [{ type: 'text', text: 'ok' }] };

describe('anthropic-messages 适配器：请求构造', () => {
  it('POST 到 <baseUrl>/messages，带 x-api-key、anthropic-version 与额外头', async () => {
    const { p, sent } = provider(() => json(OK), { extraHeaders: { 'anthropic-beta': 'sooya-test' } });
    await p.complete(TEXT_REQ);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${BASE_URL}/messages`);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].headers['x-api-key']).toBe('sk-ant-test');
    expect(sent[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(sent[0].headers['content-type']).toBe('application/json');
    expect(sent[0].headers['anthropic-beta']).toBe('sooya-test');
    // Anthropic 用 x-api-key，不是 Bearer
    expect(sent[0].headers.authorization).toBeUndefined();
  });

  it('baseUrl 已经以 /messages 结尾时不重复拼接', async () => {
    const { p, sent } = provider(() => json(OK), { baseUrl: `${BASE_URL}/messages` });
    await p.complete(TEXT_REQ);
    expect(sent[0].url).toBe(`${BASE_URL}/messages`);
  });

  it('system 提到顶层字段，role 为 system 的 turn 被过滤掉', async () => {
    const { p, sent } = provider(() => json(OK));
    await p.complete({
      system: '你是回声',
      messages: [
        { role: 'system', content: [{ type: 'text', text: '不该出现在 messages 里' }] },
        { role: 'user', content: [{ type: 'text', text: '在吗' }] }
      ]
    });
    const body = sent[0].body;
    expect(body.system).toBe('你是回声');
    expect(body.model).toBe('claude-test');
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(512);
    expect(body.temperature).toBe(0.3);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '在吗' }] }]);
  });

  it('图片映射为 base64 image source，与 Chat Completions 的 image_url 形式不同', async () => {
    const { p, sent } = provider(() => json(OK));
    await p.complete({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看这张' },
            { type: 'image', mime: 'image/png', data: 'AAAB' }
          ]
        },
        { role: 'assistant', content: [{ type: 'text', text: '看到了' }] }
      ]
    });
    expect(sent[0].body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAB' } }
        ]
      },
      { role: 'assistant', content: [{ type: 'text', text: '看到了' }] }
    ]);
  });

  it('请求级 maxTokens / temperature 覆盖配置值，无 system 时不带该字段', async () => {
    const { p, sent } = provider(() => json(OK));
    await p.complete({ ...TEXT_REQ, maxTokens: 64, temperature: 0 });
    expect(sent[0].body.max_tokens).toBe(64);
    expect(sent[0].body.temperature).toBe(0);
    expect('system' in sent[0].body).toBe(false);
  });
});

describe('anthropic-messages 适配器：非流式响应解析', () => {
  it('content 中只取 type 为 text 的块并按顺序拼接', async () => {
    const { p } = provider(() =>
      json({
        content: [
          { type: 'text', text: '前' },
          { type: 'thinking', thinking: '不该出现' },
          { type: 'tool_use', name: 'x' },
          { type: 'text', text: '后' }
        ]
      })
    );
    const r = await p.complete(TEXT_REQ);
    expect(r.text).toBe('前后');
    expect(r.model).toBe('claude-test');
  });

  it('筛选依据是 type 而不是「有没有 text 字段」', async () => {
    // 非 text 块即使带了 text 字段也不能进正文，否则思考内容/拒答理由会被当成回复。
    const { p } = provider(() =>
      json({
        content: [
          { type: 'text', text: '正文' },
          { type: 'refusal', text: '不该出现' },
          { type: 'thinking', thinking: '内心戏', text: '也不该出现' }
        ]
      })
    );
    expect((await p.complete(TEXT_REQ)).text).toBe('正文');
  });

  it('stop_reason 与 usage 映射到 finishReason / usage', async () => {
    const { p } = provider(() =>
      json({
        content: [{ type: 'text', text: '答' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 34 }
      })
    );
    const r = await p.complete(TEXT_REQ);
    expect(r.finishReason).toBe('end_turn');
    expect(r.usage).toEqual({ promptTokens: 12, completionTokens: 34 });
  });

  it('content 缺失或无 text 块时返回空串而不是抛错', async () => {
    const { p } = provider(() => json({ id: 'msg_1', stop_reason: 'max_tokens' }));
    const r = await p.complete(TEXT_REQ);
    expect(r.text).toBe('');
    expect(r.finishReason).toBe('max_tokens');
    expect(r.usage).toEqual({ promptTokens: undefined, completionTokens: undefined });
  });
});

describe('anthropic-messages 适配器：流式增量', () => {
  it('content_block_delta 的 text_delta 逐段 emit 并拼成完整文本', async () => {
    const { p, sent } = provider(() =>
      sse([
        { type: 'message_start', message: { id: 'msg_1' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' }
      ])
    );
    const { onChunk, deltas } = collect();
    const r = await p.stream(TEXT_REQ, onChunk);
    expect(deltas).toEqual(['你', '好']);
    expect(r.text).toBe('你好');
    expect(r.finishReason).toBe('end_turn');
    expect(sent[0].body.stream).toBe(true);
    expect(sent[0].headers.accept).toBe('text/event-stream');
  });

  it('非 text_delta 的增量事件被忽略，不混进正文', async () => {
    const { p } = provider(() =>
      sse([
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '内心戏' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '正文' } },
        { type: 'message_stop' }
      ])
    );
    const { onChunk, deltas } = collect();
    const r = await p.stream(TEXT_REQ, onChunk);
    expect(deltas).toEqual(['正文']);
    expect(r.text).toBe('正文');
    expect(r.finishReason).toBeUndefined();
  });

  it('ping 与畸形保活行被忽略，不中断后续增量', async () => {
    const body =
      'event: ping\ndata: {"type":"ping"}\n\n' +
      ': keepalive\n\n' +
      'data: {不是 JSON}\n\n' +
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '有效' } })}\n\n` +
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'stop_sequence' } })}\n\n`;
    const { p } = provider(() => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const { onChunk, deltas } = collect();
    const r = await p.stream(TEXT_REQ, onChunk);
    expect(deltas).toEqual(['有效']);
    expect(r.text).toBe('有效');
    expect(r.finishReason).toBe('stop_sequence');
  });

  it('supportsStreaming 为 false 时退回一次性请求，并把全文作为单个增量发出', async () => {
    const { p, sent } = provider(() => json({ content: [{ type: 'text', text: '不流式' }] }), { supportsStreaming: false });
    const { onChunk, deltas } = collect();
    const r = await p.stream(TEXT_REQ, onChunk);
    expect(deltas).toEqual(['不流式']);
    expect(r.text).toBe('不流式');
    expect(sent[0].body.stream).toBe(false);
  });
});

describe('anthropic-messages 适配器：错误与未配置', () => {
  it('非 2xx 抛 ProviderRequestError 并带上 status', async () => {
    const { p } = provider(() => new Response('model not found', { status: 404 }));
    await expect(p.complete(TEXT_REQ)).rejects.toMatchObject({ name: 'ProviderRequestError', status: 404 });
    await expect(p.complete(TEXT_REQ)).rejects.toThrow(/anthropic request failed with status 404: model not found/);
  });

  it('流式非 2xx 同样抛带 status 的 ProviderRequestError', async () => {
    const { p } = provider(() => new Response('overloaded', { status: 529 }));
    const err = await p.stream(TEXT_REQ, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err.status).toBe(529);
    expect(err.message).toMatch(/anthropic stream failed with status 529/);
  });

  it('缺少 apiKey 时 configured 为 false，调用抛 ProviderNotConfiguredError', async () => {
    const { p, sent } = provider(() => json(OK), { apiKey: '' });
    expect(p.configured).toBe(false);
    await expect(p.complete(TEXT_REQ)).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    await expect(p.stream(TEXT_REQ, () => {})).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(sent).toHaveLength(0);
  });

  it('createChatProvider 对 anthropic-messages 返回该适配器', () => {
    const p = createChatProvider(config(), { allowPrivateNetwork: true });
    expect(p).toBeInstanceOf(AnthropicChatProvider);
    expect(p.name).toBe('anthropic-messages');
  });
});
