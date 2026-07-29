import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

describe('literal world search', () => {
  it('treats percent, underscore and backslash as text instead of LIKE wildcards', async () => {
    harness = await createHarness();
    const literalPercent = harness.app.repos.world.create({
      kind: 'fact', subject: '进度100%确定', predicate: '状态', object: '字面百分号', authority: 'user'
    });
    harness.app.repos.world.create({
      kind: 'fact', subject: '进度1000确定', predicate: '状态', object: '不应匹配百分号', authority: 'user'
    });
    const literalUnderscore = harness.app.repos.world.create({
      kind: 'fact', subject: '代号A_B', predicate: '状态', object: '字面下划线', authority: 'user'
    });
    harness.app.repos.world.create({
      kind: 'fact', subject: '代号ACB', predicate: '状态', object: '不应匹配下划线', authority: 'user'
    });
    const literalSlash = harness.app.repos.world.create({
      kind: 'fact', subject: String.raw`路径A\B`, predicate: '状态', object: '字面反斜杠', authority: 'user'
    });

    expect(harness.app.repos.world.list({ search: '100%' }).map((row) => row.id)).toEqual([literalPercent.id]);
    expect(harness.app.repos.world.list({ search: 'A_B' }).map((row) => row.id)).toEqual([literalUnderscore.id]);
    expect(harness.app.repos.world.list({ search: String.raw`A\B` }).map((row) => row.id)).toEqual([literalSlash.id]);
    expect(harness.app.repos.world.list({ search: '进度' }).map((row) => row.id)).toEqual(
      expect.arrayContaining([literalPercent.id])
    );

    expect(harness.app.repos.world.relevant('100%', 10).map((row) => row.id)).toEqual([literalPercent.id]);
    expect(harness.app.repos.world.relevant('A_B', 10).map((row) => row.id)).toEqual([literalUnderscore.id]);
  });
});
