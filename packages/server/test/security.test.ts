import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, sendText, TEST_PNG, type Harness } from './helpers/harness.js';

let h: Harness;
afterEach(async () => {
  if (h) await h.cleanup();
});

const CHAT_TOKEN = 'chat-token-abcdefgh';
const ADMIN_TOKEN = 'admin-token-12345678';

describe('WEB_CHAT_TOKEN', () => {
  it('rejects chat API access without a token', async () => {
    h = await createHarness({ env: { WEB_CHAT_TOKEN: CHAT_TOKEN } });
    for (const url of ['/api/messages', '/api/conversation', '/api/stickers', '/api/stream']) {
      const res = await h.app.server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
    const post = await h.app.server.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { clientMsgId: 'x', content: [{ type: 'text', text: 'hi' }] }
    });
    expect(post.statusCode).toBe(401);
  });

  it('accepts the token via headers but rejects query credentials', async () => {
    h = await createHarness({ env: { WEB_CHAT_TOKEN: CHAT_TOKEN } });
    const variants = [
      { headers: { 'x-sooya-token': CHAT_TOKEN } },
      { headers: { authorization: `Bearer ${CHAT_TOKEN}` } }
    ];
    for (const v of variants) {
      const res = await h.app.server.inject({ method: 'GET', url: '/api/conversation', headers: v.headers });
      expect(res.statusCode).toBe(200);
    }
    const query = await h.app.server.inject({ method: 'GET', url: `/api/conversation?token=${CHAT_TOKEN}` });
    expect(query.statusCode).toBe(401);
  });

  it('protects media with header credentials and never accepts query credentials', async () => {
    h = await createHarness({ env: { WEB_CHAT_TOKEN: CHAT_TOKEN, ADMIN_API_TOKEN: ADMIN_TOKEN } });
    const stored = await h.app.services.mediaStore.save({
      kind: 'image',
      origin: 'upload',
      data: TEST_PNG,
      declaredMime: 'image/png',
      filename: 'protected.png'
    });
    const path = `/api/media/${stored.id}`;
    expect((await h.app.server.inject({ method: 'GET', url: path })).statusCode).toBe(401);
    expect((await h.app.server.inject({ method: 'GET', url: `${path}?token=${CHAT_TOKEN}` })).statusCode).toBe(401);
    expect((await h.app.server.inject({ method: 'GET', url: `${path}?admin_token=${ADMIN_TOKEN}` })).statusCode).toBe(401);
    const chatResponse = await h.app.server.inject({
      method: 'GET',
      url: path,
      headers: { authorization: `Bearer ${CHAT_TOKEN}` }
    });
    expect(chatResponse.statusCode).toBe(200);
    expect(chatResponse.headers['cache-control']).toBe('private, no-store');
    expect(chatResponse.headers['content-type']).toBe('image/png');
    expect((await h.app.server.inject({
      method: 'GET',
      url: path,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    })).statusCode).toBe(200);
  });

  it('rejects a wrong token of the same length', async () => {
    h = await createHarness({ env: { WEB_CHAT_TOKEN: CHAT_TOKEN } });
    const res = await h.app.server.inject({
      method: 'GET',
      url: '/api/conversation',
      headers: { 'x-sooya-token': 'chat-token-abcdefgX' }
    });
    expect(res.statusCode).toBe(401);
  });

  it('leaves health endpoints open so deployment probes work', async () => {
    h = await createHarness({ env: { WEB_CHAT_TOKEN: CHAT_TOKEN } });
    for (const url of ['/health/live', '/health/ready']) {
      const res = await h.app.server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      // No secret may leak through the health payload.
      expect(res.body).not.toContain(CHAT_TOKEN);
    }
  });

  it('is open when no token is configured (local single-user mode)', async () => {
    h = await createHarness();
    expect((await h.app.server.inject({ method: 'GET', url: '/api/conversation' })).statusCode).toBe(200);
  });
});

