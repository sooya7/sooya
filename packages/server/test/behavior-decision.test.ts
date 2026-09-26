import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionModelSchema } from '../src/config/schema.js';
import { BehaviorDecisionService, applyBehaviorDecision, decisionEndpoint, explicitMemoryIntent } from '../src/core/behavior-decision.js';
import { parseUserDirectives } from '../src/core/directives.js';
import { safeFetch } from '../src/util/http.js';
vi.mock('../src/util/http.js', () => ({ safeFetch: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const config = (patch = {}) => DecisionModelSchema.parse({ enabled: true, baseUrl: 'https://api.typesafe.ai/v1', apiKey: 'test-key', model: 'jev-latest', ...patch });
function respond(memory = 0.9, image = 0.02, video = 0.01, voice = 0.95) {
  vi.mocked(safeFetch).mockResolvedValue({ response: new Response('{}'), body: Buffer.from(JSON.stringify({ answers: Object.fromEntries(Object.entries({ memory, image, video, voice }).map(([key, noul]) => [key, { type: 'noul', noul }])) })) });
}
describe('System One behavior decisions', () => {
  it.each([
    ['https://api.typesafe.ai', 'https://api.typesafe.ai/v1/systemone'],
    ['https://api.typesafe.ai/v1/', 'https://api.typesafe.ai/v1/systemone'],
    ['https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode', 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone'],
    ['https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/systemone', 'https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/systemone']
  ])('resolves %s', (input, output) => expect(decisionEndpoint(input)).toBe(output));
  it.each(['http://api.typesafe.ai', 'https://key@example.com', 'https://example.com?key=secret'])('rejects unsafe configuration %s', (url) => expect(() => decisionEndpoint(url)).toThrow());
  it.each([
    { provider: 'typesafe', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest' },
    { provider: 'aliyun-beijing', baseUrl: 'https://work.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'decision-model-preview' },
    { provider: 'aliyun-singapore', baseUrl: 'https://work.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', model: 'decision-model-preview' }
  ])('sends one four-question request for $provider', async (patch) => {
    respond();
    const result = await new BehaviorDecisionService(() => config(patch)).evaluate('我喜欢简洁的回答', 'recent');
    expect(result).toMatchObject({ status: 'ok', memory: 'save', media: { image: false, video: false, voice: true } });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(safeFetch).mock.calls[0]!;
    expect(url).toBe(`${patch.baseUrl}/systemone`);
    const body = JSON.parse(opts!.body as string);
    expect(body.model).toBe(patch.model);
    expect(Object.keys(body.questions)).toEqual(['memory', 'image', 'video', 'voice']);
    expect(opts!.headers).toMatchObject({ authorization: 'Bearer test-key' });
    expect(JSON.stringify(result)).not.toContain('test-key');
  });
  it.each([[0.1, 'skip'], [0.55, 'review'], [0.84, 'review'], [0.85, 'save']] as const)('maps memory %s to %s', async (p, memory) => {
    respond(p, 0.6, 0.5, 0.4);
    expect(await new BehaviorDecisionService(() => config()).evaluate('测试消息')).toMatchObject({ memory, media: {} });
  });
  it('preserves explicit save and do-not-save intent', async () => {
    respond(0.01);
    const service = new BehaviorDecisionService(() => config());
    expect((await service.evaluate('记住我不吃辣')).memory).toBe('save');
    respond(1);
    expect((await service.evaluate('不要记住这句话')).memory).toBe('skip');
    expect(explicitMemoryIntent('他说“记住我不吃辣”，这句话怎么翻译')).toBeUndefined();
  });
  it('does not call a provider when disabled or unconfigured', async () => {
    expect((await new BehaviorDecisionService(() => config({ enabled: false })).evaluate('普通消息')).status).toBe('disabled');
    expect((await new BehaviorDecisionService(() => config({ apiKey: '' })).evaluate('普通消息')).status).toBe('unconfigured');
    expect(safeFetch).not.toHaveBeenCalled();
  });
  it('falls back on timeout, malformed answers and HTTP failure without exposing provider content', async () => {
    const service = new BehaviorDecisionService(() => config());
    for (const payload of ['not-json', '{"answers":{}}', JSON.stringify({ answers: { memory: { type: 'noul', noul: 9 } } })]) {
      vi.mocked(safeFetch).mockResolvedValue({ response: new Response('{}'), body: Buffer.from(payload) });
      expect(await service.evaluate('普通消息')).toEqual({ status: 'unavailable', memory: 'review', media: {} });
    }
    vi.mocked(safeFetch).mockRejectedValue(new Error('secret timeout'));
    expect(await service.evaluate('记住我的偏好')).toEqual({ status: 'unavailable', memory: 'save', media: {} });
    vi.mocked(safeFetch).mockResolvedValue({ response: new Response('secret', { status: 401 }), body: Buffer.from('secret') });
    expect((await service.evaluate('普通消息')).status).toBe('unavailable');
  });
  it('propagates cancellation instead of continuing a stale reply', async () => {
    const abort = new AbortController();
    abort.abort(new Error('stale revision'));
    await expect(new BehaviorDecisionService(() => config()).evaluate('消息', '', abort.signal)).rejects.toThrow('stale revision');
    expect(safeFetch).not.toHaveBeenCalled();
  });
  it('bounds the whole request even if the transport stalls before fetch', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(safeFetch).mockImplementation(() => new Promise(() => {}));
      const pending = new BehaviorDecisionService(() => config({ timeoutMs: 250 })).evaluate('消息');
      await vi.advanceTimersByTimeAsync(250);
      expect(await pending).toEqual({ status: 'unavailable', memory: 'review', media: {} });
      expect(vi.mocked(safeFetch).mock.calls[0]![1]!.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('gates autonomous media but preserves explicit requests', () => {
    const model = { imagePrompt: 'cat', videoPrompt: 'cat walking', voice: true };
    const decision = { status: 'ok' as const, memory: 'review' as const, media: { image: false, video: false, voice: false } };
    expect(applyBehaviorDecision(model, {}, decision)).toEqual({});
    expect(applyBehaviorDecision(model, { wantImage: true, wantVideo: true, wantVoice: true }, decision)).toEqual(model);
    expect(applyBehaviorDecision({}, { noVoice: true }, { ...decision, media: { voice: true } })).toEqual({});
    expect(parseUserDirectives('不要生成图片，也别发视频')).toMatchObject({ noImage: true, noVideo: true });
  });
  it('validates threshold ordering', () => expect(() => config({ memoryReviewThreshold: 0.8, memorySaveThreshold: 0.6 })).toThrow());
});
