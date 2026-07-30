import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHarness, sendText, TEST_PNG, makeFakeWav, type Harness } from './helpers/harness.js';
import type { ChatMessage } from '../src/core/types.js';

let h: Harness;

afterEach(async () => {
  if (h) await h.cleanup();
});

function partTypes(msg: ChatMessage): string[] {
  return msg.content.map((p) => p.type);
}

describe('text chat', () => {
  it('stores the user message and a real assistant reply', async () => {
    h = await createHarness({ chat: { script: [['我在', '呢。']] } });
    const { res, body } = await sendText(h.app, '在吗');
    expect(res.statusCode).toBe(200);
    expect(body.message.role).toBe('user');
    expect(body.reply.role).toBe('assistant');
    expect(body.reply.status).toBe('sent');
    const text = body.reply.content.find((p: any) => p.type === 'text');
    expect(text.text).toBe('我在呢。');
    expect(text.status).toBe('sent');
  });

  it('replies are persisted and survive a fresh read', async () => {
    h = await createHarness({ chat: { script: [['持久化测试']] } });
    await sendText(h.app, '你好');
    const res = await h.app.server.inject({ method: 'GET', url: '/api/messages?limit=10' });
    const body = res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content[0].text).toBe('持久化测试');
  });

  it('rejects malformed payloads', async () => {
    h = await createHarness();
    const res = await h.app.server.inject({ method: 'POST', url: '/api/messages', payload: { content: [] } });
    expect(res.statusCode).toBe(400);
  });

  it('boots and answers even with no chat model configured', async () => {
    h = await createHarness({ env: { SOOYA_CHAT_PROVIDER: 'none' } });
    h.app.config.setModels({ chat: { provider: 'none', baseUrl: '', apiKey: '', model: '' } });
    h.app.services.capabilities.rebuild();
    const { body } = await sendText(h.app, '你好');
    expect(body.reply.content.length).toBeGreaterThan(0);
    expect(body.reply.content[0].text).toContain('模型');
    expect(body.outcome.degraded).toContain('chat:not-configured');
  });
});

