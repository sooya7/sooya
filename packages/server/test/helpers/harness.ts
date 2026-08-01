import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { buildApp, type SooyaApp } from '../../src/app.js';

export const ASSETS_DIR = fileURLToPath(new URL('../../../../assets/stickers/', import.meta.url));

export interface FakeChatOptions {
  /** Text chunks streamed back for each successive chat call. */
  script?: string[][];
  /** Force an error for chat requests. */
  chatError?: Error;
  /** Delay before the stream starts, to simulate slow models. */
  delayMs?: number;
  /** Answer 400 "no image input" whenever a request carries an image part. */
  rejectImages?: boolean;
  /** Answer 400 "response_format not supported" whenever the request asks for JSON mode. */
  rejectJsonMode?: boolean;
  /**
   * Full control over a chat response, called before the built-in behaviours.
   * Return null to fall through to `chatError` / `rejectImages` / the script.
   */
  respond?: (ctx: { body: unknown; index: number }) => Response | null;
}

export interface FakeProviderState {
  chatCalls: Array<{ body: unknown; url: string }>;
  discoverCalls: string[];
  discoverHeaders: Array<Record<string, string>>;
  imageCalls: number;
  ttsCalls: number;
  embedCalls: number;
}

export interface HarnessOptions {
  env?: Record<string, string>;
  chat?: FakeChatOptions;
  /** Enable a fake image provider that returns a real PNG. */
  image?: 'ok' | 'fail' | 'off';
  tts?: 'ok' | 'fail' | 'off';
  embedding?: 'ok' | 'fail' | 'off';
  /** Fixed dimension for the fake embedding provider. */
  embeddingDim?: number;
  skipStickerImport?: boolean;
  startWorkers?: boolean;
  /** Reply for GET <baseUrl>/models, used by the model-discovery route. */
  discover?: { status?: number; payload?: unknown } | 'network-error' |
    ((ctx: { url: string; index: number }) => Response | Promise<Response>);
  /** Pins the life engine's clock; see BuildAppOptions.clock. */
  clock?: () => Date;
}

export interface Harness {
  app: SooyaApp;
  dir: string;
  state: FakeProviderState;
  /** Replace the scripted chat responses at runtime. */
  setChatScript: (script: string[][]) => void;
  setChatError: (err: Error | null) => void;
  setImageMode: (mode: 'ok' | 'fail' | 'off') => void;
  setTtsMode: (mode: 'ok' | 'fail' | 'off') => void;
  cleanup: () => Promise<void>;
}

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** A tiny but structurally valid MP3 (silence), used by the fake TTS. */
export function makeFakeMp3(frames = 40): Buffer {
  // 128kbps 44.1kHz mono layer III frames of zeroes: 417 bytes each (+padding 0)
  const frameLen = 417;
  const out: Buffer[] = [];
  for (let i = 0; i < frames; i++) {
    const f = Buffer.alloc(frameLen);
    f[0] = 0xff;
    f[1] = 0xfb; // MPEG1 Layer3, no CRC
    f[2] = 0x90; // 128kbps, 44100Hz, no padding
    f[3] = 0xc0;
    out.push(f);
  }
  return Buffer.concat(out);
}

export function makeFakeWav(seconds = 2, sampleRate = 16000): Buffer {
  const n = Math.round(seconds * sampleRate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), 44 + i * 2);
  return buf;
}

