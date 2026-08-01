import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
afterEach(async () => { if (h) await h.cleanup(); });

describe('message history search and date navigation', () => {
  it('searches Chinese and English text across message parts and returns snippets', async () => {
    h = await createHarness({ startWorkers: false });
    const first = h.app.repos.messages.create({ role: 'user', parts: [{ type: 'text', text: '今天去北京看展览' }, { type: 'text', text: 'museum notes' }] }).message;
    h.app.repos.messages.create({ role: 'assistant', parts: [{ type: 'text', text: '上海的天气很好' }] });

    const zh = await h.app.server.inject({ method: 'GET', url: '/api/messages/search?q=北京' });
    expect(zh.statusCode).toBe(200);
    expect(zh.json().hits.map((hit: { message: { id: string } }) => hit.message.id)).toContain(first.id);
    expect(zh.json().hits[0].snippet).toContain('北京');

    const en = await h.app.server.inject({ method: 'GET', url: '/api/messages/search?q=museum' });
    expect(en.statusCode).toBe(200);
    expect(en.json().hits[0].matchedPartId).toBeTruthy();
  });

  it('returns messages in a local calendar day using the requested IANA timezone', async () => {
    h = await createHarness({ startWorkers: false });
    const localDay = h.app.repos.messages.create({ role: 'user', parts: [{ type: 'text', text: '东京日期' }] }).message;
    const outside = h.app.repos.messages.create({ role: 'user', parts: [{ type: 'text', text: '前一天' }] }).message;
    h.app.db.raw.prepare('UPDATE messages SET created_at = ?, updated_at = ? WHERE id = ?').run('2026-07-31T15:30:00.000Z', '2026-07-31T15:30:00.000Z', localDay.id);
    h.app.db.raw.prepare('UPDATE messages SET created_at = ?, updated_at = ? WHERE id = ?').run('2026-07-31T14:59:59.000Z', '2026-07-31T14:59:59.000Z', outside.id);

    const res = await h.app.server.inject({ method: 'GET', url: '/api/messages/by-date?date=2026-08-01&timeZone=Asia%2FTokyo' });
    expect(res.statusCode).toBe(200);
    expect(res.json().messages.map((message: { id: string }) => message.id)).toEqual([localDay.id]);
  });

  it('rejects invalid search and date queries without touching SQLite', async () => {
    h = await createHarness({ startWorkers: false });
    expect((await h.app.server.inject({ method: 'GET', url: '/api/messages/search?q=' })).statusCode).toBe(400);
    expect((await h.app.server.inject({ method: 'GET', url: '/api/messages/by-date?date=not-a-date' })).statusCode).toBe(400);
    expect((await h.app.server.inject({ method: 'GET', url: '/api/messages/by-date?date=2026-08-01&timeZone=No%2FSuch_Zone' })).statusCode).toBe(400);
  });
});
