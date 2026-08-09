import { describe, expect, it } from 'vitest';
import { ChatModelSchema } from '../src/config/schema.js';
import { createChatProvider, OpenAIResponsesProvider } from '../src/providers/chat/openai.js';
import { ProviderNotConfiguredError, ProviderRequestError, type ChatChunk, type ChatRequest } from '../src/providers/types.js';

/**
 * Protocol-level coverage for the Responses API adapter. The shared test harness
 * only ever configures `openai-chat`, so this branch was never exercised: the
 * provider is instantiated directly with an injected `fetchImpl` that records the
 * outgoing request and answers with hand-written payloads.
 */

const BASE_URL = 'https://responses.example.com/v1';

function config(overrides: Record<string, unknown> = {}) {
  return ChatModelSchema.parse({
    provider: 'openai-responses',
    baseUrl: BASE_URL,
    apiKey: 'sk-responses-test',
    model: 'gpt-test-responses',
    maxTokens: 321,
    temperature: 0.4,
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
  const p = new OpenAIResponsesProvider(config(overrides), {
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

/** SSE body: one `data:` line per event, terminated the way the API does. */
function sse(events: unknown[], done = true): Response {
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
  if (done) lines.push('data: [DONE]\n\n');
  return new Response(lines.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function collect(): { onChunk: (c: ChatChunk) => void; deltas: string[] } {
  const deltas: string[] = [];
  return { onChunk: (c) => deltas.push(c.delta), deltas };
}

const TEXT_REQ: ChatRequest = { messages: [{ role: 'user', content: [{ type: 'text', text: '在吗' }] }] };

describe('openai-responses 适配器：请求体构造', () => {
  it('POST 到 <baseUrl>/responses，带 Bearer 与额外头', async () => {
    const { p, sent } = provider(() => json({ output_text: 'ok' }), {
      extraHeaders: { 'x-tenant': 'sooya' }
    });
    await p.complete(TEXT_REQ);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${BASE_URL}/responses`);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].headers.authorization).toBe('Bearer sk-responses-test');
    expect(sent[0].headers['content-type']).toBe('application/json');
    expect(sent[0].headers['x-tenant']).toBe('sooya');
  });

  it('baseUrl 已经以 /responses 结尾时不重复拼接', async () => {
    const { p, sent } = provider(() => json({ output_text: 'ok' }), { baseUrl: `${BASE_URL}/responses` });
    await p.complete(TEXT_REQ);
    expect(sent[0].url).toBe(`${BASE_URL}/responses`);
  });

  it('文本与图片映射为 input 数组，系统提示走 instructions', async () => {
    const { p, sent } = provider(() => json({ output_text: 'ok' }));
    await p.complete({
      system: '你是回声',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '看这张' }, { type: 'image', mime: 'image/png', data: 'AAAB' }] },
        { role: 'assistant', content: [{ type: 'text', text: '看到了' }] }
      ]
    });
    const body = sent[0].body;
    expect(body.model).toBe('gpt-test-responses');
    expect(body.instructions).toBe('你是回声');
    expect(body.stream).toBe(false);
    // Responses API 用 max_output_tokens，不是 Chat Completions 的 max_tokens
    expect(body.max_output_tokens).toBe(321);
    expect(body.max_tokens).toBeUndefined();
    expect(body.messages).toBeUndefined();
    expect(body.temperature).toBe(0.4);
    expect(body.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '看这张' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAB' }
        ]
      },
      { role: 'assistant', content: [{ type: 'output_text', text: '看到了' }] }
    ]);
  });

  it('请求级 maxTokens / temperature 覆盖配置值，无 system 时不带 instructions', async () => {
    const { p, sent } = provider(() => json({ output_text: 'ok' }));
    await p.complete({ ...TEXT_REQ, maxTokens: 64, temperature: 0 });
    expect(sent[0].body.max_output_tokens).toBe(64);
    expect(sent[0].body.temperature).toBe(0);
    expect('instructions' in sent[0].body).toBe(false);
  });
});

describe('openai-responses 适配器：output_text 解析', () => {
  it('output_text 为字符串时直接返回', async () => {
    const { p } = provider(() => json({ output_text: '一句回答' }));
    const r = await p.complete(TEXT_REQ);
    expect(r.text).toBe('一句回答');
    expect(r.model).toBe('gpt-test-responses');
  });

  it('output_text 为数组时按顺序拼接', async () => {
    const { p } = provider(() => json({ output_text: ['前', '后'] }));
    expect((await p.complete(TEXT_REQ)).text).toBe('前后');
  });

  it('缺少 output_text 时从 output[].content[].text 回落', async () => {
    const { p } = provider(() =>
      json({
        output: [
          { content: [{ type: 'output_text', text: '甲' }, { type: 'refusal' }] },
          { content: [{ type: 'output_text', text: '乙' }] }
        ]
      })
    );
    expect((await p.complete(TEXT_REQ)).text).toBe('甲乙');
  });

  it('两种字段都没有时返回空串而不是抛错', async () => {
    const { p } = provider(() => json({ id: 'resp_1', status: 'completed' }));
    expect((await p.complete(TEXT_REQ)).text).toBe('');
  });

  it('启用原生联网搜索时发送 web_search 工具与近似位置', async () => {
    const { p, sent } = provider(() => json({ output_text: '已核实' }));
    await p.complete({
      ...TEXT_REQ,
      webSearch: {
        enabled: true,
        userLocation: { countryCode: 'CN', region: '北京市', city: '北京' }
      }
    });

    expect(sent[0].body.tools).toEqual([{
      type: 'web_search',
      user_location: { type: 'approximate', country: 'CN', region: '北京市', city: '北京' }
    }]);
  });

  it('只取最终 completed assistant message，并返回去重后的安全引用', async () => {
    const { p } = provider(() => json({
      output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search', query: '北京天气' } },
        {
          type: 'message', status: 'in_progress', role: 'assistant',
          content: [{ type: 'output_text', text: '中间草稿', annotations: [] }]
        },
        {
          type: 'message', status: 'completed', role: 'assistant',
          content: [{
            type: 'output_text', text: '北京今天晴朗。', annotations: [
              { type: 'url_citation', title: '天气来源', url: 'https://weather.example.com/today' },
              { type: 'url_citation', title: '重复来源', url: 'https://weather.example.com/today' },
              { type: 'url_citation', title: '危险来源', url: 'javascript:alert(1)' }
            ]
          }]
        }
      ]
    }));

    const result = await p.complete({ ...TEXT_REQ, webSearch: { enabled: true } });
    expect(result.text).toBe('北京今天晴朗。');
    expect(result.webSearch).toEqual({
      used: true,
      callCount: 1,
      citations: [{ title: '天气来源', url: 'https://weather.example.com/today' }]
    });
  });

  it('模型未调用 web_search 时明确返回 used=false', async () => {
    const { p } = provider(() => json({
      output: [{
        type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: '无需搜索', annotations: [] }]
      }]
    }));

    expect((await p.complete({ ...TEXT_REQ, webSearch: { enabled: true } })).webSearch).toEqual({
      used: false,
      callCount: 0,
      citations: []
    });
  });

  it('缺少 annotations 时从 open_page 和最终文本中的 HTTP 链接补引用', async () => {
    const { p } = provider(() => json({
      output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://example.com/opened' } },
        {
          type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: '详情见 https://example.com/final 。', annotations: [] }]
        }
      ]
    }));

    expect((await p.complete({ ...TEXT_REQ, webSearch: { enabled: true } })).webSearch?.citations).toEqual([
      { title: 'example.com', url: 'https://example.com/opened' },
      { title: 'example.com', url: 'https://example.com/final' }
    ]);
  });
});

describe('openai-responses 适配器：流式增量', () => {
  it('response.output_text.delta 逐段 emit 并拼成完整文本', async () => {
    const { p, sent } = provider(() =>
      sse([
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_text.delta', delta: '你' },
        { type: 'response.output_text.delta', delta: '好' },
        { type: 'response.output_text.done', text: '你好' },
        { type: 'response.completed', response: { output_text: '你好' } }
      ])
    );
    const { onChunk, deltas } = collect();
    const r = await p.stream(TEXT_REQ, onChunk);
    expect(deltas).toEqual(['你', '好']);
    expect(r.text).toBe('你好');
    expect(sent[0].body.stream).toBe(true);
    expect(sent[0].headers.accept).toBe('text/event-stream');
  });

  it('只发 response.completed（无 delta）时从最终响应补出文本', async () => {
    const { p } = provider(() => sse([{ type: 'response.completed', response: { output_text: '整段' } }]));
    const { onChunk, deltas } = collect();
    const r = await p.stream(TEXT_REQ, onChunk);
    expect(deltas).toEqual(['整段']);
    expect(r.text).toBe('整段');
  });

  it('已有增量时 response.completed 不重复追加文本', async () => {
    const { p } = provider(() =>
      sse([
        { type: 'response.output_text.delta', delta: '增量' },
        { type: 'response.completed', response: { output_text: '增量' } }
      ])
    );
    const { onChunk, deltas } = collect();
    const r = await p.stream(TEXT_REQ, onChunk);
    expect(deltas).toEqual(['增量']);
    expect(r.text).toBe('增量');
  });

  it('无法解析的保活行被忽略，[DONE] 之后的事件不再处理', async () => {
    const body =
      ': keepalive\n\n' +
      'data: {不是 JSON}\n\n' +
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '有效' })}\n\n` +
      'data: [DONE]\n\n' +
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '不该出现' })}\n\n`;
    const { p } = provider(() => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const { onChunk, deltas } = collect();
    const r = await p.stream(TEXT_REQ, onChunk);
    expect(deltas).toEqual(['有效']);
    expect(r.text).toBe('有效');
  });

  it('supportsStreaming 为 false 时退回一次性请求，并把全文作为单个增量发出', async () => {
    const { p, sent } = provider(() => json({ output_text: '不流式' }), { supportsStreaming: false });
    const { onChunk, deltas } = collect();
    const r = await p.stream(TEXT_REQ, onChunk);
    expect(deltas).toEqual(['不流式']);
    expect(r.text).toBe('不流式');
    expect(sent[0].body.stream).toBe(false);
  });
});

describe('openai-responses 适配器：错误与未配置', () => {
  it('非 2xx 抛 ProviderRequestError 并带上 status', async () => {
    const { p } = provider(() => new Response('model not found', { status: 404 }));
    await expect(p.complete(TEXT_REQ)).rejects.toMatchObject({ name: 'ProviderRequestError', status: 404 });
    await expect(p.complete(TEXT_REQ)).rejects.toThrow(/responses request failed with status 404: model not found/);
  });

  it('流式非 2xx 同样抛带 status 的 ProviderRequestError', async () => {
    const { p } = provider(() => new Response('rate limited', { status: 429 }));
    const err = await p.stream(TEXT_REQ, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/responses stream failed with status 429/);
  });

  it('缺少 apiKey 时 configured 为 false，调用抛 ProviderNotConfiguredError', async () => {
    const { p, sent } = provider(() => json({ output_text: 'ok' }), { apiKey: '' });
    expect(p.configured).toBe(false);
    await expect(p.complete(TEXT_REQ)).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    await expect(p.stream(TEXT_REQ, () => {})).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(sent).toHaveLength(0);
  });

  it('createChatProvider 对 openai-responses 返回该适配器', () => {
    const p = createChatProvider(config(), { allowPrivateNetwork: true });
    expect(p).toBeInstanceOf(OpenAIResponsesProvider);
    expect(p.name).toBe('openai-responses');
  });
});
