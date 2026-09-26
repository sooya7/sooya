import { afterEach, describe, expect, it, vi } from 'vitest';
import { BehaviorDecisionService, type BehaviorDecision } from '../src/core/behavior-decision.js';
import { createHarness, type Harness } from './helpers/harness.js';
import type { ChatMessage } from '../src/core/types.js';
let h: Harness | null = null;
afterEach(async () => { await h?.cleanup(); h = null; vi.restoreAllMocks(); });
const decision = (patch: Partial<BehaviorDecision> = {}): BehaviorDecision => ({ status: 'ok', memory: 'skip', media: { image: false, video: false, voice: false }, ...patch });
async function say(text: string) {
  const response = await h!.app.server.inject({ method: 'POST', url: '/api/messages/sync', payload: { clientMsgId: `decision-${Math.random()}`, content: [{ type: 'text', text }] } });
  expect(response.statusCode).toBe(200);
  return response.json().reply as ChatMessage;
}
describe('behavior decisions in the real reply pipeline', () => {
  it('suppresses unsolicited media and skips the memory job after publication', async () => {
    vi.spyOn(BehaviorDecisionService.prototype, 'evaluate').mockResolvedValue(decision());
    h = await createHarness({ image: 'ok', video: 'ok', tts: 'ok', chat: { script: [['我在这里。[[image:小猫]][[video:海浪]][[voice]]']] } });
    const enqueue = vi.spyOn(h.app.repos.jobs, 'enqueue');
    const reply = await say('今天过得如何');
    expect(reply.content.filter((p) => p.type !== 'text')).toHaveLength(0);
    expect(h.state.imageCalls).toBe(0);
    expect(h.state.ttsCalls).toBe(0);
    expect(h.app.services.video.list().total).toBe(0);
    expect(enqueue.mock.calls.some(([kind]) => kind === 'memory.extract' || kind === 'ombre.memory_commit')).toBe(false);
    expect(h.app.repos.messages.get(reply.id)?.meta?.behaviorDecision).toMatchObject({ memory: 'skip' });
    expect(JSON.stringify(h.state.chatCalls[0]?.body)).toContain('本轮表达决策');
  });
  it('honors explicitly requested images despite a negative model score', async () => {
    vi.spyOn(BehaviorDecisionService.prototype, 'evaluate').mockResolvedValue(decision({ memory: 'save' }));
    h = await createHarness({ image: 'ok', chat: { script: [['好呀。[[image:一只小猫]]']] } });
    const enqueue = vi.spyOn(h.app.repos.jobs, 'enqueue');
    const reply = await say('画一张小猫');
    expect(h.state.imageCalls).toBe(1);
    expect(reply.content.some((p) => p.type === 'image')).toBe(true);
    expect(enqueue.mock.calls.some(([kind]) => kind === 'memory.extract' || kind === 'ombre.memory_commit')).toBe(true);
  });
  it('retains normal reply and memory extraction when the service fails', async () => {
    vi.spyOn(BehaviorDecisionService.prototype, 'evaluate').mockResolvedValue(decision({ status: 'unavailable', memory: 'review', media: {} }));
    h = await createHarness({ chat: { script: [['正常回复。']] } });
    const enqueue = vi.spyOn(h.app.repos.jobs, 'enqueue');
    const reply = await say('我喜欢简洁的回复');
    expect(reply.content.some((p) => p.text === '正常回复。')).toBe(true);
    expect(enqueue.mock.calls.some(([kind]) => kind === 'memory.extract' || kind === 'ombre.memory_commit')).toBe(true);
  });
  it('honors user media prohibitions even if both models suggest media', async () => {
    vi.spyOn(BehaviorDecisionService.prototype, 'evaluate').mockResolvedValue(decision({ media: { image: true, video: true, voice: true } }));
    h = await createHarness({ image: 'ok', video: 'ok', chat: { script: [['好的。[[image:小猫]][[video:小猫跑步]]']] } });
    await say('不要生成图片，也别发视频');
    expect(h.state.imageCalls).toBe(0);
    expect(h.app.services.video.list().total).toBe(0);
  });
  it('saves and redacts provider configuration and restricts the test endpoint to admins', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const headers = { 'x-admin-token': 'admin-test-token' };
    const save = await h.app.server.inject({ method: 'PUT', url: '/api/admin/models', headers, payload: { decision: { enabled: true, provider: 'typesafe', model: 'jev-latest', baseUrl: 'https://api.typesafe.ai/v1', apiKey: 'test-private-decision-key' } } });
    expect(save.statusCode).toBe(200);
    expect(save.body).not.toContain('test-private-decision-key');
    expect(save.json().models.decision.apiKeyConfigured).toBe(true);
    await h.app.server.inject({ method: 'PUT', url: '/api/admin/models', headers, payload: { decision: { timeoutMs: 1500 } } });
    expect(h.app.config.getModels().decision.apiKey).toBe('test-private-decision-key');
    const spy = vi.spyOn(BehaviorDecisionService.prototype, 'evaluate').mockResolvedValue(decision());
    const denied = await h.app.server.inject({ method: 'POST', url: '/api/admin/behavior-decision/test', payload: { text: '测试' } });
    expect(denied.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    const test = await h.app.server.inject({ method: 'POST', url: '/api/admin/behavior-decision/test', headers, payload: { text: '测试' } });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ ok: true });
    expect(spy).toHaveBeenCalledWith('测试', '', undefined, true);
    const invalid = await h.app.server.inject({ method: 'POST', url: '/api/admin/behavior-decision/test', headers, payload: { text: '' } });
    expect(invalid.statusCode).toBe(400);
  });
});
