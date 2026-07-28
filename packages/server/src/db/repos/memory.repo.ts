import type { DbLike } from '../handle.js';
import type { MemoryRecord } from '../../core/types.js';
import { newMemoryId, nowIso } from '../../util/ids.js';

export type MemoryKind = MemoryRecord['kind'];

interface MemoryRow {
  id: string;
  rowid?: number;
  kind: MemoryKind;
  content: string;
  normalized: string;
  importance: number;
  confidence: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  hits: number;
  embedding: Buffer | null;
  embedding_dim: number | null;
  embedding_model: string | null;
  active: number;
}

export interface UpsertMemoryInput {
  kind: MemoryKind;
  content: string;
  importance?: number;
  confidence?: number;
  expiresAt?: string | null;
  sourceMessageId?: string | null;
}

export function normalizeMemoryText(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[.,!?;:，。！？；：、"'\u201c\u201d\u2018\u2019()（）]/g, '')
      .replace(/[\s\u3000]+/g, ' ')
      // Whitespace around CJK carries no meaning; drop it so "喜欢 猫" and
      // "喜欢猫" dedupe to the same memory.
      .replace(/(?<=[\u3000-\u9fff\uf900-\ufaff])\s+(?=[\u3000-\u9fff\uf900-\ufaff])/g, '')
      .trim()
  );
}

