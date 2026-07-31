import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

/**
 * rebuild() 曾经 DELETE FROM world_entries 全表清空再从消息重抽。管理员从面板
 * 或导入写进的条目（authority='admin'）在消息里根本不存在，重抽不回来 —— 一次
 * 重建就把手工世界设定永久毁掉。这些条目不是缓存，重建必须保住它们；只有能从
 * 消息重新提取的 model/user 条目才允许被清掉重来。
 */
describe('world rebuild preserves unrecoverable admin entries', () => {
  it('keeps admin-imported entries while clearing and re-extracting the rest', async () => {
    harness = await createHarness();
    const world = harness.app.services.world;
    const repo = harness.app.repos.world;

    // 管理员导入：消息里不存在，rebuild 无法重新提取
    const imported = world.import({
      version: 1,
      entries: [{ kind: 'fact', subject: '管理员设定', predicate: '禁忌', object: '不许提螃蟹', confidence: 0.9, authority: 'admin' }]
    });
    expect(imported.stored).toBe(1);

    // 普通抽取产物：可从消息恢复，重建时被清掉重来
    repo.create({ kind: 'fact', subject: '天气', predicate: '是', object: '晴' });
    expect(repo.count()).toBe(2);

    // 一条可从消息重新提取的设定（启发式路径：假端点不返回 JSON）
    await sendText(harness.app, '设定：天空是绿色的');

    const result = await world.rebuild();

    expect(result.cleared).toBe(1);

    const adminEntry = repo.list({ search: '管理员设定' });
    expect(adminEntry.length).toBe(1);
    expect(adminEntry[0]!.object).toBe('不许提螃蟹');
    expect(adminEntry[0]!.active).toBe(1);

    // 直接写库的 model 条目不在消息里，被清掉且不复活
    expect(repo.list({ search: '天气' }).length).toBe(0);

    // 消息里的设定被重新提取，证明重建本身仍在工作
    const reextracted = repo.list({ search: '天空是绿色的' });
    expect(reextracted.length).toBe(1);
    expect(reextracted[0]!.active).toBe(1);
  });

  it('does not let re-extracted facts silently replace a preserved admin entry', async () => {
    harness = await createHarness();
    const world = harness.app.services.world;
    const repo = harness.app.repos.world;

    world.import({
      version: 1,
      entries: [{ kind: 'fact', subject: '天空', predicate: '是', object: '蓝色', confidence: 0.95, authority: 'admin' }]
    });
    await sendText(harness.app, '天空是绿色');

    const result = await world.rebuild();

    const active = repo.list({ search: '天空', active: true });
    expect(active.length).toBe(1);
    expect(active[0]!.object).toBe('蓝色');
    expect(active[0]!.authority).toBe('admin');
    // 重抽出的低权威条目只能成为冲突记录，不能顶掉管理员条目
    expect(result.conflicts).toBeGreaterThan(0);
  });
});
