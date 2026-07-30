import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import { WorldEngine } from '../src/core/world.js';
import type { WorldCandidate } from '../src/db/repos/feature.repo.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

/**
 * Every string below was read out of the production world_entries table on
 * 2026-07-30. 14 of the 29 rows were the assistant's own capability
 * disclaimers, recorded while a feature was mid-debug and then injected into
 * every later prompt as "当前世界状态" -- long after the feature shipped. A row
 * claiming image sending was unavailable was frozen at 07-29T19:14Z, and an
 * image was generated at 07-30T01:40Z, so the entry was actively lying to the
 * model about what it could do.
 *
 * Capability state already has an authoritative live source (the capability
 * registry, surfaced to the prompt as `capabilityNotes`), so the world engine
 * has no business storing a second, frozen, contradictory copy.
 */
const PRODUCTION_SYSTEM_FACTS: Array<[string, string, string]> = [
  ['助手', '图片发送功能当前状态', '暂时不可用，仅能提供文字形式的交互内容'],
  ['助手的图片生成功能', '当前状态为', '暂时不可用'],
  ['助手', '无法调用', '生图工具发送生成的图片'],
  ['当前聊天系统', '有如下表情包管理权限规则', '表情包管理'],
  ['助手', '无需再发送', '被称为“丑丑的圆家伙”的圆形丑表情包'],
  ['助手', '的表情包库存已不再包含', '被称为“丑丑的圆家伙”的圆形丑表情包'],
  ['助手语音功能', '当前状态为', '未调试完成，暂时无法使用'],
  ['助手', '承诺待语音功能调试完成可用后将', '每日向用户发送碎碎念，分享各类小事'],
  ['助手', '当前聊天能力限制为', '无法主动发送自身的语音消息，仅可通过文字与用户交流'],
  ['聊天界面的语音播放/朗读功能', '本质属性为', '聊天客户端独立提供的能力，并非助手主动发送语音消息的体现'],
  ['助手', '当未来具备主动发送自身语音消息的能力时将', '与用户进行语音聊天'],
  ['对话中出现的[语音]标识', '本质为', '文字内的模拟标记，并非可点击播放的真实语音消息'],
  ['当前聊天助手', '能力限制为', '无法主动生成并发送真实语音文件或语音气泡'],
  ['客户端朗读功能', '性质为', '若客户端具备该功能，可朗读助手输出的文字内容，该朗读属于系统行为，并非助手录制发送的语音']
];

/** Also from production. These are what the world engine is *for*. */
const PRODUCTION_REAL_FACTS: Array<[string, string, string]> = [
  ['黄白柯基玩偶', '存在于', '当前对话场景'],
  ['荔枝气泡水', '存在于', '当前对话场景'],
  ['沙发', '存在于', '当前对话场景'],
  ['助手角色', '拥有', '兔子发箍'],
  ['SOOYA', '是', '当前用户的专属AI伙伴'],
  ['SOOYA', '专属陪伴对象为', '当前用户']
];

function candidate([subject, predicate, object]: [string, string, string]): WorldCandidate {
  return { kind: 'fact', subject, predicate, object, confidence: 0.7, authority: 'model' };
}

/** A provider that hands the extractor exactly the candidates a test wants. */
function providerReturning(entries: WorldCandidate[]) {
  return {
    configured: true,
    async complete() {
      return { text: JSON.stringify({ entries }), usage: {} };
    }
  };
}

function engineFor(harnessRef: Harness, entries: WorldCandidate[]): WorldEngine {
  const capabilities = { summaryProvider: () => providerReturning(entries) };
  return new WorldEngine(
    harnessRef.app.repos.world,
    capabilities as never,
    harnessRef.app.repos.errors,
    harnessRef.app.repos.messages
  );
}

describe('world engine rejects volatile system and capability state', () => {
  it('stores none of the 14 capability disclaimers found in production', async () => {
    harness = await createHarness();
    const world = engineFor(harness, PRODUCTION_SYSTEM_FACTS.map(candidate));

    const result = await world.extract('你能发语音吗', '我的语音功能暂时不可用', null);

    // Against the unfixed extractor this stores all 14.
    expect(result.stored).toBe(0);
    expect(harness.app.repos.world.count(true)).toBe(0);
  });

  it('still stores the real world state it exists to remember', async () => {
    harness = await createHarness();
    const world = engineFor(harness, PRODUCTION_REAL_FACTS.map(candidate));

    const result = await world.extract('你还记得柯基玩偶吗', '记得呀，就在沙发上', null);

    expect(result.stored).toBe(PRODUCTION_REAL_FACTS.length);
  });

  it('keeps a roleplay fact about the assistant that is not about its plumbing', async () => {
    harness = await createHarness();
    // "助手角色" is the character, not the software. A subject match alone must
    // not be enough to drop a row, or the character's own state disappears.
    const world = engineFor(harness, [
      candidate(['助手角色', '喜欢', '荔枝气泡水']),
      candidate(['助手角色', '拥有', '兔子发箍'])
    ]);

    const result = await world.extract('你喜欢喝什么', '荔枝气泡水！', null);

    expect(result.stored).toBe(2);
  });

  it('drops the disclaimers but keeps the real facts when both arrive together', async () => {
    harness = await createHarness();
    const world = engineFor(harness, [
      candidate(['助手语音功能', '当前状态为', '未调试完成，暂时无法使用']),
      candidate(['黄白柯基玩偶', '存在于', '当前对话场景']),
      candidate(['助手', '无法调用', '生图工具发送生成的图片']),
      candidate(['助手角色', '拥有', '兔子发箍'])
    ]);

    const result = await world.extract('随便聊聊', '好呀', null);

    expect(result.stored).toBe(2);
    const kept = harness.app.repos.world.list({ active: true }).map((row) => row.subject).sort();
    expect(kept).toEqual(['助手角色', '黄白柯基玩偶']);
  });

  it('does not filter what an admin deliberately imports', async () => {
    harness = await createHarness();
    const world = engineFor(harness, []);

    // An operator restoring a backup gets exactly what they asked for; the
    // filter guards the *extractor*, which is where the junk comes from.
    const imported = world.import({
      version: 1,
      entries: [{ kind: 'fact', subject: '助手语音功能', predicate: '当前状态为', object: '可用', authority: 'admin' }]
    });

    expect(imported.stored).toBe(1);
  });
});
