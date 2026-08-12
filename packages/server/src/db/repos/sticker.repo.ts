import type { DbLike } from '../handle.js';
import { newStickerId, nowIso } from '../../util/ids.js';
import type { MediaRow } from './media.repo.js';
import { stickerSemanticText } from '../../core/stickers/semantic-text.js';

export type StickerNameSource = 'legacy' | 'builtin' | 'manual' | 'auto';
export type StickerAnalysisStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type StickerAnalysisSource = 'legacy' | 'ai' | 'manual';
export type StickerUserMeaningSource = 'none' | 'ai' | 'manual';

export interface StickerRow {
  id: string;
  media_id: string;
  name: string;
  tags_json: string;
  emotion: string;
  use_count: number;
  last_used_at: string | null;
  enabled: number;
  created_at: string;
  description?: string;
  image_text?: string;
  name_source?: StickerNameSource;
  user_meaning?: string;
  user_meaning_source?: StickerUserMeaningSource;
  user_meaning_confidence?: number | null;
  user_meaning_updated_at?: string | null;
  analysis_status?: StickerAnalysisStatus;
  analysis_source?: StickerAnalysisSource;
  analysis_version?: number;
  analysis_model?: string | null;
  analyzed_at?: string | null;
  analysis_error?: string | null;
  embedding?: Buffer | null;
  embedding_dim?: number | null;
  embedding_model?: string | null;
  favorite?: number;
  user_use_count?: number;
  user_last_used_at?: string | null;
  updated_at?: string | null;
  semantic_revision?: number;
}

export interface Sticker {
  id: string;
  mediaId: string;
  name: string;
  nameSource: StickerNameSource;
  description: string;
  imageText: string;
  tags: string[];
  /** Legacy emotion label retained for old manifests and clients. */
  emotion: string;
  userMeaning: string;
  userMeaningSource: StickerUserMeaningSource;
  userMeaningConfidence: number | null;
  userMeaningUpdatedAt: string | null;
  analysisStatus: StickerAnalysisStatus;
  analysisSource: StickerAnalysisSource;
  analysisVersion: number;
  analysisModel: string | null;
  analyzedAt: string | null;
  analysisError: string | null;
  embedding: Buffer | null;
  embeddingDim: number | null;
  embeddingModel: string | null;
  favorite: boolean;
  useCount: number;
  lastUsedAt: string | null;
  /** V2 names; useCount/lastUsedAt remain for the legacy API. */
  assistantUseCount: number;
  assistantLastUsedAt: string | null;
  userUseCount: number;
  userLastUsedAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  semanticRevision: number;
  url: string;
  mime?: string;
  /** True when the source media contains more than one image frame. */
  animated?: boolean;
  /** False when the underlying media file is missing on disk. */
  available?: boolean;
}

export interface StickerListOptions {
  enabledOnly?: boolean;
  enabled?: boolean;
  scope?: 'recent' | 'favorite' | 'all';
  q?: string;
  status?: StickerAnalysisStatus;
  source?: StickerAnalysisSource;
  emotion?: string;
  sort?: 'created' | 'name' | 'recent' | 'usage';
  limit?: number;
  offset?: number;
}

export type StickerFilterOptions = Omit<StickerListOptions, 'limit' | 'offset' | 'sort'>;

export interface StickerAnalysisStatePatch {
  status: StickerAnalysisStatus;
  source?: StickerAnalysisSource;
  version?: number;
  model?: string | null;
  analyzedAt?: string | null;
  error?: string | null;
}

export class StickerRepo {
  private onChange: (() => void) | null = null;

  constructor(private readonly db: DbLike) {}

  /** Callback fired after every mutation, so cache owners can invalidate. */
  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  private notify(): void {
    this.onChange?.();
  }

