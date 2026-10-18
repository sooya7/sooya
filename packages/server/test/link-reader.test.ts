import { describe, expect, it } from 'vitest';
import { LinkReader, extractReadable, readUrlTool } from '../src/core/links/reader.js';

const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><title>周末去哪儿 - 某站</title>
<meta name="description" content="一篇关于周末出游的小文章"></head>
<body><nav>首页 | 登录 | 注册</nav>
<script>var tracking = "should not appear";</script>
<article><h1>周末去哪儿</h1>
<p>${'秋天的西湖很适合散步，沿着苏堤走一圈大概要一个半小时。'.repeat(6)}</p>
<p>记得带一件外套，傍晚风会有点凉。</p></article>
<footer>版权所有 &copy; 2026</footer></body></html>`;

function htmlResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers ?? {}) } });
}

describe('extractReadable', () => {
  it('keeps the article text and drops scripts, nav and footer', () => {
    const { title, text } = extractReadable(ARTICLE);
    expect(title).toBe('周末去哪儿 - 某站');
    expect(text).toContain('苏堤走一圈');
    expect(text).toContain('带一件外套');
    expect(text).not.toContain('tracking');
    expect(text).not.toContain('注册');
    expect(text).not.toContain('版权所有');
  });
});

describe('LinkReader', () => {
  it('reads a page directly from the server (no browser)', async () => {
    const calls: string[] = [];
    const reader = new LinkReader({ fetchImpl: (async (url: string) => { calls.push(String(url)); return htmlResponse(ARTICLE); }) as typeof fetch });
    const result = await reader.read('http://93.184.216.34/article');
    expect(result.via).toBe('direct');
    expect(result.text).toContain('西湖');
    expect(calls).toEqual(['http://93.184.216.34/article']);
  });

  it('refuses private addresses, including a redirect into one', async () => {
    const reader = new LinkReader({
      fetchImpl: (async () => htmlResponse('', { status: 302, headers: { location: 'http://127.0.0.1/admin' } })) as typeof fetch
    });
    await expect(reader.read('http://127.0.0.1/secret')).rejects.toThrow(/不能打开/);
    await expect(reader.read('http://93.184.216.34/jump')).rejects.toThrow(/不能打开/);
  });

  it('falls back to Tavily extract when the page has almost no text (JS-rendered)', async () => {
    const tavilyBodies: unknown[] = [];
    const reader = new LinkReader({
      fetchImpl: (async () => htmlResponse('<html><body><div id="app"></div><script src="/a.js"></script></body></html>')) as typeof fetch,
      tavilyFetchImpl: (async (url: string, init?: RequestInit) => {
        expect(String(url)).toBe('https://api.tavily.com/extract');
        tavilyBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ results: [{ url: 'http://93.184.216.34/spa', title: 'SPA', raw_content: '渲染后的正文内容' }] }), { status: 200 });
      }) as typeof fetch,
      tavily: () => ({ baseUrl: 'https://api.tavily.com/search', apiKey: 'tvly-test' })
    });
    const result = await reader.read('http://93.184.216.34/spa');
    expect(result.via).toBe('tavily');
    expect(result.text).toBe('渲染后的正文内容');
    expect(tavilyBodies).toEqual([expect.objectContaining({ urls: ['http://93.184.216.34/spa'] })]);
  });

  it('keeps a genuinely short page when Tavily has nothing better', async () => {
    const reader = new LinkReader({ fetchImpl: (async () => htmlResponse('<html><body><p>今天下午三点开会，地点在三楼会议室，记得带上周报和电脑。</p><p>会后一起吃晚饭。</p></body></html>')) as typeof fetch });
    const result = await reader.read('http://93.184.216.34/notice');
    expect(result.via).toBe('direct');
    expect(result.text).toContain('三楼会议室');
  });

  it('says plainly when a page cannot be opened', async () => {
    const reader = new LinkReader({ fetchImpl: (async () => htmlResponse('denied', { status: 403 })) as typeof fetch });
    await expect(reader.read('http://93.184.216.34/locked')).rejects.toThrow(/打不开这个链接：网站返回 403/);
  });

  it('the tool hands her the title, link and text', async () => {
    const tool = readUrlTool(new LinkReader({ fetchImpl: (async () => htmlResponse(ARTICLE)) as typeof fetch }));
    expect(tool).toMatchObject({ modelName: 'read_url', risk: 'read', phases: ['reply'] });
    const out = String(await tool.handler({ url: '93.184.216.34/article' }, { phase: 'reply' }));
    expect(out).toContain('标题：周末去哪儿');
    expect(out).toContain('链接：https://93.184.216.34/article');
    expect(out).toContain('苏堤');
  });
});