describe('idempotency and concurrency', () => {
  it('a repeated clientMsgId never creates a second message or reply', async () => {
    h = await createHarness({ chat: { script: [['第一次回复'], ['第二次回复']] } });
    const first = await sendText(h.app, '重复消息', 'dup-1');
    const second = await sendText(h.app, '重复消息', 'dup-1');
    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.message.id).toBe(first.body.message.id);
    const all = h.app.repos.messages.page(50).messages;
    expect(all.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(all.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(h.state.chatCalls).toHaveLength(1);
  });

  it('serializes concurrent sends instead of interleaving replies', async () => {
    h = await createHarness({ chat: { script: [['A'], ['B'], ['C']], delayMs: 20 } });
    await Promise.all([
      sendText(h.app, '第一条', 'c1'),
      sendText(h.app, '第二条', 'c2'),
      sendText(h.app, '第三条', 'c3')
    ]);
    const all = h.app.repos.messages.page(50).messages;
    expect(all.filter((m) => m.role === 'user')).toHaveLength(3);
    expect(all.filter((m) => m.role === 'assistant')).toHaveLength(3);
    // Every assistant message must reference a distinct user message.
    const replyTargets = all.filter((m) => m.role === 'assistant').map((m) => m.replyTo);
    expect(new Set(replyTargets).size).toBe(3);
    // Sequence numbers are unique and dense.
    const seqs = all.map((m) => m.seq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('stickers', () => {
  it('imports the built-in pack as real files', async () => {
    h = await createHarness();
    const stickers = h.app.services.stickerLibrary.available();
    expect(stickers.length).toBeGreaterThanOrEqual(10);
    for (const s of stickers) {
      const media = h.app.repos.media.get(s.mediaId)!;
      expect(h.app.services.mediaStore.exists(media)).toBe(true);
      expect(media.bytes).toBeGreaterThan(100);
    }
    // Formats: at least PNG and GIF are present.
    const mimes = new Set(stickers.map((s) => h.app.repos.media.get(s.mediaId)!.mime));
    expect(mimes.has('image/png')).toBe(true);
    expect(mimes.has('image/gif')).toBe(true);
  });

  it('sends a sticker when the model asks for one', async () => {
    h = await createHarness({ chat: { script: [['哈哈哈太好笑了[[sticker:开心]]']] } });
    const { body } = await sendText(h.app, '我讲个笑话');
    expect(partTypes(body.reply)).toContain('sticker');
    const sticker = body.reply.content.find((p: any) => p.type === 'sticker');
    expect(sticker.status).toBe('sent');
    expect(sticker.media.url).toMatch(/^\/api\/media\//);
  });

  it('sends a sticker when the user asks for one, even with a bland reply', async () => {
    h = await createHarness({ chat: { script: [['好呀']] } });
    const { body } = await sendText(h.app, '发个表情');
    expect(partTypes(body.reply)).toContain('sticker');
  });

  it('never sends a sticker when the user forbids it', async () => {
    h = await createHarness({ chat: { script: [['好的[[sticker:开心]]']] } });
    const { body } = await sendText(h.app, '不要发表情');
    expect(partTypes(body.reply)).not.toContain('sticker');
  });

  it('sticker-only replies carry no text bubble', async () => {
    h = await createHarness({ chat: { script: [['[[sticker-only:开心]]']] } });
    const { body } = await sendText(h.app, '只发表情');
    expect(partTypes(body.reply)).toEqual(['sticker']);
  });

  it('avoids repeating the same sticker back to back', async () => {
    h = await createHarness({ chat: { script: [['[[sticker:开心]]'], ['[[sticker:开心]]'], ['[[sticker:开心]]']] } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { body } = await sendText(h.app, `发个表情 ${i}`, `s${i}`);
      const sticker = body.reply.content.find((p: any) => p.type === 'sticker');
      expect(sticker, `round ${i}`).toBeTruthy();
      ids.push(sticker.meta.stickerId);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it('"换一个表情" always returns a different sticker, even with the repeat window disabled', async () => {
    h = await createHarness({ chat: { script: [['[[sticker:晚安]]'], ['[[sticker:晚安]]']] } });
    // Worst case: rotation is switched off and the hint matches exactly one sticker.
    h.app.config.setPersona({
      stickerPolicy: { enabled: true, frequency: 'medium', maxPerReply: 1, avoidRepeatWindow: 0 }
    });
    const first = await sendText(h.app, '发个晚安表情', 'sw1');
    const firstId = first.body.reply.content.find((p: any) => p.type === 'sticker')?.meta.stickerId;
    expect(firstId).toBeTruthy();

    const second = await sendText(h.app, '换一个表情', 'sw2');
    const secondPart = second.body.reply.content.find((p: any) => p.type === 'sticker');
    expect(secondPart, 'a replacement sticker must still be sent').toBeTruthy();
    expect(secondPart.meta.stickerId).not.toBe(firstId);
  });

  it('does not force a sticker when nothing is available', async () => {
    h = await createHarness({ chat: { script: [['好的[[sticker:开心]]']] }, skipStickerImport: true });
    expect(h.app.services.stickerLibrary.count()).toBe(0);
    const { body } = await sendText(h.app, '发个表情');
    expect(partTypes(body.reply)).not.toContain('sticker');
    expect(partTypes(body.reply)).toContain('text');
  });

  it('reports a sticker as unavailable when its file disappears', async () => {
    h = await createHarness();
    const before = h.app.services.stickerLibrary.count();
    const first = h.app.services.stickerLibrary.available()[0]!;
    const media = h.app.repos.media.get(first.mediaId)!;
    const fs = await import('node:fs/promises');
    await fs.rm(h.app.services.mediaStore.absolutePath(media), { force: true });
    expect(h.app.services.stickerLibrary.count()).toBe(before - 1);
    expect(h.app.services.stickerLibrary.available().find((s) => s.id === first.id)).toBeUndefined();
  });
});

describe('image replies', () => {
  it('generates and stores a real image file', async () => {
    h = await createHarness({ image: 'ok', chat: { script: [['给你画好了[[image:一只戴帽子的猫]]']] } });
    const { body } = await sendText(h.app, '画只猫');
    const image = body.reply.content.find((p: any) => p.type === 'image');
    expect(image).toBeTruthy();
    expect(image.status).toBe('sent');
    const media = h.app.repos.media.get(image.mediaId)!;
    expect(media.origin).toBe('generated');
    expect(h.app.services.mediaStore.exists(media)).toBe(true);
    expect(h.state.imageCalls).toBe(1);
  });

  it('degrades gracefully when image generation fails, keeping the text', async () => {
    h = await createHarness({ image: 'fail', chat: { script: [['这就给你画[[image:小猫]]']] } });
    const { body } = await sendText(h.app, '画只猫');
    const text = body.reply.content.find((p: any) => p.type === 'text');
    const image = body.reply.content.find((p: any) => p.type === 'image');
    expect(text.text).toContain('这就给你画');
    expect(text.status).toBe('sent');
    expect(image.status).toBe('failed');
    expect(image.error).toBeTruthy();
    expect(body.reply.status).toBe('sent');
    expect(body.outcome.degraded.join(',')).toContain('image');
  });

  it('explains itself when image generation is not configured', async () => {
    h = await createHarness({ image: 'off', chat: { script: [['[[image:小猫]]']] } });
    const { body } = await sendText(h.app, '生成一张图片：小猫');
    const image = body.reply.content.find((p: any) => p.type === 'image');
    expect(image.status).toBe('failed');
    expect(image.error).toContain('没有配置');
    // Text must still exist so the user is not left with an empty bubble.
    expect(body.reply.content.some((p: any) => p.type === 'text' && p.status === 'sent')).toBe(true);
  });
});

describe('voice replies', () => {
  it('produces a real audio file with a measured duration', async () => {
    h = await createHarness({ tts: 'ok', chat: { script: [['晚安，好好休息[[voice]]']] } });
    const { body } = await sendText(h.app, '用语音说晚安');
    const audio = body.reply.content.find((p: any) => p.type === 'audio');
    expect(audio.status).toBe('sent');
    expect(audio.transcript).toContain('晚安');
    expect(audio.duration).toBeGreaterThan(0);
    const media = h.app.repos.media.get(audio.mediaId)!;
    expect(media.mime).toBe('audio/mpeg');
    expect(h.app.services.mediaStore.exists(media)).toBe(true);
    // The file must be servable after a restart -> check via the HTTP route.
    const fileRes = await h.app.server.inject({ method: 'GET', url: `/api/media/${media.id}` });
    expect(fileRes.statusCode).toBe(200);
    expect(fileRes.rawPayload.length).toBe(media.bytes);
  });

  it('voice-only hides the text bubble but keeps the transcript', async () => {
    h = await createHarness({ tts: 'ok', chat: { script: [['我很好，你呢[[voice-only]]']] } });
    const { body } = await sendText(h.app, '只发语音');
    expect(partTypes(body.reply)).toEqual(['audio']);
    expect(body.reply.content[0].transcript).toContain('我很好');
  });

  it('never truncates the stored reply when the clip limit is shorter than the text', async () => {
    // maxCharsPerClip caps what is SPOKEN, never what is STORED. In voice-only
    // mode the transcript is the user's only copy, so clipping it would delete
    // content permanently.
    const long = '这是一段很重要的长回复内容。'.repeat(40); // 560 chars > default 300
    h = await createHarness({ tts: 'ok', chat: { script: [[`${long}[[voice-only]]`]] } });
    const { body } = await sendText(h.app, '只发语音');
    const audio = body.reply.content.find((p: any) => p.type === 'audio');
    expect(audio.status).toBe('sent');
    expect(audio.transcript).toHaveLength(long.length);
    expect(audio.meta.clipped).toBe(true);
    expect(audio.meta.spokenChars).toBe(300);
    // Because only part of the text is audible, the text bubble must survive.
    const text = body.reply.content.find((p: any) => p.type === 'text' && p.status === 'sent');
    expect(text?.text).toHaveLength(long.length);
  });

  it('voice-only still hides the text bubble when the whole text fits in one clip', async () => {
    const short = '短短一句话。';
    h = await createHarness({ tts: 'ok', chat: { script: [[`${short}[[voice-only]]`]] } });
    const { body } = await sendText(h.app, '只发语音');
    expect(partTypes(body.reply)).toEqual(['audio']);
    const audio = body.reply.content[0];
    expect(audio.transcript).toBe(short);
    expect(audio.meta.clipped).toBeUndefined();
  });

  it('restores the full text, not the clip, when TTS fails in voice-only mode', async () => {
    const long = '必须完整保留的内容。'.repeat(40); // 400 chars > default 300
    h = await createHarness({ tts: 'fail', chat: { script: [[`${long}[[voice-only]]`]] } });
    const { body } = await sendText(h.app, '只发语音');
    const text = body.reply.content.find((p: any) => p.type === 'text' && p.status === 'sent');
    expect(text.text).toHaveLength(long.length);
  });

  it('falls back to text when TTS fails', async () => {
    h = await createHarness({ tts: 'fail', chat: { script: [['这是要读出来的内容[[voice]]']] } });
    const { body } = await sendText(h.app, '用语音说');
    const text = body.reply.content.find((p: any) => p.type === 'text');
    const audio = body.reply.content.find((p: any) => p.type === 'audio');
    expect(text.text).toContain('这是要读出来的内容');
    expect(text.status).toBe('sent');
    expect(audio.status).toBe('failed');
    expect(body.reply.status).toBe('sent');
  });

  it('voice-only keeps the text when TTS fails (never a silent empty message)', async () => {
    h = await createHarness({ tts: 'fail', chat: { script: [['重要内容[[voice-only]]']] } });
    const { body } = await sendText(h.app, '只发语音');
    const text = body.reply.content.find((p: any) => p.type === 'text' && p.status === 'sent');
    expect(text).toBeTruthy();
    expect(text.text).toContain('重要内容');
  });

  it('does not send voice when the user forbids it', async () => {
    h = await createHarness({ tts: 'ok', chat: { script: [['好的[[voice]]']] } });
    const { body } = await sendText(h.app, '不要发语音');
    expect(partTypes(body.reply)).not.toContain('audio');
    expect(h.state.ttsCalls).toBe(0);
  });
});

describe('combined multimedia replies', () => {
  it('sends text + sticker + image + audio in one message', async () => {
    h = await createHarness({
      image: 'ok',
      tts: 'ok',
      chat: { script: [['当然可以，都给你安排上[[sticker:开心]][[image:一片星空]][[voice]]']] }
    });
    const { body } = await sendText(h.app, '给我发文字表情图片和语音');
    const types = partTypes(body.reply);
    expect(types).toContain('text');
    expect(types).toContain('sticker');
    expect(types).toContain('image');
    expect(types).toContain('audio');
    for (const p of body.reply.content) expect(p.status).toBe('sent');
    // No marker leaked into the visible text.
    expect(body.reply.content.find((p: any) => p.type === 'text').text).not.toContain('[[');
  });
});

describe('user uploads', () => {
  it('accepts an image upload and lets the user send it', async () => {
    h = await createHarness({ chat: { script: [['看到了，很好看']] } });
    const form = new FormData();
    form.set('image', new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' }), 'a.png');
    const upload = await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form });
    expect(upload.statusCode).toBe(200);
    const mediaId = upload.json().media[0].id;

    const res = await h.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: { clientMsgId: 'img-1', content: [{ type: 'text', text: '看这个' }, { type: 'image', mediaId }] }
    });
    const body = res.json();
    expect(body.message.content.map((p: any) => p.type)).toEqual(['text', 'image']);
    expect(body.message.content[1].media.url).toBe(`/api/media/${mediaId}`);
    // The model must have been given the image (vision path).
    const lastCall = h.state.chatCalls.at(-1)!.body as any;
    const userTurn = lastCall.messages.at(-1);
    expect(JSON.stringify(userTurn)).toContain('image_url');
  });

  it('accepts multiple images in a single upload request', async () => {
    h = await createHarness();
    const form = new FormData();
    form.append('images', new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' }), 'a.png');
    form.append('images', new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' }), 'b.png');
    const upload = await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form });
    expect(upload.json().media).toHaveLength(2);
  });

  it('accepts a voice note upload and reports its duration', async () => {
    h = await createHarness();
    const wav = makeFakeWav(3);
    const form = new FormData();
    form.set('voice', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'note.wav');
    const upload = await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form });
    expect(upload.statusCode).toBe(200);
    const media = upload.json().media[0];
    expect(media.kind).toBe('audio');
    expect(media.duration).toBeCloseTo(3, 1);
  });

  it('transcribes an uploaded voice note when STT is configured', async () => {
    h = await createHarness({ stt: 'ok' });
    const form = new FormData();
    form.set('voice', new Blob([new Uint8Array(makeFakeWav(1))], { type: 'audio/wav' }), 'note.wav');
    const mediaId = (await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form })).json().media[0].id;
    const res = await h.app.server.inject({ method: 'POST', url: `/api/media/${mediaId}/transcribe` });
    expect(res.statusCode).toBe(200);
    expect(res.json().transcript).toContain('转写');
    expect(h.app.repos.media.get(mediaId)!.transcript).toContain('转写');
  });

  it('returns 503 for transcription when STT is not configured', async () => {
    h = await createHarness({ stt: 'off' });
    const form = new FormData();
    form.set('voice', new Blob([new Uint8Array(makeFakeWav(1))], { type: 'audio/wav' }), 'note.wav');
    const mediaId = (await h.app.server.inject({ method: 'POST', url: '/api/media', payload: form })).json().media[0].id;
    const res = await h.app.server.inject({ method: 'POST', url: `/api/media/${mediaId}/transcribe` });
    expect(res.statusCode).toBe(503);
  });
});

describe('history pagination', () => {
  it('pages backwards through history without gaps or duplicates', async () => {
    h = await createHarness({ chat: { script: [['ok']] } });
    for (let i = 0; i < 12; i++) await sendText(h.app, `消息 ${i}`, `p${i}`);
    const total = h.app.repos.messages.count();
    expect(total).toBe(24);

    const seen: number[] = [];
    let before: number | null = null;
    let guard = 0;
    for (;;) {
      const url = before === null ? '/api/messages?limit=7' : `/api/messages?limit=7&before=${before}`;
      const page = (await h.app.server.inject({ method: 'GET', url })).json();
      for (const m of page.messages) seen.push(m.seq);
      if (!page.hasMore || page.messages.length === 0) break;
      before = page.messages[0].seq;
      if (++guard > 20) throw new Error('pagination did not terminate');
    }
    const sorted = [...seen].sort((a, b) => a - b);
    expect(new Set(seen).size).toBe(total);
    expect(sorted[0]).toBe(1);
    expect(sorted.at(-1)).toBe(total);
  });

  it('supports fetching only messages after a sequence number', async () => {
    h = await createHarness({ chat: { script: [['ok']] } });
    await sendText(h.app, '第一条', 'a');
    const mid = h.app.repos.messages.maxSeq();
    await sendText(h.app, '第二条', 'b');
    const page = (await h.app.server.inject({ method: 'GET', url: `/api/messages?since=${mid}` })).json();
    expect(page.messages.every((m: any) => m.seq > mid)).toBe(true);
    expect(page.messages).toHaveLength(2);
  });
});

describe('model failures', () => {
  it('never exposes provider-controlled error names in chat degradation state or events', async () => {
    const sensitive = 'sk-provider-name https://provider.example.test C:\\private\\provider.ts';
    const providerError = new Error(`message ${sensitive}`);
    providerError.name = `ProviderFailure ${sensitive}`;
    h = await createHarness();
    h.setChatError(providerError);

    const { res, body } = await sendText(h.app, '触发模型错误', 'provider-name-chat');
    const completed = h.app.services.bus.replay(0).find((event) => event.type === 'reply.completed');
    const publicSurfaces = [
      res.body,
      JSON.stringify(body.reply.content),
      JSON.stringify(body.outcome.degraded),
      JSON.stringify(completed?.payload)
    ];
    for (const surface of publicSurfaces) {
      expect(surface).not.toContain('sk-provider-name');
      expect(surface).not.toContain('provider.example.test');
      expect(surface).not.toContain('C:\\private\\provider.ts');
    }
    expect(body.outcome.degraded).toEqual(['chat:provider_unavailable']);
    expect(completed?.payload.degraded).toEqual(['chat:provider_unavailable']);
  });

  it('uses stable image and audio degradation values for provider-controlled errors', async () => {
    const sensitive = 'sk-media-name https://media.example.test /opt/private/provider.ts';
    const providerError = new Error(`message ${sensitive}`);
    providerError.name = `MediaFailure ${sensitive}`;
    h = await createHarness({
      image: 'ok',
      tts: 'ok',
      chat: { script: [['安全回复[[image:cat]][[voice]]']] }
    });
    (h.app.services.capabilities.imageProvider() as any).generate = async () => {
      throw providerError;
    };
    (h.app.services.capabilities.ttsProvider() as any).synthesize = async () => {
      throw providerError;
    };

    const { res, body } = await sendText(h.app, '生成图片和语音', 'provider-name-media');
    const completed = h.app.services.bus.replay(0).find((event) => event.type === 'reply.completed');
    const publicSurfaces = [
      res.body,
      JSON.stringify(body.reply.content),
      JSON.stringify(body.outcome.degraded),
      JSON.stringify(completed?.payload)
    ];
    for (const surface of publicSurfaces) {
      expect(surface).not.toContain('sk-media-name');
      expect(surface).not.toContain('media.example.test');
      expect(surface).not.toContain('/opt/private/provider.ts');
    }
    expect(body.outcome.degraded).toEqual(['image:provider_unavailable', 'audio:provider_unavailable']);
    expect(completed?.payload.degraded).toEqual(['image:provider_unavailable', 'audio:provider_unavailable']);
  });

  it('contains unexpected reply failure details on every client-visible surface', async () => {
    const sensitive =
      'upstream failure Bearer sk-secret-upstream at https://user:pass@api.example.test/v1?api_key=sk-secret-upstream in C:\\sooya\\private\\provider.ts';
    h = await createHarness();
    (h.app.services.context as any).build = async () => {
      throw new Error(sensitive);
    };

    const { res, body } = await sendText(h.app, '触发失败', 'public-error-1');
    const failedEvent = h.app.services.bus.replay(0).find((event) => event.type === 'reply.failed');
    const publicSurfaces = [res.body, JSON.stringify(body.reply), JSON.stringify(body.outcome), JSON.stringify(failedEvent)];
    for (const surface of publicSurfaces) {
      expect(surface).not.toContain('sk-secret-upstream');
      expect(surface).not.toContain('api.example.test');
      expect(surface).not.toContain('C:\\sooya\\private\\provider.ts');
    }

    expect(body.outcome.error).toMatchObject({
      code: 'reply_failed',
      message: expect.any(String),
      incidentId: expect.stringMatching(/^inc_/)
    });
    expect(body.reply.error).toBe(body.outcome.error.message);
    expect(failedEvent?.payload).toMatchObject({
      code: 'reply_failed',
      incidentId: body.outcome.error.incidentId,
      error: body.outcome.error.message
    });

    const diagnostic = h.app.repos.errors.list(10).find((entry) => entry.scope === 'reply');
    expect(diagnostic).toBeTruthy();
    expect(JSON.stringify(diagnostic)).toContain(body.outcome.error.incidentId);
    expect(JSON.stringify(diagnostic)).toContain('upstream failure');
    expect(JSON.stringify(diagnostic)).not.toContain('sk-secret-upstream');
    expect(JSON.stringify(diagnostic)).not.toContain('C:\\sooya\\private\\provider.ts');
  });

  it('surfaces a timeout as a visible message rather than losing the turn', async () => {
    h = await createHarness({ chat: { script: [['unused']] } });
    h.setChatError(Object.assign(new Error('model request timed out after 5000ms'), { name: 'HttpTimeoutError' }));
    const { body } = await sendText(h.app, '你好');
    expect(body.reply.status).toBe('sent');
    const text = body.reply.content.find((p: any) => p.type === 'text');
    expect(text.text).toMatch(/超时|失败/);
    expect(body.outcome.degraded.join(',')).toContain('chat');
  });

  it('keeps partial text when the stream breaks midway', async () => {
    h = await createHarness({ chat: { script: [['前半段内容']] } });
    const { body: ok } = await sendText(h.app, '第一次', 'x1');
    expect(ok.reply.content[0].text).toBe('前半段内容');
    h.setChatError(new Error('socket hang up'));
    const { body } = await sendText(h.app, '第二次', 'x2');
    expect(body.reply.content.some((p: any) => p.type === 'text' && p.text)).toBe(true);
  });

  it('records the failure in the error log', async () => {
    h = await createHarness();
    h.setChatError(new Error('boom'));
    await sendText(h.app, '你好');
    const errors = h.app.repos.errors.list(10);
    expect(errors.some((e) => e.scope === 'reply.chat')).toBe(true);
  });
});