  create(input: {
    mediaId: string;
    name: string;
    tags?: string[];
    emotion?: string;
    description?: string;
    imageText?: string;
    nameSource?: StickerNameSource;
    analysisSource?: StickerAnalysisSource;
    analysisStatus?: StickerAnalysisStatus;
    analysisVersion?: number;
    enabled?: boolean;
    id?: string;
  }): Sticker {
    const id = input.id ?? newStickerId();
    const createdAt = nowIso();
    const description = input.description?.trim() ?? '';
    const analysisStatus = input.analysisStatus ?? (description ? 'ready' : 'pending');
    const analysisSource = input.analysisSource ?? (description ? 'manual' : 'legacy');
    this.db
      .prepare(
        `INSERT INTO stickers (
          id, media_id, name, tags_json, emotion, use_count, last_used_at, enabled, created_at,
          description, image_text, name_source, user_meaning, user_meaning_source,
          user_meaning_confidence, user_meaning_updated_at, analysis_status, analysis_source,
          analysis_version, analysis_model, analyzed_at, analysis_error, embedding, embedding_dim,
          embedding_model, favorite, user_use_count, user_last_used_at, updated_at, semantic_revision
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`
      )
      .run(
        id,
        input.mediaId,
        input.name.trim().slice(0, 60),
        JSON.stringify(normalizeTags(input.tags ?? [])),
        (input.emotion ?? 'neutral').trim().slice(0, 40),
        0,
        null,
        input.enabled === false ? 0 : 1,
        createdAt,
        description,
        (input.imageText ?? '').trim().slice(0, 300),
        input.nameSource ?? 'legacy',
        '',
        'none',
        null,
        null,
        analysisStatus,
        analysisSource,
        input.analysisVersion ?? 0,
        null,
        description ? createdAt : null,
        null,
        null,
        null,
        null,
        0,
        0,
        null,
        createdAt,
        0
      );
    this.refreshFts(id);
    this.notify();
    return this.get(id)!;
  }

  get(id: string): Sticker | undefined {
    const row = this.db.prepare('SELECT * FROM stickers WHERE id = ?').get(id) as StickerRow | undefined;
    return row ? this.toSticker(row) : undefined;
  }

  getByMediaId(mediaId: string): Sticker | undefined {
    const row = this.db.prepare('SELECT * FROM stickers WHERE media_id = ?').get(mediaId) as StickerRow | undefined;
    return row ? this.toSticker(row) : undefined;
  }

  getByName(name: string): Sticker | undefined {
    const row = this.db.prepare('SELECT * FROM stickers WHERE name = ?').get(name) as StickerRow | undefined;
    return row ? this.toSticker(row) : undefined;
  }

  list(opts: StickerListOptions = {}): Sticker[] {
    if (opts.q?.trim()) return this.searchFts(opts.q, opts);
    const { where, values } = stickerWhere(opts);
    const order = stickerOrder(opts);
    let sql = `SELECT * FROM stickers${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`;
    if (opts.limit !== undefined) {
      sql += ' LIMIT ? OFFSET ?';
      values.push(Math.max(0, Math.min(500, Math.floor(opts.limit))), Math.max(0, Math.floor(opts.offset ?? 0)));
    }
    return (this.db.prepare(sql).all(...values) as StickerRow[]).map((r) => this.toSticker(r));
  }

  count(enabledOnly = true): number {
    const sql = enabledOnly ? 'SELECT COUNT(*) c FROM stickers WHERE enabled = 1' : 'SELECT COUNT(*) c FROM stickers';
    return (this.db.prepare(sql).get() as { c: number }).c;
  }

  countFiltered(opts: StickerFilterOptions = {}): number {
    if (opts.q?.trim()) {
      // FTS is deliberately used for the page, but its MATCH query is not a
      // portable count source across the old v1-v29 databases. Count the
      // same semantic projection without a page cap so pagination remains
      // honest even when the gallery is larger than 500 rows.
      return this.list({ ...opts, q: undefined, limit: undefined, offset: undefined })
        .filter((sticker) => stickerSemanticText(sticker).toLocaleLowerCase().includes(opts.q!.trim().toLocaleLowerCase()))
        .length;
    }
    const { where, values } = stickerWhere(opts);
    const row = this.db.prepare(`SELECT COUNT(*) c FROM stickers${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`).get(...values) as { c: number };
    return row.c;
  }

