import type { WorldEntry } from './features.js';

/*
 * 世界引擎的界面原来是一条条 `主体 · 关系 → 内容` 平铺，跟「记忆」那个删除列表长得
 * 一模一样，看不出这是一张有结构的世界图：表里存着 kind / confidence / authority /
 * conflict_of，界面一个都没用上。
 *
 * 这里把展示逻辑做成纯函数，组件只负责画：按主体聚合成实体档案、从 relation 条目算出
 * 关系图坐标、把 scene/timeline 排成时间线。布局是确定性的（按度数和名字排序后均匀落在
 * 圆周上），所以同样的数据每次画出来一样，也能直接在单测里断言坐标。
 */

export const WORLD_KIND_LABELS: Record<WorldEntry['kind'], string> = {
  entity: '实体',
  relation: '关系',
  fact: '事实',
  scene: '场景',
  timeline: '时间线'
};

export const AUTHORITY_LABELS: Record<WorldEntry['authority'], string> = {
  admin: '管理员设定',
  user: '用户设定',
  model: '模型推断'
};

const AUTHORITY_RANK: Record<WorldEntry['authority'], number> = { admin: 3, user: 2, model: 1 };

export function isActive(entry: WorldEntry): boolean {
  return entry.active === 1 || entry.active === true;
}

export function confidencePercent(entry: WorldEntry): number {
  const raw = Number(entry.confidence);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw * 100)));
}

export interface WorldGroup {
  subject: string;
  entries: WorldEntry[];
  byKind: Array<{ kind: WorldEntry['kind']; label: string; entries: WorldEntry[] }>;
  total: number;
  disabled: number;
  conflicts: number;
  /** 该实体上最高的权威级别，决定卡片上的标签 */
  authority: WorldEntry['authority'];
  updatedAt: string;
}

/** 按主体聚合成实体档案，条目多的在前，同数量按主体名排序保证稳定。 */
export function groupBySubject(entries: WorldEntry[]): WorldGroup[] {
  const map = new Map<string, WorldEntry[]>();
  for (const entry of entries) {
    const key = entry.subject.trim() || '未命名';
    const list = map.get(key);
    if (list) list.push(entry);
    else map.set(key, [entry]);
  }
  const groups: WorldGroup[] = [];
  for (const [subject, list] of map) {
    const kinds = (Object.keys(WORLD_KIND_LABELS) as Array<WorldEntry['kind']>)
      .map((kind) => ({ kind, label: WORLD_KIND_LABELS[kind], entries: list.filter((entry) => entry.kind === kind) }))
      .filter((section) => section.entries.length > 0);
    groups.push({
      subject,
      entries: list,
      byKind: kinds,
      total: list.length,
      disabled: list.filter((entry) => !isActive(entry)).length,
      conflicts: list.filter((entry) => Boolean(entry.conflict_of)).length,
      authority: list.reduce<WorldEntry['authority']>(
        (best, entry) => (AUTHORITY_RANK[entry.authority] > AUTHORITY_RANK[best] ? entry.authority : best),
        'model'
      ),
      updatedAt: list.reduce((latest, entry) => {
        const value = entry.updated_at ?? entry.created_at ?? '';
        return value > latest ? value : latest;
      }, '')
    });
  }
  groups.sort((a, b) => b.total - a.total || a.subject.localeCompare(b.subject, 'zh-Hans-CN'));
  return groups;
}

export interface GraphNode {
  id: string;
  degree: number;
  x: number;
  y: number;
}

export interface GraphEdge {
  id: string;
  from: GraphNode;
  to: GraphNode;
  label: string;
  weak: boolean;
}

export interface WorldGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hidden: number;
}

/**
 * 关系图。只有 relation 条目连线（fact 的宾语是一句话，连起来没意义）。
 * 节点按度数排序后均匀铺在圆周上，度数高的靠前，所以中心话题在同一侧不会乱跳。
 */
export function buildGraph(entries: WorldEntry[], opts: { maxNodes?: number; radius?: number } = {}): WorldGraph {
  const maxNodes = opts.maxNodes ?? 24;
  const radius = opts.radius ?? 100;
  const relations = entries.filter((entry) => entry.kind === 'relation' && entry.subject.trim() && entry.object.trim());
  const degree = new Map<string, number>();
  for (const entry of relations) {
    for (const name of [entry.subject.trim(), entry.object.trim()]) {
      degree.set(name, (degree.get(name) ?? 0) + 1);
    }
  }
  const ranked = [...degree.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .slice(0, maxNodes);
  const kept = new Set(ranked.map(([name]) => name));
  const nodes: GraphNode[] = ranked.map(([id, deg], index) => {
    const angle = (index / Math.max(1, ranked.length)) * Math.PI * 2 - Math.PI / 2;
    return {
      id,
      degree: deg,
      x: Math.round(Math.cos(angle) * radius * 1000) / 1000,
      y: Math.round(Math.sin(angle) * radius * 1000) / 1000
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: GraphEdge[] = [];
  let hidden = 0;
  for (const entry of relations) {
    const from = byId.get(entry.subject.trim());
    const to = byId.get(entry.object.trim());
    if (!from || !to || from === to) {
      if (!kept.has(entry.subject.trim()) || !kept.has(entry.object.trim())) hidden++;
      continue;
    }
    edges.push({ id: entry.id, from, to, label: entry.predicate, weak: !isActive(entry) || Boolean(entry.conflict_of) });
  }
  return { nodes, edges, hidden };
}

/** 时间线：scene 与 timeline 条目按更新时间倒序，没有时间的排最后。 */
export function timelineOf(entries: WorldEntry[]): WorldEntry[] {
  return entries
    .filter((entry) => entry.kind === 'timeline' || entry.kind === 'scene')
    .slice()
    .sort((a, b) => {
      const left = a.updated_at ?? a.created_at ?? '';
      const right = b.updated_at ?? b.created_at ?? '';
      if (left === right) return a.subject.localeCompare(b.subject, 'zh-Hans-CN');
      if (!left) return 1;
      if (!right) return -1;
      return right.localeCompare(left);
    });
}

/** 冲突候选置顶展示，用户不点进实体也能看见需要裁决的条目。 */
export function conflictsOf(entries: WorldEntry[]): WorldEntry[] {
  return entries.filter((entry) => Boolean(entry.conflict_of));
}

export interface WorldSummary {
  total: number;
  active: number;
  disabled: number;
  conflicts: number;
  subjects: number;
  byKind: Array<{ kind: WorldEntry['kind']; label: string; count: number }>;
}

export function summarize(entries: WorldEntry[]): WorldSummary {
  return {
    total: entries.length,
    active: entries.filter(isActive).length,
    disabled: entries.filter((entry) => !isActive(entry)).length,
    conflicts: conflictsOf(entries).length,
    subjects: new Set(entries.map((entry) => entry.subject.trim() || '未命名')).size,
    byKind: (Object.keys(WORLD_KIND_LABELS) as Array<WorldEntry['kind']>)
      .map((kind) => ({ kind, label: WORLD_KIND_LABELS[kind], count: entries.filter((entry) => entry.kind === kind).length }))
      .filter((item) => item.count > 0)
  };
}
