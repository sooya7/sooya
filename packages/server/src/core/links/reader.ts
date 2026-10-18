/**
 * read_url: open a web page the user shared and hand her its main text.
 *
 * The server fetches the page itself (no browser: just the HTML) and keeps
 * the readable part. Pages that only render with JavaScript, or that the
 * server cannot reach, fall back to Tavily's extract API when a key is set.
 * Private / internal addresses are always refused, on every redirect hop.
 */
import { assertSafeUrl } from '../../util/http.js';
import type { ToolDescriptor } from '../../agent/registry.js';

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_TEXT_CHARS = 12_000;
const MIN_USEFUL_CHARS = 200;
/** Below this a page is treated as empty (a JS shell, an error stub). */
const MIN_SHORT_PAGE_CHARS = 20;
const FETCH_TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 5;

export interface LinkReaderDeps {
  /** Fetch for the page itself: direct, so domestic sites stay reachable. */
  fetchImpl?: typeof fetch;
  /** Fetch for the Tavily API (may go through the outbound proxy). */
  tavilyFetchImpl?: typeof fetch;
  /** Current Tavily config (search URL + key); extract lives next to search. */
  tavily?: () => { baseUrl: string; apiKey: string } | null;
}

export interface ReadResult {
  url: string;
  title: string;
  text: string;
  via: 'direct' | 'tavily';
  truncated: boolean;
}

export class LinkReader {
  private readonly fetchImpl: typeof fetch;
  private readonly tavilyFetchImpl: typeof fetch;

  constructor(private readonly deps: LinkReaderDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.tavilyFetchImpl = deps.tavilyFetchImpl ?? this.fetchImpl;
  }

  async read(rawUrl: string, signal?: AbortSignal): Promise<ReadResult> {
    const url = normalizeInputUrl(rawUrl);
    let directError: Error | null = null;
    let shortDirect: ReadResult | null = null;
    try {
      const direct = await this.readDirect(url, signal);
      if (direct.text.length >= MIN_USEFUL_CHARS) return direct;
      // Little text: maybe a JS-rendered page, maybe just a short one.
      // Let Tavily try to render it; if it cannot do better, keep what we got.
      if (direct.text.length >= MIN_SHORT_PAGE_CHARS) shortDirect = direct;
      directError = new Error('页面里几乎没有正文（可能要运行脚本才显示）');
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof RefusedUrlError) throw error;
      directError = error instanceof Error ? error : new Error(String(error));
    }
    const viaTavily = await this.readViaTavily(url, signal).catch(() => null);
    if (viaTavily && viaTavily.text.length > (shortDirect?.text.length ?? 0)) return viaTavily;
    if (shortDirect) return shortDirect;
    throw new Error(`打不开这个链接：${directError?.message ?? '未知原因'}`);
  }

  private async readDirect(start: string, signal?: AbortSignal): Promise<ReadResult> {
    let current = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertSafe(current);
      const response = await this.fetchWithTimeout(current, {
        redirect: 'manual',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6'
        }
      }, signal);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`跳转没有目标地址（${response.status}）`);
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`网站返回 ${response.status}`);
      const type = (response.headers.get('content-type') ?? '').toLowerCase();
      if (type && !type.includes('html') && !type.startsWith('text/') && !type.includes('xml') && !type.includes('json')) {
        throw new Error(`这不是网页，是 ${type.split(';')[0]}`);
      }
      const bytes = await readCapped(response, MAX_HTML_BYTES);
      const html = decode(bytes, type);
      const isHtml = type.includes('html') || /<html|<body|<head/i.test(html.slice(0, 2000));
      const { title, text } = isHtml ? extractReadable(html) : { title: '', text: html.trim() };
      return finish(current, title, text, 'direct');
    }
    throw new Error('跳转次数太多');
  }

  private async readViaTavily(url: string, signal?: AbortSignal): Promise<ReadResult | null> {
    const config = this.deps.tavily?.();
    if (!config?.apiKey.trim()) return null;
    const endpoint = config.baseUrl.replace(/\/search\/?$/u, '/extract');
    const response = await this.fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ urls: [url], extract_depth: 'advanced', format: 'text' })
    }, signal, 8_000, this.tavilyFetchImpl);
    if (!response.ok) return null;
    const json = await response.json() as { results?: Array<{ url?: string; raw_content?: string; title?: string }> };
    const hit = json.results?.[0];
    if (!hit?.raw_content?.trim()) return null;
    return finish(hit.url ?? url, hit.title ?? '', hit.raw_content, 'tavily');
  }

  private async fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = this.fetchImpl): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('网站响应超时')), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw new Error('网站响应超时');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