describe('ADMIN_API_TOKEN', () => {
  it('is fail-closed when the token is not configured', async () => {
    h = await createHarness();
    const res = await h.app.server.inject({ method: 'GET', url: '/api/admin/persona' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('admin_disabled');
  });

  it('rejects admin calls without the admin token', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN, WEB_CHAT_TOKEN: CHAT_TOKEN } });
    const withChatToken = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/persona',
      headers: { 'x-sooya-token': CHAT_TOKEN }
    });
    expect(withChatToken.statusCode).toBe(401);
    const withChatBearer = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/persona',
      headers: { authorization: `Bearer ${CHAT_TOKEN}` }
    });
    expect(withChatBearer.statusCode).toBe(401);
    const ok = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/persona',
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    expect(ok.statusCode).toBe(200);
    const query = await h.app.server.inject({
      method: 'GET',
      url: `/api/admin/persona?admin_token=${ADMIN_TOKEN}`
    });
    expect(query.statusCode).toBe(401);
  });

  it('protects every admin write route', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN } });
    const writes: Array<[string, string]> = [
      ['PUT', '/api/admin/persona'],
      ['PUT', '/api/admin/models'],
      ['PUT', '/api/admin/tts'],
      ['PUT', '/api/admin/image'],
      ['POST', '/api/admin/memories/clear'],
      ['POST', '/api/admin/chat/clear'],
      ['POST', '/api/admin/backups'],
      ['DELETE', '/api/admin/errors']
    ];
    for (const [method, url] of writes) {
      const res = await h.app.server.inject({ method: method as never, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('API keys never reach the client', () => {
  it('redacts keys from the admin models endpoint', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN } });
    const res = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/models',
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('sk-test-key-000000');
    expect(res.json().models.chat.apiKeyConfigured).toBe(true);
    expect(res.json().models.chat.apiKey).toBeUndefined();
  });

  it('never exposes keys through capabilities or system status', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN } });
    const caps = await h.app.server.inject({ method: 'GET', url: '/api/capabilities' });
    expect(caps.body).not.toContain('sk-test-key');
    const sys = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/system',
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    expect(sys.body).not.toContain('sk-test-key');
  });

  it('does not write plaintext keys into the error log payload', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN } });
    h.setChatError(new Error('request failed for key sk-test-key-000000'));
    await sendText(h.app, '你好');
    const res = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/errors',
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    // The message is stored, but the reply to the browser must not carry a live key.
    const body = res.body;
    expect(body).toContain('request failed');
    expect(body).not.toContain('sk-test-key-000000');
  });
});

describe('upload limits and MIME enforcement', () => {
  it('rejects a file larger than the configured limit', async () => {
    h = await createHarness({ env: { MAX_UPLOAD_BYTES: '2048' } });
    const big = Buffer.alloc(8192, 1);
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(big)], { type: 'application/octet-stream' }), 'big.bin');
    const res = await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form });
    expect([413, 415]).toContain(res.statusCode);
    expect(h.app.repos.media.list(50).filter((m) => m.origin === 'upload')).toHaveLength(0);
  });

  it('rejects a disguised executable claiming to be a PNG', async () => {
    h = await createHarness();
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(2048, 0x90)]);
    const form = new FormData();
    form.set('image', new Blob([new Uint8Array(elf)], { type: 'image/png' }), 'evil.png');
    const res = await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form });
    expect(res.statusCode).toBe(415);
    expect(res.json().failed[0].code).toMatch(/TYPE_NOT_ALLOWED|UNKNOWN_TYPE/);
  });

  it('rejects an SVG uploaded as an image (script injection vector)', async () => {
    h = await createHarness();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const form = new FormData();
    form.set('image', new Blob([new Uint8Array(svg)], { type: 'image/svg+xml' }), 'x.svg');
    const res = await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form });
    expect(res.statusCode).toBe(415);
  });

  it('accepts a genuine PNG and stores the sniffed MIME, not the claimed one', async () => {
    h = await createHarness();
    const form = new FormData();
    form.set('image', new Blob([new Uint8Array(TEST_PNG)], { type: 'application/x-lies' }), 'real.png');
    const res = await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form });
    expect(res.statusCode).toBe(200);
    expect(res.json().media[0].mime).toBe('image/png');
  });

  it('caps the number of files per request', async () => {
    h = await createHarness({ env: { MAX_UPLOAD_FILES: '2' } });
    const form = new FormData();
    for (let i = 0; i < 4; i++) {
      form.append('images', new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' }), `f${i}.png`);
    }
    const res = await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form });
    const saved = res.statusCode === 200 ? res.json().media.length : 0;
    expect(saved).toBeLessThanOrEqual(2);
  });
});