export function floatsToBuffer(vec: number[]): Buffer {
  const arr = new Float32Array(vec);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function bufferToFloats(buf: Buffer): number[] {
  const copy = Buffer.from(buf);
  const arr = new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
  return Array.from(arr);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class MemoryRepo {
  constructor(private readonly db: DbLike) {}

  /** Insert or merge with an existing memory with the same normalized text. */
  upsert(input: UpsertMemoryInput): { record: MemoryRecord; merged: boolean } {
    const normalized = normalizeMemoryText(input.content);
    const existing = this.db.prepare('SELECT * FROM memories WHERE normalized = ? AND active = 1').get(normalized) as
      | MemoryRow
      | undefined;
    const ts = nowIso();
    if (existing) {
      this.db
        .prepare(
          `UPDATE memories SET importance = MAX(importance, ?), confidence = MIN(1, MAX(confidence, ?)),
             updated_at = ?, expires_at = COALESCE(?, expires_at) WHERE id = ?`
        )
        .run(input.importance ?? 0.5, input.confidence ?? 0.6, ts, input.expiresAt ?? null, existing.id);
      if (input.sourceMessageId) this.addSource(existing.id, input.sourceMessageId);
      return { record: this.toRecord(this.rowById(existing.id)!), merged: true };
    }
    const id = newMemoryId();
    this.db
      .prepare(
        `INSERT INTO memories (id, kind, content, normalized, importance, confidence, created_at, updated_at, expires_at, hits, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`
      )
      .run(
        id,
        input.kind,
        input.content,
        normalized,
        input.importance ?? 0.5,
        input.confidence ?? 0.6,
        ts,
        ts,
        input.expiresAt ?? null
      );
    if (input.sourceMessageId) this.addSource(id, input.sourceMessageId);
    return { record: this.toRecord(this.rowById(id)!), merged: false };
  }

  addSource(memoryId: string, messageId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO memory_sources(memory_id, message_id, created_at) VALUES (?, ?, ?)')
      .run(memoryId, messageId, nowIso());
  }

  setEmbedding(id: string, vector: number[], model: string): void {
    this.db
      .prepare('UPDATE memories SET embedding = ?, embedding_dim = ?, embedding_model = ? WHERE id = ?')
      .run(floatsToBuffer(vector), vector.length, model, id);
  }

  rowById(id: string): MemoryRow | undefined {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.rowById(id);
    return row ? this.toRecord(row) : undefined;
  }

  list(opts: { limit?: number; offset?: number; kind?: MemoryKind; includeInactive?: boolean } = {}): MemoryRecord[] {
    const limit = Math.min(opts.limit ?? 100, 500);
    const offset = opts.offset ?? 0;
    const where: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeInactive) where.push('active = 1');
    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    const sql = `SELECT * FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY importance DESC, updated_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return (this.db.prepare(sql).all(...params) as MemoryRow[]).map((r) => this.toRecord(r));
  }

  /** All active, non-expired memories with embeddings of the given dimension. */
  activeWithEmbeddings(dim: number): Array<{ row: MemoryRow; vector: number[] }> {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE active = 1 AND embedding IS NOT NULL AND embedding_dim = ?
          AND (expires_at IS NULL OR expires_at > ?)`
      )
      .all(dim, nowIso()) as MemoryRow[];
    return rows.map((row) => ({ row, vector: bufferToFloats(row.embedding!) }));
  }

  /**
   * Lexical recall over the FTS5 trigram index.
   * The trigram tokenizer needs terms of at least 3 characters, so short
   * queries are widened into overlapping 3-grams; anything shorter falls back
   * to LIKE so a 1-2 character query still returns something sensible.
   */
  searchFts(query: string, limit = 10): MemoryRecord[] {
    const terms = buildTrigramTerms(query);
    if (terms.length > 0) {
      const match = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
      try {
        const rows = this.db
          .prepare(
            `SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
             WHERE memories_fts MATCH ? AND m.active = 1 AND (m.expires_at IS NULL OR m.expires_at > ?)
             ORDER BY rank LIMIT ?`
          )
          .all(match, nowIso(), limit) as MemoryRow[];
        if (rows.length > 0) return rows.map((r) => this.toRecord(r));
      } catch {
        /* fall through to LIKE */
      }
    }
    return this.searchOverlap(query, limit);
  }

  /**
   * Bigram-overlap fallback.
   * Trigram FTS cannot connect "还记得我的猫吗" to "用户养了一只叫布丁的猫" because
   * they share no 3-character window. This scan scores shared 2-grams over the
   * active memory set, which stays cheap for a single-user deployment.
   */
  searchOverlap(query: string, limit = 10): MemoryRecord[] {
    const qGrams = ngrams(query, 2);
    if (qGrams.size === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY importance DESC LIMIT 2000`
      )
      .all(nowIso()) as MemoryRow[];
    const scored: Array<{ row: MemoryRow; score: number }> = [];
    for (const row of rows) {
      const mGrams = ngrams(row.content, 2);
      if (mGrams.size === 0) continue;
      let shared = 0;
      for (const g of qGrams) if (mGrams.has(g)) shared++;
      if (shared === 0) continue;
      // Jaccard-ish score, nudged by importance so strong facts win ties.
      const score = shared / Math.min(qGrams.size, mGrams.size) + row.importance * 0.1;
      scored.push({ row, score });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => this.toRecord(s.row));
  }

  bumpHits(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare('UPDATE memories SET hits = hits + 1 WHERE id = ?');
    const tx = this.db.transaction((list: string[]) => list.forEach((id) => stmt.run(id)));
    tx(ids);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  /** Hard purge: memories, sources, FTS index, summaries. */
  clearAll(): { memories: number; summaries: number } {
    const tx = this.db.transaction(() => {
      const memories = (this.db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;
      const summaries = (this.db.prepare('SELECT COUNT(*) c FROM summaries').get() as { c: number }).c;
      this.db.prepare('DELETE FROM memory_sources').run();
      this.db.prepare('DELETE FROM memories').run();
      this.db.prepare('DELETE FROM summaries').run();
      this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
      this.db.prepare("DELETE FROM jobs WHERE type IN ('memory.extract','memory.embed','summary.build')").run();
      return { memories, summaries };
    });
    return tx();
  }

  purgeExpired(): number {
    return this.db.prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?').run(nowIso()).changes;
  }

  count(activeOnly = true): number {
    const sql = activeOnly ? 'SELECT COUNT(*) c FROM memories WHERE active = 1' : 'SELECT COUNT(*) c FROM memories';
    return (this.db.prepare(sql).get() as { c: number }).c;
  }

  countWithEmbeddings(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM memories WHERE embedding IS NOT NULL AND active = 1').get() as { c: number })
      .c;
  }

  sources(memoryId: string): string[] {
    return (
      this.db.prepare('SELECT message_id FROM memory_sources WHERE memory_id = ? ORDER BY created_at').all(memoryId) as Array<{
        message_id: string;
      }>
    ).map((r) => r.message_id);
  }

  toRecord(row: MemoryRow): MemoryRecord {
    return {
      id: row.id,
      kind: row.kind,
      content: row.content,
      importance: row.importance,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      hits: row.hits,
      sources: this.sources(row.id),
      hasEmbedding: !!row.embedding
    };
  }
}

/**
 * Turn arbitrary user text into FTS5 trigram search terms.
 * Latin words of 3+ chars are used as-is; CJK runs are exploded into
 * overlapping 3-character windows.
 */
export function buildTrigramTerms(query: string, maxTerms = 24): string[] {
  const cleaned = query.replace(/["'*^()]/g, ' ');
  const chunks = cleaned.split(/[\s\u3000,.;:!?，。！？；：、\n]+/).filter(Boolean);
  const terms = new Set<string>();
  for (const chunk of chunks) {
    if (/^[\w-]+$/.test(chunk)) {
      if (chunk.length >= 3) terms.add(chunk.toLowerCase());
      continue;
    }
    const chars = [...chunk];
    if (chars.length < 3) continue;
    for (let i = 0; i + 3 <= chars.length; i++) {
      terms.add(chars.slice(i, i + 3).join(''));
      if (terms.size >= maxTerms) return [...terms];
    }
  }
  return [...terms].slice(0, maxTerms);
}

/** Character n-grams, ignoring whitespace and punctuation. */
export function ngrams(text: string, n: number): Set<string> {
  const cleaned = text.toLowerCase().replace(/[\s\u3000,.;:!?，。！？；：、"'()（）\n]+/g, '');
  const chars = [...cleaned];
  const out = new Set<string>();
  if (chars.length < n) {
    if (chars.length > 0) out.add(chars.join(''));
    return out;
  }
  for (let i = 0; i + n <= chars.length; i++) out.add(chars.slice(i, i + n).join(''));
  return out;
}