class RefusedUrlError extends Error {}

async function assertSafe(url: string): Promise<void> {
  try {
    await assertSafeUrl(url, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A name that only *resolves* to an internal or bogus address (DNS
    // pollution of a blocked site, or a failed lookup) is a reason not to
    // connect from here, not a reason to give up: Tavily fetches it from
    // outside. Literal internal addresses and bad schemes are refused outright.
    if (message.includes(' -> ') || message.startsWith('dns ')) throw new Error('服务器直连不上这个网站');
    throw new RefusedUrlError(`这个地址不能打开（${message}）`);
  }
}

function normalizeInputUrl(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new RefusedUrlError('链接是空的');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    throw new RefusedUrlError('这不是一个有效的链接');
  }
}

function finish(url: string, title: string, text: string, via: ReadResult['via']): ReadResult {
  const clean = text.replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = clean.length > MAX_TEXT_CHARS;
  return { url, title: title.trim(), text: truncated ? clean.slice(0, MAX_TEXT_CHARS) : clean, via, truncated };
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      break; // the readable part is near the top; keep what arrived
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function decode(bytes: Buffer, contentType: string): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
    ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(bytes.subarray(0, 4096).toString('latin1'))?.[1]
    ?? 'utf-8';
  const label = /^(gb2312|gbk|gb_2312-80)$/i.test(declared) ? 'gbk' : declared.toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const DROP_BLOCKS = /<(script|style|noscript|template|svg|canvas|iframe|nav|header|footer|aside|form|button|select)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK_TAGS = /<\/?(p|div|section|article|main|li|ul|ol|h[1-6]|br|tr|table|blockquote|pre|figure|figcaption|dd|dt|hr)\b[^>]*>/gi;

/** Dependency-free main-text extraction: prefer <article>/<main>, else the densest body. */
export function extractReadable(html: string): { title: string; text: string } {
  const title = decodeEntities(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html)?.[1]
    ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
    ?? ''
  ).replace(/\s+/g, ' ').trim();
  const description = decodeEntities(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i.exec(html)?.[1] ?? '').trim();
  let body = html.replace(/<!--[\s\S]*?-->/g, '');
  const candidates = [
    ...matchAll(body, /<article\b[\s\S]*?<\/article>/gi),
    ...matchAll(body, /<main\b[\s\S]*?<\/main>/gi),
    ...matchAll(body, /<div[^>]+(?:id|class)=["'][^"']*(?:js_content|rich_media_content|article|content|post|entry|RichText)[^"']*["'][\s\S]*?<\/div>\s*<\/div>/gi)
  ].map(htmlToText).filter((text) => text.length >= MIN_USEFUL_CHARS);
  let text = candidates.sort((a, b) => b.length - a.length)[0] ?? '';
  if (!text) {
    body = /<body\b[\s\S]*<\/body>/i.exec(body)?.[0] ?? body;
    text = htmlToText(body);
  }
  if (description && !text.includes(description.slice(0, 30))) text = `${description}\n\n${text}`;
  return { title, text };
}

function matchAll(source: string, re: RegExp): string[] {
  return [...source.matchAll(re)].map((match) => match[0]);
}

function htmlToText(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(DROP_BLOCKS, ' ')
      .replace(BLOCK_TAGS, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

export function readUrlTool(reader: LinkReader): ToolDescriptor<{ url: string }> {
  return {
    name: 'web.read_url',
    modelName: 'read_url',
    description: '打开一个网页链接，读出它的标题和正文。对方发来链接、想让你看看内容时用；要查资料而手上没有具体链接时不要用。小红书、抖音、需要登录的页面通常打不开，打不开就照实说。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整的网页链接' } },
      required: ['url']
    },
    source: 'local',
    risk: 'read',
    phases: ['reply'],
    handler: async (input, context) => {
      const result = await reader.read(input.url, context?.signal);
      return [
        result.title ? `标题：${result.title}` : '',
        `链接：${result.url}`,
        '',
        result.text,
        result.truncated ? '\n（正文太长，只读了前面一部分）' : ''
      ].filter((line, index) => line !== '' || index === 2).join('\n');
    }
  };
}
