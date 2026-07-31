import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';
import { extractJsonObject } from '../src/util/json-extract.js';
import { parseCandidates } from '../src/core/memory.js';

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.cleanup();
  h = null;
});

const MEMORY_JSON = JSON.stringify({
  worth: true,
  items: [{ kind: 'profile', content: '用户的名字是小明', importance: 0.9, confidence: 0.9 }]
});

const bodies = (state: Harness['state']) => state.chatCalls.map((c) => c.body as Record<string, unknown>);
const jsonModeCalls = (state: Harness['state']) => bodies(state).filter((b) => b?.response_format);

/**
 * `supportsVision` had the same shape of bug (#34): config declares a capability,
 * the real endpoint does not have it, and the turn dies. JSON mode is worse
 * because nothing visible breaks -- the extraction just throws, the caller
 * falls back to regex heuristics, and the memory/world pipeline quietly stops
 * doing its job. These tests pin the failure that used to be invisible.
 */
describe('endpoint without JSON mode', () => {
  it('still extracts memories when the endpoint rejects response_format', async () => {
    h = await createHarness({
      chat: { rejectJsonMode: true, script: [['知道啦'], [MEMORY_JSON]] }
    });
    await sendText(h.app, '我叫小明，住在上海');
    await h.app.services.worker.drain();

    const memories = h.app.repos.memories.list({});
    expect(memories.map((m) => m.content).join()).toContain('小明');

    // The rejected attempt carried response_format; the retry dropped it and
    // moved the constraint into the system prompt instead.
    expect(jsonModeCalls(h.state).length).toBe(1);
    const retry = bodies(h.state).at(-1)!;
    expect(retry.response_format).toBeUndefined();
    expect(JSON.stringify(retry.messages)).toContain('第一个字符必须是');
  });

  it('records the unsupported endpoint once instead of failing silently', async () => {
    h = await createHarness({ chat: { rejectJsonMode: true, script: [['嗯'], [MEMORY_JSON]] } });
    await sendText(h.app, '我叫小明，是个后端工程师');
    await h.app.services.worker.drain();
    const logged = h.app.repos.errors.list(50).filter((e) => e.message === 'json_mode_unsupported');
    // Both extractors ask for JSON mode, and each says it once -- not once per turn.
    expect(logged.length).toBeGreaterThan(0);
    expect(new Set(logged.map((e) => e.scope)).size).toBe(logged.length);
    expect(logged.every((e) => /^(memory|world)\.extract$/.test(e.scope))).toBe(true);
  });

  it('stops sending response_format after the first refusal', async () => {
    h = await createHarness({
      chat: { rejectJsonMode: true, script: [['好'], [MEMORY_JSON], ['好'], [MEMORY_JSON]] }
    });
    await sendText(h.app, '我喜欢喝美式咖啡', 'json-1');
    await h.app.services.worker.drain();
    const afterFirst = jsonModeCalls(h.state).length;
    await sendText(h.app, '我在做一个叫 sooya 的项目', 'json-2');
    await h.app.services.worker.drain();

    // The provider learned it once; the second turn must not pay for it again.
    expect(jsonModeCalls(h.state).length).toBe(afterFirst);
    expect(h.app.repos.memories.count()).toBeGreaterThan(0);
  });

  it('keeps native JSON mode when the endpoint accepts it', async () => {
    h = await createHarness({ chat: { script: [['好的'], [MEMORY_JSON]] } });
    await sendText(h.app, '我叫小明');
    await h.app.services.worker.drain();
    expect(jsonModeCalls(h.state).length).toBeGreaterThan(0);
    const errors = h.app.repos.errors.list(50).filter((e) => e.message === 'json_mode_unsupported');
    expect(errors).toHaveLength(0);
  });

  it('world extraction survives an answer wrapped in prose', async () => {
    const wrapped = `好的，我分析了这轮对话：\n\`\`\`json\n${JSON.stringify({
      entries: [{ kind: 'fact', subject: '用户', predicate: '养了', object: '一只叫土豆的猫', confidence: 0.9, authority: 'user' }]
    })}\n\`\`\`\n以上就是提取结果。`;
    h = await createHarness({ chat: { rejectJsonMode: true, script: [[wrapped]] } });
    const candidates = await h.app.services.world.extractCandidates('我养了一只猫叫土豆', '好可爱');
    expect(candidates.map((c) => c.object).join()).toContain('土豆');
  });
});

describe('extractJsonObject', () => {
  it('parses a clean object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('ignores prose around the object', () => {
    expect(extractJsonObject('当然可以！结果如下：{"worth":true,"items":[]} 需要我再解释吗？')).toEqual({ worth: true, items: [] });
  });

  it('reads a fenced block that is not at the start', () => {
    expect(extractJsonObject('分析：\n```json\n{"a":[1,2]}\n```\n完成')).toEqual({ a: [1, 2] });
  });

  it('drops a reasoning block whose braces are not the answer', () => {
    const raw = '<think>用户说了名字，也许应该输出 {"worth":false}？不，值得记。</think>{"worth":true,"items":[{"content":"x"}]}';
    expect(extractJsonObject(raw)).toEqual({ worth: true, items: [{ content: 'x' }] });
  });

  it('tolerates a trailing comma', () => {
    expect(extractJsonObject('{"items":[1,2,],}')).toEqual({ items: [1, 2] });
  });

  it('recovers the complete items from output cut off mid-write', () => {
    const truncated = '{"worth":true,"items":[{"kind":"profile","content":"用户住在上海"},{"kind":"prefer';
    expect(extractJsonObject(truncated)).toEqual({ worth: true, items: [{ kind: 'profile', content: '用户住在上海' }] });
  });

  it('keeps braces that belong inside strings', () => {
    expect(extractJsonObject('{"content":"他说 {不算数}"}')).toEqual({ content: '他说 {不算数}' });
  });

  it('returns null when there is no object at all', () => {
    expect(extractJsonObject('抱歉，我没有找到值得记住的信息。')).toBeNull();
  });
});

describe('parseCandidates leniency', () => {
  it('accepts an answer the endpoint wrapped in prose and a fence', () => {
    const raw = `好的：\n\`\`\`json\n${MEMORY_JSON}\n\`\`\``;
    const out = parseCandidates(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('小明');
  });

  it('still returns nothing for a plain refusal', () => {
    expect(parseCandidates('这轮对话没有值得长期记住的信息。')).toEqual([]);
  });
});