describe('path traversal through the media API', () => {
  it('rejects traversal attempts in the media id', async () => {
    h = await createHarness();
    const secret = path.join(h.dir, 'secret.txt');
    fs.writeFileSync(secret, 'TOP SECRET');
    const attacks = [
      '../../../../etc/passwd',
      '..%2f..%2fsecret.txt',
      '%2e%2e%2f%2e%2e%2fsecret.txt',
      'sooya/../../../secret.txt'
    ];
    for (const a of attacks) {
      const res = await h.app.server.inject({ method: 'GET', url: `/api/media/${encodeURIComponent(a)}` });
      expect([400, 404], a).toContain(res.statusCode);
      expect(res.body).not.toContain('TOP SECRET');
    }
  });

  it('does not serve files outside the media root even with a crafted db row', async () => {
    h = await createHarness();
    const outside = path.join(h.dir, 'outside.txt');
    fs.writeFileSync(outside, 'SHOULD NOT BE SERVED');
    h.app.db
      .prepare(
        `INSERT INTO media(id, kind, rel_path, mime, bytes, sha256, origin, created_at, meta_json)
         VALUES ('evilmedia', 'file', '../../outside.txt', 'text/plain', 10, 'x', 'upload', ?, '{}')`
      )
      .run(new Date().toISOString());
    const res = await h.app.server.inject({ method: 'GET', url: '/api/media/evilmedia' });
    expect([400, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain('SHOULD NOT BE SERVED');
  });
});

describe('SSRF protection on outbound calls', () => {
  it('refuses to fetch a generated image from a private address', async () => {
    h = await createHarness({ image: 'ok', env: { ALLOW_PRIVATE_NETWORK_FETCH: 'false' } });
    // Point the image provider at an internal host.
    h.app.config.setModels({
      image: {
        provider: 'openai-images',
        baseUrl: 'http://169.254.169.254/latest',
        apiKey: 'k',
        model: 'm',
        maxRetries: 0
      }
    });
    h.app.services.capabilities.rebuild();
    await expect(h.app.services.capabilities.imageProvider().generate('x')).rejects.toThrow(/private address|SsrfError/i);
  });

  it('refuses a file:// model endpoint', async () => {
    h = await createHarness({ env: { ALLOW_PRIVATE_NETWORK_FETCH: 'false' } });
    h.app.config.setModels({
      chat: { provider: 'openai-chat', baseUrl: 'file:///etc', apiKey: 'k', model: 'm', maxRetries: 0 }
    });
    h.app.services.capabilities.rebuild();
    await expect(
      h.app.services.capabilities.chatProvider().complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })
    ).rejects.toThrow(/protocol not allowed/i);
  });
});

describe('request body limits', () => {
  it('rejects an oversized JSON body', async () => {
    h = await createHarness({ env: { MAX_BODY_BYTES: '1024' } });
    const res = await h.app.server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'content-type': 'application/json' },
      payload: { clientMsgId: 'big', content: [{ type: 'text', text: 'x'.repeat(5000) }] }
    });
    expect(res.statusCode).toBe(413);
  });

  it('rejects text longer than the schema allows', async () => {
    h = await createHarness();
    const res = await h.app.server.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { clientMsgId: 'toolong', content: [{ type: 'text', text: 'x'.repeat(20001) }] }
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a reference to a nonexistent media id', async () => {
    h = await createHarness();
    const res = await h.app.server.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { clientMsgId: 'ghost', content: [{ type: 'image', mediaId: 'media_does_not_exist' }] }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_media');
  });
});