  facets(opts: StickerFilterOptions = {}): { status: Record<string, number>; source: Record<string, number>; emotion: Record<string, number> } {
    const rows = this.list({ ...opts, limit: undefined, offset: undefined });
    const status: Record<string, number> = {};
    const source: Record<string, number> = {};
    const emotion: Record<string, number> = {};
    for (const sticker of rows) {
      status[sticker.analysisStatus] = (status[sticker.analysisStatus] ?? 0) + 1;
      source[sticker.analysisSource] = (source[sticker.analysisSource] ?? 0) + 1;
      emotion[sticker.emotion] = (emotion[sticker.emotion] ?? 0) + 1;
    }
    return { status, source, emotion };
  }

  update(id: string, patch: {
    tags?: string[];
    emotion?: string;
    enabled?: boolean;
    name?: string;
    nameSource?: StickerNameSource;
    description?: string;
    imageText?: string;
    userMeaning?: string;
    userMeaningSource?: StickerUserMeaningSource;
  }): Sticker | undefined {
    const sets: string[] = [];
    const values: unknown[] = [];
    const normalizedMeaning = patch.userMeaning?.trim().slice(0, 120);
    const semanticChanged = patch.tags !== undefined || patch.name !== undefined || patch.emotion !== undefined
      || patch.description !== undefined || patch.imageText !== undefined || patch.userMeaning !== undefined;
    if (patch.tags !== undefined) (sets.push('tags_json = ?'), values.push(JSON.stringify(normalizeTags(patch.tags))));
    if (patch.emotion !== undefined) (sets.push('emotion = ?'), values.push(patch.emotion.trim().slice(0, 40)));
    if (patch.name !== undefined) (sets.push('name = ?'), values.push(patch.name.trim().slice(0, 60)));
    if (patch.nameSource !== undefined) (sets.push('name_source = ?'), values.push(patch.nameSource));
    else if (patch.name !== undefined) (sets.push('name_source = ?'), values.push('manual'));
    if (patch.description !== undefined) (sets.push('description = ?'), values.push(patch.description.trim().slice(0, 500)));
    if (patch.imageText !== undefined) (sets.push('image_text = ?'), values.push(patch.imageText.trim().slice(0, 300)));
    if (patch.userMeaning !== undefined) {
      sets.push('user_meaning = ?', 'user_meaning_source = ?', 'user_meaning_confidence = NULL', 'user_meaning_updated_at = ?');
      values.push(normalizedMeaning, normalizedMeaning ? (patch.userMeaningSource ?? 'manual') : 'none', normalizedMeaning ? nowIso() : null);
    } else if (patch.userMeaningSource !== undefined) {
      sets.push('user_meaning_source = ?');
      values.push(patch.userMeaningSource);
    }
    if (patch.tags !== undefined || patch.description !== undefined || patch.imageText !== undefined) {
      sets.push('analysis_source = ?', 'analysis_status = ?', 'analysis_error = NULL');
      values.push('manual', 'ready');
    }
    if (patch.enabled !== undefined) (sets.push('enabled = ?'), values.push(patch.enabled ? 1 : 0));
    if (semanticChanged) sets.push('embedding = NULL', 'embedding_dim = NULL', 'embedding_model = NULL', 'semantic_revision = semantic_revision + 1');
    if (sets.length === 0) return this.get(id);
    sets.push('updated_at = ?');
    values.push(nowIso(), id);
    const result = this.db.prepare(`UPDATE stickers SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) return undefined;
    this.refreshFts(id);
    this.notify();
    return this.get(id);
  }

  updateSemantics(id: string, patch: { description?: string; imageText?: string; tags?: string[]; name?: string }): Sticker | undefined {
    return this.update(id, patch);
  }

  /** Apply fields edited by a person and mark the visual analysis as authoritative. */
  updateManualSemantics(id: string, patch: { description?: string; imageText?: string; tags?: string[] }): Sticker | undefined {
    return this.update(id, patch);
  }

  applyAiAnalysis(id: string, patch: { suggestedName: string; description: string; imageText: string; tags: string[] }, meta: { version: number; model: string }, options: { force?: boolean; expectedSemanticRevision?: number } = {}): Sticker | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    if (current.analysisSource === 'manual' && !options.force) return current;
    const sets = [
      'description = ?', 'image_text = ?', 'tags_json = ?',
      'analysis_status = \'ready\'', 'analysis_source = \'ai\'',
      'analysis_version = ?', 'analysis_model = ?', 'analyzed_at = ?', 'analysis_error = NULL',
      'embedding = NULL', 'embedding_dim = NULL', 'embedding_model = NULL', 'updated_at = ?'
    ];
    const values: unknown[] = [
      patch.description.trim().slice(0, 500),
      patch.imageText.trim().slice(0, 300),
      JSON.stringify(normalizeTags(patch.tags)),
      meta.version,
      meta.model.trim().slice(0, 200),
      nowIso(),
      nowIso()
    ];
    // Legacy and auto names may accept the model suggestion. Builtin/manual
    // names are protected from background analysis.
    if (current.nameSource === 'auto') {
      sets.splice(1, 0, 'name = ?');
      values.splice(1, 0, patch.suggestedName.trim().slice(0, 60));
    }
    values.push(id);
    const fence = options.force ? ' AND semantic_revision = ?' : " AND analysis_source != 'manual'";
    if (options.force) values.push(options.expectedSemanticRevision ?? current.semanticRevision);
    const result = this.db.prepare(`UPDATE stickers SET ${sets.join(', ')} WHERE id = ?${fence}`).run(...values);
    if (result.changes === 0) return this.get(id);
    this.refreshFts(id);
    this.notify();
    return this.get(id);
  }

  setAnalysisState(id: string, patch: StickerAnalysisStatePatch, options: { allowManual?: boolean } = {}): Sticker | undefined {
    const sets = ['analysis_status = ?', 'updated_at = ?'];
    const values: unknown[] = [patch.status, nowIso()];
    if (patch.source !== undefined) (sets.push('analysis_source = ?'), values.push(patch.source));
    if (patch.version !== undefined) (sets.push('analysis_version = ?'), values.push(patch.version));
    if (patch.model !== undefined) (sets.push('analysis_model = ?'), values.push(patch.model));
    if (patch.analyzedAt !== undefined) (sets.push('analyzed_at = ?'), values.push(patch.analyzedAt));
    if (patch.error !== undefined) (sets.push('analysis_error = ?'), values.push(patch.error));
    if (patch.status === 'ready') sets.push('analysis_error = NULL');
    values.push(id);
    // A worker may still be finishing after an administrator has edited the
    // sticker. Do not let its processing/failure state erase that manual fence.
    const manualFence = options.allowManual ? '' : " AND analysis_source != 'manual'";
    const result = this.db.prepare(`UPDATE stickers SET ${sets.join(', ')} WHERE id = ?${manualFence}`).run(...values);
    if (result.changes === 0) return undefined;
    this.notify();
    return this.get(id);
  }

  setEmbedding(id: string, vector: number[] | Buffer, model: string, dimensions?: number): Sticker | undefined {
    const buffer = Buffer.isBuffer(vector) ? vector : Buffer.from(new Float32Array(vector).buffer);
    const dim = dimensions ?? (Buffer.isBuffer(vector) ? undefined : vector.length) ?? buffer.byteLength / 4;
    const result = this.db.prepare(
      'UPDATE stickers SET embedding = ?, embedding_dim = ?, embedding_model = ?, updated_at = ? WHERE id = ?'
    ).run(buffer, dim, model.trim().slice(0, 200), nowIso(), id);
    if (result.changes === 0) return undefined;
    this.notify();
    return this.get(id);
  }

  clearEmbedding(id: string): void {
    const result = this.db.prepare(
      'UPDATE stickers SET embedding = NULL, embedding_dim = NULL, embedding_model = NULL, updated_at = ? WHERE id = ?'
    ).run(nowIso(), id);
    if (result.changes > 0) this.notify();
  }

  withEmbeddings(opts: { enabledOnly?: boolean; model?: string; dimensions?: number } = {}): Sticker[] {
    const where = ['embedding IS NOT NULL'];
    const values: unknown[] = [];
    if (opts.enabledOnly) where.push('enabled = 1');
    if (opts.model) (where.push('embedding_model = ?'), values.push(opts.model));
    if (opts.dimensions) (where.push('embedding_dim = ?'), values.push(opts.dimensions));
    return (this.db.prepare(`SELECT * FROM stickers WHERE ${where.join(' AND ')} ORDER BY created_at`).all(...values) as StickerRow[]).map((r) => this.toSticker(r));
  }

  searchFts(query: string, opts: StickerListOptions = {}): Sticker[] {
    const normalized = query.trim().slice(0, 200);
    if (!normalized) return this.list({ ...opts, q: undefined });
    const { where: baseWhere, values: baseValues } = stickerWhere(opts, 's.');
    const filters = baseWhere;
    const values = baseValues;
    const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 500)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    if ([...normalized].length < 3) return this.linearSearch(normalized, opts, limit, offset);
    const match = escapeFtsQuery(normalized);
    const order = opts.scope === 'recent'
      ? 's.user_last_used_at IS NULL, s.user_last_used_at DESC, s.created_at DESC'
      : 'bm25(sticker_semantics_fts), s.favorite DESC, s.user_last_used_at DESC';
    try {
      const rows = this.db.prepare(
        `SELECT s.* FROM sticker_semantics_fts f JOIN stickers s ON s.id = f.sticker_id
         WHERE sticker_semantics_fts MATCH ? ${where}
         ORDER BY ${opts.sort === 'name' ? 's.name COLLATE NOCASE, s.id' : order} LIMIT ? OFFSET ?`
      ).all(match, ...values, limit, offset) as StickerRow[];
      return rows.map((r) => this.toSticker(r));
    } catch {
      return this.linearSearch(normalized, opts, limit, offset);
    }
  }

  private linearSearch(query: string, opts: StickerListOptions, limit: number, offset: number): Sticker[] {
    const needle = query.toLocaleLowerCase();
    return this.list({ ...opts, q: undefined, limit: undefined, offset: undefined })
      .filter((sticker) => stickerSemanticText(sticker).toLocaleLowerCase().includes(needle))
      .slice(offset, offset + limit);
  }

  refreshFts(id?: string): void {
    try {
      if (id) {
        this.db.prepare('DELETE FROM sticker_semantics_fts WHERE sticker_id = ?').run(id);
        const sticker = this.get(id);
        if (sticker) this.db.prepare('INSERT INTO sticker_semantics_fts(sticker_id, content) VALUES (?, ?)').run(id, stickerSemanticText(sticker));
      } else {
        this.db.prepare('DELETE FROM sticker_semantics_fts').run();
        for (const sticker of this.list()) {
          this.db.prepare('INSERT INTO sticker_semantics_fts(sticker_id, content) VALUES (?, ?)').run(sticker.id, stickerSemanticText(sticker));
        }
      }
    } catch {
      // v1-v29 databases may be opened by maintenance tooling before v30 is
      // applied. The relational sticker data remains usable without FTS.
    }
  }

  markAssistantUsed(id: string): void {
    this.db.prepare('UPDATE stickers SET use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
    this.notify();
  }

  /** Backwards-compatible name used by the proactive sender and old callers. */
  markUsed(id: string): void { this.markAssistantUsed(id); }

  markUserUsed(id: string): Sticker | undefined {
    const now = nowIso();
    this.db.prepare('UPDATE stickers SET user_use_count = user_use_count + 1, user_last_used_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    this.notify();
    return this.get(id);
  }

  setFavorite(id: string, favorite: boolean): Sticker | undefined {
    const result = this.db.prepare('UPDATE stickers SET favorite = ?, updated_at = ? WHERE id = ?').run(favorite ? 1 : 0, nowIso(), id);
    if (result.changes === 0) return undefined;
    this.notify();
    return this.get(id);
  }

  setUserMeaning(id: string, meaning: string, source: StickerUserMeaningSource, confidence: number | null = null): Sticker | undefined {
    const normalized = meaning.trim().slice(0, 120);
    const effectiveSource: StickerUserMeaningSource = normalized ? source : 'none';
    const effectiveConfidence = effectiveSource === 'ai' ? confidence : null;
    const result = this.db.prepare(
      `UPDATE stickers SET user_meaning = ?, user_meaning_source = ?, user_meaning_confidence = ?,
       user_meaning_updated_at = ?, embedding = NULL, embedding_dim = NULL, embedding_model = NULL, updated_at = ? WHERE id = ?`
    ).run(normalized, effectiveSource, effectiveConfidence, normalized ? nowIso() : null, nowIso(), id);
    if (result.changes === 0) return undefined;
    this.refreshFts(id);
    this.notify();
    return this.get(id);
  }

  delete(id: string): boolean {
    try { this.db.prepare('DELETE FROM sticker_semantics_fts WHERE sticker_id = ?').run(id); } catch { /* v29 compatibility */ }
    const ok = this.db.prepare('DELETE FROM stickers WHERE id = ?').run(id).changes > 0;
    if (ok) this.notify();
    return ok;
  }

  mediaFor(sticker: Sticker): MediaRow | undefined {
    return this.db.prepare('SELECT * FROM media WHERE id = ?').get(sticker.mediaId) as MediaRow | undefined;
  }

  semanticText(sticker: Sticker | string): string {
    const resolved = typeof sticker === 'string' ? this.get(sticker) : sticker;
    return resolved ? stickerSemanticText(resolved) : '';
  }

  private toSticker(row: StickerRow): Sticker {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags_json) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string');
    } catch {
      /* ignore malformed legacy metadata */
    }
    return {
      id: row.id,
      mediaId: row.media_id,
      name: row.name,
      nameSource: row.name_source ?? 'legacy',
      description: row.description ?? '',
      imageText: row.image_text ?? '',
      tags,
      emotion: row.emotion,
      userMeaning: row.user_meaning ?? '',
      userMeaningSource: row.user_meaning_source ?? 'none',
      userMeaningConfidence: row.user_meaning_confidence ?? null,
      userMeaningUpdatedAt: row.user_meaning_updated_at ?? null,
      analysisStatus: row.analysis_status ?? 'pending',
      analysisSource: row.analysis_source ?? 'legacy',
      analysisVersion: row.analysis_version ?? 0,
      analysisModel: row.analysis_model ?? null,
      analyzedAt: row.analyzed_at ?? null,
      analysisError: row.analysis_error ?? null,
      embedding: row.embedding ?? null,
      embeddingDim: row.embedding_dim ?? null,
      embeddingModel: row.embedding_model ?? null,
      favorite: row.favorite === 1,
      useCount: row.use_count,
      lastUsedAt: row.last_used_at,
      assistantUseCount: row.use_count,
      assistantLastUsedAt: row.last_used_at,
      userUseCount: row.user_use_count ?? 0,
      userLastUsedAt: row.user_last_used_at ?? null,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      semanticRevision: row.semantic_revision ?? 0,
      url: `/api/media/${row.media_id}`
    };
  }
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().slice(0, 24)).filter(Boolean))].slice(0, 8);
}

function escapeFtsQuery(query: string): string {
  return query
    .split(/\s+/u)
    .map((term) => term.replace(/"/g, ' ').trim())
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(' OR ')
    .slice(0, 240) || '""';
}

function stickerWhere(opts: StickerListOptions, prefix = ''): { where: string[]; values: unknown[] } {
  const column = (name: string) => `${prefix}${name}`;
  const where: string[] = [];
  const values: unknown[] = [];
  if (opts.enabledOnly || opts.enabled === true) where.push(`${column('enabled')} = 1`);
  else if (opts.enabled === false) where.push(`${column('enabled')} = 0`);
  if (opts.scope === 'favorite') where.push(`${column('favorite')} = 1`);
  if (opts.status) { where.push(`${column('analysis_status')} = ?`); values.push(opts.status); }
  if (opts.source) { where.push(`${column('analysis_source')} = ?`); values.push(opts.source); }
  if (opts.emotion?.trim()) { where.push(`${column('emotion')} = ?`); values.push(opts.emotion.trim().slice(0, 40)); }
  return { where, values };
}

function stickerOrder(opts: StickerListOptions): string {
  if (opts.sort === 'name') return 'name COLLATE NOCASE, id';
  if (opts.sort === 'usage') return 'use_count DESC, user_use_count DESC, created_at DESC';
  if (opts.sort === 'recent' || opts.scope === 'recent' || opts.scope === 'favorite') return 'user_last_used_at IS NULL, user_last_used_at DESC, created_at DESC';
  return 'created_at DESC, id DESC';
}
