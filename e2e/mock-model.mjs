#!/usr/bin/env node
/**
 * Local OpenAI-compatible model used by the browser E2E suite.
 *
 * It is a real HTTP server producing real SSE streams, real PNG bytes and real
 * MP3 frames, so the application code path under test is the production one —
 * only the upstream vendor is replaced.
 *
 * Scripted behaviour is controlled through POST /__control.
 */
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.env.MOCK_PORT ?? 9912);

const state = {
  queue: [],
  fallback: '好的。',
  failChat: false,
  failImage: false,
  failTts: false,
  delayMs: 0,
  chunkDelayMs: 6,
  calls: { chat: 0, image: 0, tts: 0, embedding: 0 }
};

/* ------------------------------ media builders ---------------------------- */

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = (c >>> 8) ^ crcTable[(c ^ b) & 0xff];
  return (c ^ -1) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};

function makePng(w = 320, h = 200) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 4 + 1) + 1 + x * 4;
      raw[i] = Math.round(70 + (150 * x) / w);
      raw[i + 1] = Math.round(120 + (90 * y) / h);
      raw[i + 2] = 220;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** ~3.1s of silent but structurally valid 128kbps/44.1kHz MPEG-1 Layer III. */
function makeMp3(frames = 120) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    const f = Buffer.alloc(417);
    f[0] = 0xff;
    f[1] = 0xfb;
    f[2] = 0x90;
    f[3] = 0xc0;
    out.push(f);
  }
  return Buffer.concat(out);
}

/* --------------------------------- server --------------------------------- */

function embeddingFor(text, dim = 32) {
  const v = new Array(dim).fill(0);
  const s = String(text);
  for (let i = 0; i < s.length; i++) v[s.charCodeAt(i) % dim] += 1;
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / n);
}

const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const url = req.url ?? '';

  if (url === '/__control' && req.method === 'POST') {
    const patch = JSON.parse(body || '{}');
    if (Array.isArray(patch.queue)) state.queue = patch.queue.slice();
    if (typeof patch.fallback === 'string') state.fallback = patch.fallback;
    if (typeof patch.failChat === 'boolean') state.failChat = patch.failChat;
    if (typeof patch.failImage === 'boolean') state.failImage = patch.failImage;
    if (typeof patch.failTts === 'boolean') state.failTts = patch.failTts;
    if (typeof patch.delayMs === 'number') state.delayMs = patch.delayMs;
    if (typeof patch.chunkDelayMs === 'number') state.chunkDelayMs = patch.chunkDelayMs;
    if (patch.resetCalls) state.calls = { chat: 0, image: 0, tts: 0, embedding: 0 };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, state: { ...state, queueLength: state.queue.length } }));
    return;
  }
  if (url === '/__control' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ calls: state.calls, queueLength: state.queue.length }));
    return;
  }

  if (url.includes('/chat/completions')) {
    state.calls.chat++;
    const parsed = JSON.parse(body || '{}');
    const system = String(parsed.messages?.[0]?.content ?? '');
    const isExtraction = system.includes('记忆抽取器');
    const isSummary = system.includes('压缩成简洁');

    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.failChat && !isExtraction && !isSummary) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('model unavailable');
      return;
    }

    let text;
    if (isExtraction) {
      const userLine = String(parsed.messages?.[1]?.content ?? '');
      text = /名字|叫|喜欢|住在/.test(userLine)
        ? JSON.stringify({
            worth: true,
            items: [{ kind: 'profile', content: `记忆：${userLine.slice(0, 60)}`, importance: 0.8, confidence: 0.8 }]
          })
        : JSON.stringify({ worth: false, items: [] });
    } else if (isSummary) {
      text = '这段聊天的要点摘要。';
    } else {
      text = state.queue.length > 0 ? state.queue.shift() : state.fallback;
    }

    if (!parsed.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const ch of [...text]) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, state.chunkDelayMs));
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (url.includes('/images/generations') || url.includes('/images/edits')) {
    state.calls.image++;
    if (state.failImage) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('image backend down');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: makePng().toString('base64') }] }));
    return;
  }

  if (url.includes('/audio/speech')) {
    state.calls.tts++;
    if (state.failTts) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('tts backend down');
      return;
    }
    const buf = makeMp3();
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(buf.length) });
    res.end(buf);
    return;
  }

  if (url.includes('/embeddings')) {
    state.calls.embedding++;
    const parsed = JSON.parse(body || '{}');
    const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'mock-embed',
        data: inputs.map((t, index) => ({ embedding: embeddingFor(t), index }))
      })
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unknown endpoint', url }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-model] listening on http://127.0.0.1:${PORT}`);
});
