import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';

let h: Harness | null = null;

afterEach(async () => {
  if (h) await h.cleanup();
  h = null;
});

const SEARCH_ENV = {
  SOOYA_WEB_SEARCH_ENABLED: 'true',
  SOOYA_WEB_SEARCH_PROVIDERS: 'doubao',
  SOOYA_DOUBAO_SEARCH_API_KEY: 'test-doubao-key',
  WORLD_CONTEXT_ENABLED: 'true',
  LOCATION_MODEL_ENABLED: 'true'
};

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2000;
  let last: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw last;
}

describe('city-aware web search integration', () => {
  it('hot-rebuilds search when models.json is edited on the server', async () => {
    h = await createHarness({ env: SEARCH_ENV });
    expect((h.app.services as any).webSearch.order).toEqual(['doubao']);
    const file = JSON.parse(fs.readFileSync(h.app.config.modelsPath, 'utf8'));
    file.webSearch.providers = ['tavily', 'doubao'];
    file.webSearch.tavily.apiKey = 'test-tavily-key';
    fs.writeFileSync(h.app.config.modelsPath, JSON.stringify(file, null, 2));

    await eventually(() => expect((h!.app.services as any).webSearch.order).toEqual(['tavily', 'doubao']));
  });

  it('searches local intent with the active city and persists bounded citations', async () => {
    h = await createHarness({
      env: SEARCH_ENV,
      chat: { script: [['宁波这几家可以看看 [1]。']] },
      webSearch: {
        doubao: {
          Result: {
            WebResults: [
              { Title: '宁波餐厅榜', Url: 'https://example.com/ningbo-food', Summary: '宁波本地餐厅推荐', SiteName: '示例生活' }
            ]
          }
        }
      }
    });

    const { body } = await sendText(h.app, '附近有什么好吃的');

    expect(h.state.webSearchCalls).toHaveLength(1);
    expect(h.state.webSearchCalls[0]!.provider).toBe('doubao');
    expect(h.state.webSearchCalls[0]!.body.Query).toContain('宁波');
    const chatBody = h.state.chatCalls[0]!.body as { messages: Array<{ role: string; content: string }> };
    expect(chatBody.messages[0]!.content).toContain('你当前所在城市是中国浙江宁波');
    expect(chatBody.messages[0]!.content).toContain('外部不可信内容');
    expect(chatBody.messages[0]!.content).toContain('https://example.com/ningbo-food');
    const text = body.reply.content.find((part: { type: string }) => part.type === 'text');
    expect(text.meta).toEqual({
      webSearchUsed: true,
      webSearchProvider: 'doubao',
      webCitations: [{ title: '宁波餐厅榜', url: 'https://example.com/ningbo-food' }]
    });
  });

  it('does not search ordinary emotional chat', async () => {
    h = await createHarness({ env: SEARCH_ENV, chat: { script: [['抱抱你。']] }, webSearch: { doubao: { Result: { WebResults: [] } } } });

    await sendText(h.app, '我今天很难过');

    expect(h.state.webSearchCalls).toHaveLength(0);
  });

  it('continues honestly when the selected search provider fails', async () => {
    h = await createHarness({
      env: SEARCH_ENV,
      chat: { script: [['我现在没法可靠核实实时结果。']] },
      webSearch: { doubao: { status: 429, payload: { error: 'quota detail must stay private' } } }
    });

    const { body } = await sendText(h.app, '帮我查一下最新消息');

    const chatBody = h.state.chatCalls[0]!.body as { messages: Array<{ role: string; content: string }> };
    expect(chatBody.messages[0]!.content).toContain('联网搜索当前不可用');
    expect(JSON.stringify(chatBody)).not.toContain('quota detail must stay private');
    expect(body.reply.content[0].meta?.webSearchUsed).not.toBe(true);
    expect(body.outcome.degraded).toContain('web-search:unavailable');
  });

  it('uses native Responses search as the final answer when selected and supported', async () => {
    h = await createHarness({
      env: {
        ...SEARCH_ENV,
        SOOYA_WEB_SEARCH_PROVIDERS: 'responses'
      },
      chatProvider: 'openai-responses',
      chatSupportsTools: true,
      chat: {
        respond: ({ body }) => {
          const request = body as { tools?: unknown[] };
          if (!request.tools) return null;
          return new Response(JSON.stringify({
            output: [
              { type: 'web_search_call', status: 'completed', action: { type: 'search', query: '宁波天气' } },
              {
                type: 'message', status: 'completed', role: 'assistant',
                content: [{
                  type: 'output_text', text: '宁波今天晴朗。',
                  annotations: [{ type: 'url_citation', title: '宁波天气', url: 'https://weather.example.com/ningbo' }]
                }]
              }
            ]
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      }
    });

    const { body } = await sendText(h.app, '帮我查宁波今天的天气');

    expect(h.state.chatCalls).toHaveLength(1);
    const request = h.state.chatCalls[0]!.body as { tools?: Array<Record<string, unknown>> };
    expect(request.tools?.[0]).toMatchObject({ type: 'web_search' });
    expect(body.reply.content[0]).toMatchObject({
      text: '宁波今天晴朗。',
      meta: {
        webSearchUsed: true,
        webSearchProvider: 'responses',
        webCitations: [{ title: '宁波天气', url: 'https://weather.example.com/ningbo' }]
      }
    });
  });
});
