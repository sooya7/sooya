import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, TEST_PNG, type Harness } from './helpers/harness.js';
import { signEventBody, signValidationResponse, verifyEventSignature } from '../src/channels/qq/verify.js';
import { QQ_OP_ACK, type QqPayload } from '../src/channels/qq/types.js';
import type { ChatMessage } from '../src/core/types.js';

let h: Harness;

afterEach(async () => {
  if (h) await h.cleanup();
});

const SECRET = 'test-callback-secret-2026';
const APP_ID = '102000000';
const OWNER = 'owner-openid-uuid';

async function qqHarness(overrides: Record<string, string> = {}, options: Parameters<typeof createHarness>[0] = {}) {
  return createHarness({
    ...options,
    chat: options.chat ?? { script: [['在的，我在。']] },
    env: {
      QQ_BOT_ENABLED: 'true',
      QQ_APP_ID: APP_ID,
      QQ_APP_SECRET: 'app-secret',
      QQ_CALLBACK_SECRET: SECRET,
      QQ_ALLOWED_USERS: OWNER,
      ...(options.env ?? {}),
      ...overrides
    }
  });
}

function c2cPayload(overrides: Record<string, unknown> = {}): QqPayload {
  return {
    id: 'evt-1',
    op: 0,
    s: 1,
    t: 'C2C_MESSAGE_CREATE',
    d: { id: 'msg-1', author: { user_openid: OWNER }, content: '在吗', timestamp: '2026-08-18T00:00:00+08:00' },
    ...overrides
  };
}

async function postCallback(
  payload: QqPayload,
  opts: { timestamp?: string; signature?: string; secret?: string } = {}
) {
  const body = JSON.stringify(payload);
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = opts.signature ?? signEventBody(opts.secret ?? SECRET, timestamp, Buffer.from(body));
  return h!.app.server.inject({
    method: 'POST',
    url: '/api/qq/callback',
    headers: {
      'content-type': 'application/json',
      'x-signature-timestamp': timestamp,
      'x-signature-ed25519': signature
    },
    payload: body
  });
}

async function waitForAssistant(timeoutMs = 5000): Promise<ChatMessage | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const assistant = h!.app.repos.messages.recent(10).find((m) => m.role === 'assistant');
    if (assistant) return assistant;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

