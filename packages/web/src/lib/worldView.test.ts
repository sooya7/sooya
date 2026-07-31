import { describe, expect, it } from 'vitest';
import type { WorldEntry } from './features.js';
import { buildGraph, conflictsOf, confidencePercent, groupBySubject, summarize, timelineOf } from './worldView.js';

const entry = (patch: Partial<WorldEntry> & Pick<WorldEntry, 'id' | 'subject' | 'predicate' | 'object'>): WorldEntry => ({
  kind: 'fact',
  confidence: 0.6,
  authority: 'model',
  active: 1,
  ...patch
});

describe('worldView', () => {
  it('groups entries into one card per subject, busiest first', () => {
    const groups = groupBySubject([
      entry({ id: '1', subject: 'SOOYA', predicate: '是', object: '专属AI伙伴', kind: 'entity' }),
      entry({ id: '2', subject: 'SOOYA', predicate: '陪伴对象', object: '当前用户', kind: 'relation' }),
      entry({ id: '3', subject: '沙发', predicate: '存在于', object: '客厅', kind: 'entity' })
    ]);
    expect(groups.map((group) => group.subject)).toEqual(['SOOYA', '沙发']);
    expect(groups[0]?.total).toBe(2);
    // 同一实体内部按类型分组，才不会退化成又一个平铺列表
    expect(groups[0]?.byKind.map((section) => section.kind)).toEqual(['entity', 'relation']);
  });

  it('sorts subjects with the same entry count by name so cards do not jump', () => {
    const groups = groupBySubject([
      entry({ id: '1', subject: '乙', predicate: 'p', object: 'o' }),
      entry({ id: '2', subject: '甲', predicate: 'p', object: 'o' })
    ]);
    expect(groups.map((group) => group.subject)).toEqual(['甲', '乙']);
  });

  it('promotes the strongest authority and counts disabled and conflicting rows per subject', () => {
    const [group] = groupBySubject([
      entry({ id: '1', subject: '助手角色', predicate: '拥有', object: '兔子发箍', authority: 'model' }),
      entry({ id: '2', subject: '助手角色', predicate: '喜欢', object: '荔枝气泡水', authority: 'user' }),
      entry({ id: '3', subject: '助手角色', predicate: '讨厌', object: '荔枝气泡水', active: 0, conflict_of: '2' })
    ]);
    expect(group?.authority).toBe('user');
    expect(group?.disabled).toBe(1);
    expect(group?.conflicts).toBe(1);
  });

  it('falls back to a placeholder subject instead of dropping blank-subject rows', () => {
    const groups = groupBySubject([entry({ id: '1', subject: '  ', predicate: 'p', object: 'o' })]);
    expect(groups[0]?.subject).toBe('未命名');
    expect(groups[0]?.entries).toHaveLength(1);
  });

  it('takes the latest timestamp of the group', () => {
    const [group] = groupBySubject([
      entry({ id: '1', subject: 'A', predicate: 'p', object: 'o', updated_at: '2026-07-01T00:00:00Z' }),
      entry({ id: '2', subject: 'A', predicate: 'q', object: 'o', updated_at: '2026-07-30T00:00:00Z' })
    ]);
    expect(group?.updatedAt).toBe('2026-07-30T00:00:00Z');
  });

  it('draws only relation entries in the graph', () => {
    const graph = buildGraph([
      entry({ id: '1', subject: 'A', predicate: '拥有', object: 'B', kind: 'relation' }),
      // fact 的宾语是一整句话，连成边只会糊成一团
      entry({ id: '2', subject: 'A', predicate: '当前进展', object: '一段很长的叙述', kind: 'fact' })
    ]);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['A', 'B']);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.label).toBe('拥有');
  });

  it('places nodes deterministically on the circle, highest degree first', () => {
    const relations = [
      entry({ id: '1', subject: 'hub', predicate: 'r', object: 'a', kind: 'relation' }),
      entry({ id: '2', subject: 'hub', predicate: 'r', object: 'b', kind: 'relation' }),
      entry({ id: '3', subject: 'hub', predicate: 'r', object: 'c', kind: 'relation' })
    ];
    const first = buildGraph(relations, { radius: 100 });
    const again = buildGraph(relations.slice().reverse(), { radius: 100 });
    expect(first.nodes[0]?.id).toBe('hub');
    expect(first.nodes[0]?.degree).toBe(3);
    expect(first.nodes[0]).toEqual({ id: 'hub', degree: 3, x: 0, y: -100 });
    expect(again.nodes.map((node) => [node.id, node.x, node.y])).toEqual(first.nodes.map((node) => [node.id, node.x, node.y]));
  });

  it('caps the node count and reports how many relations were left out', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      entry({ id: `e${index}`, subject: `s${index}`, predicate: 'r', object: `o${index}`, kind: 'relation' })
    );
    const graph = buildGraph(many, { maxNodes: 10 });
    expect(graph.nodes).toHaveLength(10);
    expect(graph.hidden).toBeGreaterThan(0);
    expect(graph.edges.every((edge) => graph.nodes.includes(edge.from) && graph.nodes.includes(edge.to))).toBe(true);
  });

  it('marks disabled or conflicting relations as weak edges and skips self loops', () => {
    const graph = buildGraph([
      entry({ id: '1', subject: 'A', predicate: 'r', object: 'B', kind: 'relation', active: 0 }),
      entry({ id: '2', subject: 'C', predicate: 'r', object: 'C', kind: 'relation' })
    ]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.weak).toBe(true);
  });

  it('orders the timeline newest first and keeps undated rows last', () => {
    const rows = timelineOf([
      entry({ id: '1', subject: '旧', predicate: 'p', object: 'o', kind: 'timeline', updated_at: '2026-07-01T00:00:00Z' }),
      entry({ id: '2', subject: '新', predicate: 'p', object: 'o', kind: 'scene', updated_at: '2026-07-30T00:00:00Z' }),
      entry({ id: '3', subject: '无时间', predicate: 'p', object: 'o', kind: 'scene' }),
      entry({ id: '4', subject: '事实不进时间线', predicate: 'p', object: 'o', kind: 'fact', updated_at: '2026-07-31T00:00:00Z' })
    ]);
    expect(rows.map((row) => row.subject)).toEqual(['新', '旧', '无时间']);
  });

  it('lists conflict candidates and clamps confidence into a percentage', () => {
    const rows = [
      entry({ id: '1', subject: 'A', predicate: 'p', object: 'o', conflict_of: '9' }),
      entry({ id: '2', subject: 'B', predicate: 'p', object: 'o' })
    ];
    expect(conflictsOf(rows).map((row) => row.id)).toEqual(['1']);
    expect(confidencePercent(entry({ id: '3', subject: 'A', predicate: 'p', object: 'o', confidence: 0.826 }))).toBe(83);
    expect(confidencePercent(entry({ id: '4', subject: 'A', predicate: 'p', object: 'o', confidence: 4 }))).toBe(100);
    expect(confidencePercent(entry({ id: '5', subject: 'A', predicate: 'p', object: 'o', confidence: Number.NaN }))).toBe(0);
  });

  it('summarizes counts used by the header, hiding kinds with nothing in them', () => {
    const summary = summarize([
      entry({ id: '1', subject: 'A', predicate: 'p', object: 'o', kind: 'entity' }),
      entry({ id: '2', subject: 'A', predicate: 'p', object: 'o', kind: 'relation', active: false, conflict_of: '1' }),
      entry({ id: '3', subject: 'B', predicate: 'p', object: 'o', kind: 'entity' })
    ]);
    expect(summary).toMatchObject({ total: 3, active: 2, disabled: 1, conflicts: 1, subjects: 2 });
    expect(summary.byKind.map((item) => [item.kind, item.count])).toEqual([['entity', 2], ['relation', 1]]);
  });
});
