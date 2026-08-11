import type { DbLike } from '../handle.js';
import type { MemoryRecord } from '../../core/types.js';
import { newMemoryId, nowIso } from '../../util/ids.js';

/** `summary` remains readable for legacy rows, but new ordinary memories may not use it. */
export type MemoryKind = Exclude<MemoryRecord['kind'], 'summary'>;

export interface MemoryRow {
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
  supersedes_id: string | null;
  superseded_by_id: string | null;
  archived_at: string | null;
}

export interface UpsertMemoryInput {
  kind: MemoryKind;
  content: string;
  importance?: number;
  confidence?: number;
  expiresAt?: string | null;
  sourceMessageId?: string | null;
}

export interface MemoryReplacement {
  previous: MemoryRecord;
  replacement: MemoryRecord;
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

  replace(previousId: string, input: UpsertMemoryInput | string): MemoryReplacement {
    return this.supersede(previousId, input);
  }

  supersede(previousId: string, input: UpsertMemoryInput | string): MemoryReplacement {
    const tx = this.db.transaction(() => {
      const previous = this.rowById(previousId);
      if (!previous) throw new Error(`memory ${previousId} not found`);
      if (previous.active !== 1) throw new Error(`memory ${previousId} is not active`);

      const ts = nowIso();
      let replacementId: string;
      if (typeof input === 'string') {
        const existing = this.rowById(input);
        if (!existing) throw new Error(`replacement memory ${input} not found`);
        if (existing.id === previousId) throw new Error('a memory cannot supersede itself');
        if (existing.active !== 1) throw new Error(`replacement memory ${input} is not active`);
        replacementId = existing.id;
      } else {
        replacementId = newMemoryId();
      }

      this.db
        .prepare('UPDATE memories SET active = 0, updated_at = ? WHERE id = ?')
        .run(ts, previousId);

      if (typeof input === 'string') {
        this.db
          .prepare('UPDATE memories SET supersedes_id = ?, updated_at = ? WHERE id = ?')
          .run(previousId, ts, replacementId);
      } else {
        const normalized = normalizeMemoryText(input.content);
        this.db
          .prepare(
            `INSERT INTO memories
              (id, kind, content, normalized, importance, confidence, created_at, updated_at, expires_at, hits, active,
               supersedes_id, superseded_by_id, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, NULL, NULL)`
          )
          .run(
            replacementId,
            input.kind,
            input.content,
            normalized,
            input.importance ?? 0.5,
            input.confidence ?? 0.6,
            ts,
            ts,
            input.expiresAt ?? null,
            previousId
          );
        if (input.sourceMessageId) this.addSource(replacementId, input.sourceMessageId);
      }

      this.db
        .prepare('UPDATE memories SET superseded_by_id = ?, updated_at = ? WHERE id = ?')
        .run(replacementId, ts, previousId);

      return {
        previous: this.toRecord(this.rowById(previousId)!),
        replacement: this.toRecord(this.rowById(replacementId)!)
      };
    });
    return tx() as MemoryReplacement;
  }

  archive(id: string, archivedAt = nowIso()): boolean {
    return this.db
      .prepare("UPDATE memories SET archived_at = ?, updated_at = ? WHERE id = ? AND kind = 'project' AND active = 1")
      .run(archivedAt, archivedAt, id).changes > 0;
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

  list(opts: { limit?: number; offset?: number; kind?: MemoryRecord['kind']; includeInactive?: boolean } = {}): MemoryRecord[] {
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

  /** All active, non-expired memories with embeddings from the same model/dimension. */
  activeWithEmbeddings(opts: number | { dimensions: number; model?: string }): Array<{ row: MemoryRow; vector: number[] }> {
    const dimensions = typeof opts === 'number' ? opts : opts.dimensions;
    const model = typeof opts === 'number' ? undefined : opts.model;
    const modelClause = model ? ' AND embedding_model = ?' : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE active = 1 AND (kind <> 'project' OR archived_at IS NULL)
          AND embedding IS NOT NULL AND embedding_dim = ?
          AND (expires_at IS NULL OR expires_at > ?)${modelClause}`
      )
      .all(dimensions, nowIso(), ...(model ? [model] : [])) as MemoryRow[];
    return rows.map((row) => ({ row, vector: bufferToFloats(row.embedding!) }));
  }

  embeddingNeedsRefresh(id: string, model?: string, dimensions?: number): boolean {
    const row = this.db.prepare('SELECT embedding, embedding_model, embedding_dim FROM memories WHERE id = ?').get(id) as Pick<MemoryRow, 'embedding' | 'embedding_model' | 'embedding_dim'> | undefined;
    if (!row || !row.embedding) return true;
    if (model && row.embedding_model !== model) return true;
    return dimensions !== undefined && row.embedding_dim !== dimensions;
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
             WHERE memories_fts MATCH ? AND m.active = 1 AND (m.kind <> 'project' OR m.archived_at IS NULL)
               AND (m.expires_at IS NULL OR m.expires_at > ?)
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
        `SELECT * FROM memories WHERE active = 1 AND (kind <> 'project' OR archived_at IS NULL)
          AND (expires_at IS NULL OR expires_at > ?)
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

  /**
   * Admin edit: rewrite content (re-normalized + FTS-synced), importance or
   * confidence. The old normalized text stops matching recall — a corrected
   * fact supersedes the stale one.
   */
  update(id: string, patch: { content?: string; importance?: number; confidence?: number }): MemoryRecord | undefined {
    const current = this.rowById(id);
    if (!current) return undefined;
    const content = patch.content ?? current.content;
    const normalized = normalizeMemoryText(content);
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE memories SET content = ?, normalized = ?, importance = ?, confidence = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(content, normalized, patch.importance ?? current.importance, patch.confidence ?? current.confidence, ts, id);
    try {
      this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number });
      this.db.prepare("INSERT INTO memories_fts(rowid, content, kind) VALUES (?, ?, ?)").run(
        (this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number }).rowid,
        content,
        current.kind
      );
    } catch { /* FTS best effort */ }
    return this.get(id);
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
    const sql = activeOnly
      ? `SELECT COUNT(*) c FROM memories WHERE active = 1 AND (kind <> 'project' OR archived_at IS NULL)`
      : 'SELECT COUNT(*) c FROM memories';
    return (this.db.prepare(sql).get() as { c: number }).c;
  }

  countByKind(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT kind, COUNT(*) c FROM memories
         WHERE active = 1 AND (kind <> 'project' OR archived_at IS NULL)
         GROUP BY kind`
      )
      .all() as Array<{ kind: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.kind, r.c]));
  }

  countWithEmbeddings(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) c FROM memories
           WHERE embedding IS NOT NULL AND active = 1 AND (kind <> 'project' OR archived_at IS NULL)`
        )
        .get() as { c: number }
    ).c;
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
      hasEmbedding: !!row.embedding,
      supersedesId: row.supersedes_id,
      supersededById: row.superseded_by_id,
      archivedAt: row.archived_at
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