export const TEST_PNG = PNG_1x1;

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        const payload = JSON.stringify({ choices: [{ delta: { content: c } }] });
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sooya-test-'));
  const state: FakeProviderState = { chatCalls: [], discoverCalls: [], discoverHeaders: [], imageCalls: 0, ttsCalls: 0, embedCalls: 0 };

  let script = opts.chat?.script ?? [['好的。']];
  let chatError: Error | null = opts.chat?.chatError ?? null;
  let imageMode = opts.image ?? 'off';
  let ttsMode = opts.tts ?? 'off';
  const embeddingMode = opts.embedding ?? 'off';
  const embeddingDim = opts.embeddingDim ?? 8;
  let callIndex = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body && typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;

    if (url.endsWith('/models')) {
      const index = state.discoverCalls.push(url) - 1;
      const requestHeaders = new Headers(init?.headers);
      state.discoverHeaders[index] = { authorization: requestHeaders.get('authorization') ?? '', 'new-api-user': requestHeaders.get('new-api-user') ?? '' };
      if (typeof opts.discover === 'function') return opts.discover({ url, index });
      if (opts.discover === 'network-error') throw new Error('socket hang up');
      const spec = opts.discover === undefined || opts.discover === 'network-error' ? {} : opts.discover;
      return new Response(JSON.stringify(spec.payload ?? { data: [{ id: 'zeta-2' }, { id: 'alpha-1' }] }), {
        status: spec.status ?? 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (url.includes('/chat/completions')) {
      state.chatCalls.push({ body, url });
      if (opts.chat?.delayMs) await new Promise((r) => setTimeout(r, opts.chat!.delayMs));
      if (opts.chat?.respond) {
        const custom = opts.chat.respond({ body, index: state.chatCalls.length - 1 });
        if (custom) return custom;
      }
      if (chatError) throw chatError;
      if (opts.chat?.rejectImages && JSON.stringify(body).includes('image_url')) {
        return new Response(JSON.stringify({ error: { message: 'This model does not support image input', type: 'invalid_request_error' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (opts.chat?.rejectJsonMode && (body as { response_format?: unknown } | null)?.response_format) {
        return new Response(
          JSON.stringify({ error: { message: "Unsupported parameter: 'response_format' is not supported by this model", type: 'invalid_request_error' } }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }
      const chunks = script[Math.min(callIndex++, script.length - 1)] ?? ['好的。'];
      const isStream = (body as { stream?: boolean } | null)?.stream === true;
      if (!isStream) {
        return new Response(JSON.stringify({ choices: [{ message: { content: chunks.join('') } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return sseResponse(chunks);
    }
    if (url.includes('/images/generations') || url.includes('/images/edits')) {
      state.imageCalls++;
      if (imageMode === 'fail') return new Response('image backend exploded', { status: 500 });
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_1x1.toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/audio/speech')) {
      state.ttsCalls++;
      if (ttsMode === 'fail') return new Response('tts backend exploded', { status: 500 });
      const mp3 = makeFakeMp3();
      return new Response(new Uint8Array(mp3), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    if (url.includes('/embeddings')) {
      state.embedCalls++;
      if (embeddingMode === 'fail') return new Response('embedding backend exploded', { status: 500 });
      const inputs = (body as { input?: string[] } | null)?.input ?? [''];
      const vectors = inputs.map((text) => deterministicVector(String(text), embeddingDim));
      return new Response(JSON.stringify({ model: 'fake-embed', data: vectors.map((embedding, index) => ({ embedding, index })) }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response('unexpected url in test: ' + url, { status: 404 });
  };

  const models = {
    chat: {
      provider: 'openai-chat',
      baseUrl: 'https://fake.example.com/v1',
      apiKey: 'sk-test-key-000000',
      model: 'fake-chat',
      supportsVision: true,
      supportsStreaming: true,
      maxRetries: 0,
      timeoutMs: 5000
    },
    embedding:
      embeddingMode === 'off'
        ? { provider: 'none' }
        : {
            provider: 'openai-embeddings',
            baseUrl: 'https://fake.example.com/v1',
            apiKey: 'sk-test-key-000000',
            model: 'fake-embed',
            dimensions: embeddingDim,
            maxRetries: 0
          },
    image:
      imageMode === 'off'
        ? { provider: 'none' }
        : {
            provider: 'openai-images',
            baseUrl: 'https://fake.example.com/v1',
            apiKey: 'sk-test-key-000000',
            model: 'fake-image',
            maxRetries: 0,
            timeoutMs: 5000
          },
    tts:
      ttsMode === 'off'
        ? { provider: 'none' }
        : {
            provider: 'openai-tts',
            baseUrl: 'https://fake.example.com/v1',
            apiKey: 'sk-test-key-000000',
            model: 'fake-tts',
            format: 'mp3',
            maxRetries: 0,
            timeoutMs: 5000
          },
  };
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'models.json'), JSON.stringify(models, null, 2));

  const app = await buildApp({
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: path.join(dir, 'data'),
      CONFIG_DIR: path.join(dir, 'config'),
      WEB_DIR: path.join(dir, 'nonexistent-web'),
      ENABLE_BACKGROUND_JOBS: 'false',
      ALLOW_PRIVATE_NETWORK_FETCH: 'true',
      ...(opts.env ?? {})
    },
    logger: pino({ level: 'silent' }),
    clock: opts.clock,
    fetchImpl,
    assetsDir: ASSETS_DIR,
    skipStickerImport: opts.skipStickerImport,
    startWorkers: opts.startWorkers ?? false,
    replyDebounceMs: 0
  });

  return {
    app,
    dir,
    state,
    setChatScript: (s) => {
      script = s;
      callIndex = 0;
    },
    setChatError: (e) => {
      chatError = e;
    },
    setImageMode: (m) => {
      imageMode = m;
    },
    setTtsMode: (m) => {
      ttsMode = m;
    },
    cleanup: async () => {
      await app.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };
}

function deterministicVector(text: string, dim: number): number[] {
  // Simple hashed bag-of-chars so semantically identical strings match exactly
  // and different strings differ — enough for deterministic recall tests.
  const vec = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[text.charCodeAt(i) % dim] += 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map((v) => v / norm);
}

export async function sendText(app: SooyaApp, text: string, clientMsgId?: string) {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/messages/sync',
    payload: { clientMsgId: clientMsgId ?? `c_${Math.random().toString(36).slice(2)}`, content: [{ type: 'text', text }] }
  });
  return { res, body: res.json() as Record<string, any> };
}