describe('admin API surface', () => {
  it('reads and updates the persona without exposing multi-persona switching', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN } });
    const get = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/persona',
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    expect(get.json().persona.name).toBe('SOOYA');

    const put = await h.app.server.inject({
      method: 'PUT',
      url: '/api/admin/persona',
      headers: { 'x-admin-token': ADMIN_TOKEN },
      payload: { speakingStyle: '更简短一点' }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().persona.speakingStyle).toBe('更简短一点');
    // Persisted to disk atomically.
    const onDisk = JSON.parse(fs.readFileSync(h.app.config.personaPath, 'utf8'));
    expect(onDisk.speakingStyle).toBe('更简短一点');
  });

  it('updates the model configuration and rebuilds capabilities', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN }, tts: 'off' });
    expect(h.app.services.capabilities.has('tts')).toBe(false);
    const res = await h.app.server.inject({
      method: 'PUT',
      url: '/api/admin/tts',
      headers: { 'x-admin-token': ADMIN_TOKEN },
      payload: {
        model: { provider: 'openai-tts', baseUrl: 'https://fake.example.com/v1', apiKey: 'sk-new', model: 'tts-1' },
        policy: { frequency: 'high' }
      }
    });
    expect(res.statusCode).toBe(200);
    expect(h.app.services.capabilities.has('tts')).toBe(true);
    expect(h.app.config.getPersona().voicePolicy.frequency).toBe('high');
    expect(res.body).not.toContain('sk-new');
  });

  it('manages stickers', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN } });
    const list = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/stickers',
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    const first = list.json().stickers[0];
    const patch = await h.app.server.inject({
      method: 'PATCH',
      url: `/api/admin/stickers/${first.id}`,
      headers: { 'x-admin-token': ADMIN_TOKEN },
      payload: { enabled: false, tags: ['自定义'] }
    });
    expect(patch.json().sticker.enabled).toBe(false);
    expect(h.app.services.stickerLibrary.available().find((s) => s.id === first.id)).toBeUndefined();

    const del = await h.app.server.inject({
      method: 'DELETE',
      url: `/api/admin/stickers/${first.id}`,
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    expect(del.statusCode).toBe(200);
    expect(h.app.repos.stickers.get(first.id)).toBeUndefined();
  });

  it('clears the chat', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN }, chat: { script: [['清空前']] } });
    await sendText(h.app, '你好');
    expect(h.app.repos.messages.count()).toBe(2);
    const res = await h.app.server.inject({
      method: 'POST',
      url: '/api/admin/chat/clear',
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    expect(res.statusCode).toBe(200);
    expect(h.app.repos.messages.count()).toBe(0);
  });

  it('exposes capability status honestly when nothing is configured', async () => {
    h = await createHarness({ image: 'off', tts: 'off', stt: 'off', embedding: 'off' });
    const res = await h.app.server.inject({ method: 'GET', url: '/api/capabilities' });
    const caps = res.json().capabilities;
    expect(caps.chat.configured).toBe(true);
    expect(caps.image.configured).toBe(false);
    expect(caps.tts.configured).toBe(false);
    expect(caps.stt.configured).toBe(false);
    expect(caps.embedding.configured).toBe(false);
    expect(res.json().agent.active).toBe(false);
  });
});

describe('health checks', () => {
  it('distinguishes live from ready', async () => {
    h = await createHarness();
    const live = await h.app.server.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json().status).toBe('live');

    const ready = await h.app.server.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe('ready');
    expect(ready.json().checks.database.ok).toBe(true);
  });

  it('reports deep health including integrity', async () => {
    h = await createHarness();
    const res = await h.app.server.inject({ method: 'GET', url: '/health/deep' });
    expect(res.statusCode).toBe(200);
    expect(res.json().integrity).toBe('ok');
  });
});