describe('QQ webhook callback', () => {
  it('accepts a signed C2C text event and produces a user message + reply', async () => {
    h = await qqHarness();
    const res = await postCallback(c2cPayload());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ op: QQ_OP_ACK });

    const users = h.app.repos.messages.page(50).messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]!.clientMsgId).toBe('qq:msg-1');
    expect(users[0]!.content[0].text).toBe('在吗');

    const identity = h.app.repos.channelIdentities.findByUser('qq', OWNER);
    expect(identity?.role).toBe('owner');

    const event = h.app.repos.channelEvents.find('qq', 'evt-1');
    expect(event?.status).toBe('processed');
    expect(event?.remote_message_id).toBe('msg-1');
    expect(event?.message_id).toBe(users[0]!.id);

    const reply = await waitForAssistant();
    expect(reply?.content[0].text).toBe('在的，我在。');
  });

  it('decodes QQ face ext text instead of leaking the protocol tag', async () => {
    h = await qqHarness();
    const ext = Buffer.from(JSON.stringify({ text: '[满头问号]' })).toString('base64');
    await postCallback(c2cPayload({ d: { id: 'msg-face', author: { user_openid: OWNER }, content: `<faceType=4,faceId=\"\",ext=\"${ext}\">` } }));
    const user = h.app.repos.messages.page(20).messages.find((m) => m.role === 'user');
    expect(user?.content[0]?.text).toBe('[QQ表情：满头问号]');
  });

  it('uses a generic QQ face marker when ext has no summary', async () => {
    h = await qqHarness();
    const ext = Buffer.from(JSON.stringify({ text: '' })).toString('base64');
    await postCallback(c2cPayload({ d: { id: 'msg-face-empty', author: { user_openid: OWNER }, content: `<faceType=6,faceId=\"0\",ext=\"${ext}\">` } }));
    const user = h.app.repos.messages.page(20).messages.find((m) => m.role === 'user');
    expect(user?.content[0]?.text).toBe('[QQ表情]');
  });

  it('downloads a QQ image attachment into MediaStore for vision', async () => {
    const url = 'https://qq.example/sticker.png';
    h = await qqHarness({}, { httpFixtures: { [url]: { body: TEST_PNG, contentType: 'image/png' } } });
    await postCallback(c2cPayload({ d: { id: 'msg-image', author: { user_openid: OWNER }, content: '', attachments: [{ content_type: 'image/png', filename: 'sticker.png', url }] } }));
    const user = h.app.repos.messages.page(20).messages.find((m) => m.role === 'user');
    const image = user?.content.find((part) => part.type === 'image');
    expect(image?.mediaId).toBeTruthy();
    expect(image?.media?.mime).toBe('image/png');
  });

  it('recognizes .png when QQ labels the attachment as file', async () => {
    const url = 'https://qq.example/as-file.png';
    h = await qqHarness({}, { httpFixtures: { [url]: { body: TEST_PNG, contentType: 'application/octet-stream' } } });
    await postCallback(c2cPayload({ d: { id: 'msg-file-image', author: { user_openid: OWNER }, content: '', attachments: [{ content_type: 'file', filename: 'as-file.png', url }] } }));
    const user = h.app.repos.messages.page(20).messages.find((m) => m.role === 'user');
    expect(user?.content.some((part) => part.type === 'image')).toBe(true);
  });

  it('keeps text when a QQ attachment download fails', async () => {
    const url = 'https://qq.example/fail.png';
    h = await qqHarness({}, { httpFixtures: { [url]: { body: 'nope', status: 503 } } });
    await postCallback(c2cPayload({ d: { id: 'msg-image-fail', author: { user_openid: OWNER }, content: '文字还在', attachments: [{ content_type: 'image/png', filename: 'fail.png', url }] } }));
    const user = h.app.repos.messages.page(20).messages.find((m) => m.role === 'user');
    expect(user?.content[0]?.text).toBe('文字还在');
    expect(user?.content.some((part) => part.type === 'image')).toBe(false);
  });

  it('treats a replayed event as already consumed (no duplicate message)', async () => {
    h = await qqHarness();
    await postCallback(c2cPayload());
    const second = await postCallback(c2cPayload());
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ op: QQ_OP_ACK });
    expect(h.app.repos.messages.page(50).messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(h.app.repos.channelEvents.countByStatus('qq', 'processed')).toBe(1);
  });

  it('rejects an invalid signature without processing the event', async () => {
    h = await qqHarness();
    const res = await postCallback(c2cPayload(), { signature: 'a'.repeat(128) });
    expect(res.statusCode).toBe(401);
    expect(h.app.repos.messages.page(50).messages.filter((m) => m.role === 'user')).toHaveLength(0);
    expect(h.app.repos.channelEvents.countByStatus('qq', 'received')).toBe(0);
  });

  it('rejects an event signed with an expired timestamp', async () => {
    h = await qqHarness();
    const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const res = await postCallback(c2cPayload(), { timestamp: stale });
    expect(res.statusCode).toBe(401);
    expect(h.app.repos.messages.page(50).messages.filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('rejects an event from a user outside the allowlist', async () => {
    h = await qqHarness();
    const res = await postCallback(c2cPayload({ d: { id: 'msg-intruder', author: { user_openid: 'intruder' }, content: 'hi' } }));
    expect(res.statusCode).toBe(200);
    expect(h.app.repos.messages.page(50).messages.filter((m) => m.role === 'user')).toHaveLength(0);
    const event = h.app.repos.channelEvents.find('qq', 'evt-1');
    expect(event?.status).toBe('rejected');
    expect(event?.error_code).toBe('not_allowed');
    expect(h.app.repos.channelIdentities.list('qq')).toHaveLength(0);
  });

  it('answers op 13 URL validation with a signed echo', async () => {
    h = await qqHarness();
    const eventTs = String(Math.floor(Date.now() / 1000));
    const validation = { id: 'url-verify', op: 13, d: { plain_token: 'token-abc-123', event_ts: eventTs } };
    const res = await h.app.server.inject({
      method: 'POST',
      url: '/api/qq/callback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(validation)
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plain_token).toBe('token-abc-123');
    expect(body.signature).toMatch(/^[0-9a-f]{128}$/u);
    expect(body.signature).toBe(signValidationResponse(SECRET, eventTs, 'token-abc-123'));
    // 平台用同一算法反向校验：signature 必须是对 event_ts + plain_token 的合法签名。
    expect(verifyEventSignature(SECRET, eventTs, body.signature, Buffer.from('token-abc-123'))).toBe(true);
  });

  it('boots with QQ disabled and hides the callback endpoint', async () => {
    h = await createHarness();
    const res = await h.app.server.inject({
      method: 'POST',
      url: '/api/qq/callback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(c2cPayload())
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('resolves a quoted message to the referenced SOOYA message', async () => {
    h = await qqHarness();
    await postCallback(c2cPayload({ id: 'evt-a', d: { id: 'msg-a', author: { user_openid: OWNER }, content: '第一条' } }));
    const first = h.app.repos.messages.page(50).messages.find((m) => m.role === 'user' && m.content[0]?.text === '第一条');
    expect(first).toBeTruthy();

    const quoted = c2cPayload({
      id: 'evt-b',
      d: { id: 'msg-b', author: { user_openid: OWNER }, content: '引用上一条', message_reference: { message_id: 'msg-a' } }
    });
    await postCallback(quoted);
    const second = h.app.repos.messages.page(50).messages.find((m) => m.role === 'user' && m.content[0]?.text === '引用上一条');
    expect(second?.replyTo).toBe(first!.id);
  });
});