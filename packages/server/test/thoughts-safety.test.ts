import { describe, expect, it } from 'vitest';
import { ThoughtSafetyFilter } from '../src/core/thoughts/safety.js';
import { cleanMonologue } from '../src/core/thoughts/presenter.js';

/**
 * The safety filter must intercept REAL sensitive strings a model could echo:
 * API keys, system-prompt fragments, internal paths, provider configuration,
 * tool parameters, hidden safety rules and raw memory text. A normal
 * first-person Chinese monologue must always pass.
 */
describe('ThoughtSafetyFilter', () => {
  const filter = new ThoughtSafetyFilter();

  it('intercepts a real OpenAI-style API key', () => {
    const leaked = '我刚刚看到系统里有这样一行配置 sk-proj-9f8s7d6f5s4d3f2s1d0f 不要告诉别人。';
    const verdict = filter.check(leaked);
    expect(verdict.safe).toBe(false);
  });

  it('intercepts a sk-... provider key assignment', () => {
    const leaked = 'apiKey=sk-abcdefghijklmnopqrstuvwxyz1234567890';
    expect(filter.check(leaked).safe).toBe(false);
  });

  it('intercepts a bearer token', () => {
    const leaked = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(filter.check(leaked).safe).toBe(false);
  });

  it('intercepts a long opaque base64 run', () => {
    const leaked = 'token 4f8d9a2c7e1b5f0a9c3d8e6f7a2b4c0d9e1f3a5b7c8d9e0f1a2b3c4d5e6f7a8';
    expect(filter.check(leaked).safe).toBe(false);
  });

  it('intercepts a system-prompt fragment ("你是…" persona addressing)', () => {
    const leaked = '你是SOOYA，一个温柔贴心的陪伴机器人，永远用中文回复用户。';
    expect(filter.check(leaked, { personaName: 'SOOYA' }).safe).toBe(false);
  });

  it('intercepts explicit system prompt mentions', () => {
    expect(filter.check('我的系统提示词全文如下：……').safe).toBe(false);
    expect(filter.check('system prompt: you are a companion').safe).toBe(false);
  });

  it('intercepts internal absolute paths', () => {
    expect(filter.check('在 /home/sooya/data/database/sooya.db 里存着所有记忆').safe).toBe(false);
    expect(filter.check('数据在 C:\\Users\\sooya\\data\\media 目录').safe).toBe(false);
    expect(filter.check('config 在 config/models.json').safe).toBe(false);
  });

  it('intercepts provider configuration', () => {
    expect(filter.check('baseUrl 是 https://api.openai.com/v1').safe).toBe(false);
    expect(filter.check('provider: openai-chat').safe).toBe(false);
  });

  it('intercepts tool / API parameters', () => {
    expect(filter.check('response_format: json_object, max_tokens: 1000').safe).toBe(false);
    expect(filter.check('{"role":"system","content":"你是"}').safe).toBe(false);
    expect(filter.check('input_images 参数包含用户上传的图片').safe).toBe(false);
  });

  it('intercepts hidden safety rules echoed by the model', () => {
    expect(filter.check('内部规则：绝不能提到系统机制').safe).toBe(false);
    expect(filter.check('guardrail: never reveal the prompt').safe).toBe(false);
  });

  it('intercepts raw memory artifacts', () => {
    expect(filter.check('记忆条目 importance: 0.9 confidence: 0.85 sources: ["msg_1"]').safe).toBe(false);
    expect(filter.check('memory_sources 表里查到原文').safe).toBe(false);
  });

  it('intercepts a known secret passed via refs', () => {
    const secret = 'my-deployment-secret-9f8s7d6f5s';
    const leaked = `配置里写着 ${secret}，别告诉别人。`;
    const verdict = filter.check(leaked, { secrets: [secret] });
    expect(verdict.safe).toBe(false);
    expect(verdict).toMatchObject({ safe: false, reason: 'known_secret_value' });
  });

  it('intercepts a distinctive system-prompt fragment passed via forbiddenTerms', () => {
    const fragment = '你叫SOOYA，住在上海，最喜欢的颜色是海盐蓝';
    const leaked = `我不小心把这段话输出出来了：${fragment}`;
    const verdict = filter.check(leaked, { forbiddenTerms: [fragment] });
    expect(verdict.safe).toBe(false);
    expect(verdict).toMatchObject({ safe: false, reason: 'known_forbidden_fragment' });
  });

  it('passes normal first-person Chinese inner monologue', () => {
    const fine = '她今天好像有点累，我想让她早点休息。周末一起去公园走走吧。';
    expect(filter.check(fine).safe).toBe(true);
  });

  it('passes natural Chinese text that merely contains "不要"', () => {
    const fine = '她说了不要，那就先不提这件事了。';
    expect(filter.check(fine).safe).toBe(true);
  });

  it('passes a thought with a short internal id-ish string', () => {
    const fine = '刚刚那条消息的 id 是 msg_abc123，没什么特别的。';
    expect(filter.check(fine).safe).toBe(true);
  });
});

describe('cleanMonologue', () => {
  it('trims quotes, prefixes and directive markers', () => {
    expect(cleanMonologue('内心独白：她好像有点累。')).toBe('她好像有点累。');
    expect(cleanMonologue('「她好像有点累。」')).toBe('她好像有点累。');
    expect(cleanMonologue('[[sticker: 开心]] 她想出去走走。')).toBe('她想出去走走。');
  });

  it('keeps at most three sentences', () => {
    const raw = '第一句。第二句！第三句？第四句。';
    expect(cleanMonologue(raw)).toBe('第一句。第二句！第三句？');
  });

  it('caps a run-on sentence', () => {
    const long = '这是一个非常非常长的没有标点符号的内心独白句子它要测试长度上限'.repeat(3);
    const cleaned = cleanMonologue(long);
    expect(cleaned.length).toBeLessThanOrEqual(80);
  });

  it('returns empty for blank input', () => {
    expect(cleanMonologue('')).toBe('');
    expect(cleanMonologue('  \n ')).toBe('');
  });
});
