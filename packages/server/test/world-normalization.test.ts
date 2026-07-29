import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

describe('stable world identity normalization', () => {
  it('deduplicates Unicode case variants through one persisted identity key', async () => {
    harness = await createHarness();
    const first = harness.app.repos.world.apply([{
      kind: 'fact',
      subject: 'Straße角色',
      predicate: 'IST伙伴',
      object: '同一个设定',
      authority: 'user',
      confidence: 0.8
    }], 'source-1');
    const second = harness.app.repos.world.apply([{
      kind: 'fact',
      subject: 'STRAẞE角色',
      predicate: 'ist伙伴',
      object: '同一个设定',
      authority: 'user',
      confidence: 0.9
    }], 'source-2');

    expect(first.stored).toBe(1);
    expect(second.merged).toBe(1);
    expect(harness.app.repos.world.count(true)).toBe(1);
    const row = harness.app.repos.world.list({ active: true })[0] as unknown as {
      subject_key: string;
      predicate_key: string;
    };
    expect(row.subject_key).toBe('straße角色');
    expect(row.predicate_key).toBe('ist伙伴');
  });

  it('normalizes Turkish and mixed Chinese/English text deterministically', async () => {
    harness = await createHarness();
    harness.app.repos.world.create({
      kind: 'fact',
      subject: 'İstanbul角色',
      predicate: 'OWNER身份',
      object: '设定',
      authority: 'admin'
    });
    const row = harness.app.repos.world.list({ active: true })[0] as unknown as {
      subject_key: string;
      predicate_key: string;
    };
    expect(row.subject_key).toBe('i̇stanbul角色');
    expect(row.predicate_key).toBe('owner身份');
  });
});
