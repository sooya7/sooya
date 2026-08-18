import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { StickerRepo, Sticker } from '../db/repos/sticker.repo.js';
import type { MediaStore } from './store.js';
import type { MediaRepo } from '../db/repos/media.repo.js';
import { stickerSemanticText } from '../core/stickers/semantic-text.js';

export interface StickerManifestEntry {
  name: string;
  file: string;
  emotion: string;
  tags: string[];
  description?: string;
  imageText?: string;
}

export interface StickerSelection {
  sticker: Sticker;
  reason: string;
  score: number;
}

/**
 * Local sticker library. Stickers are real files under data/media/stickers.
 * The source pack is imported from the deployment-owned `SOOYA_ASSETS_DIR`;
 * production sticker files are intentionally not bundled with Git/releases.
 * Nothing depends on a remote URL, and a missing file is never reported as available.
 */
export class StickerLibrary {
  private availableCache: Sticker[] | null = null;
  private allCache: Sticker[] | null = null;

  constructor(
    private readonly repo: StickerRepo,
    private readonly mediaRepo: MediaRepo,
    private readonly store: MediaStore
  ) {
    this.repo.setOnChange(() => this.invalidate());
  }

  /** Drop cached directory/stat results after any sticker or media mutation. */
  invalidate(): void {
    this.availableCache = null;
    this.allCache = null;
  }

  /** Import built-in stickers. Idempotent: existing names are skipped. */
  async importBuiltin(assetsDir: string): Promise<{ imported: number; skipped: number; failed: number }> {
    const manifestPath = path.join(assetsDir, 'manifest.json');
    let entries: StickerManifestEntry[] = [];
    if (fs.existsSync(manifestPath)) {
      try {
        entries = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as StickerManifestEntry[];
      } catch {
        entries = [];
      }
    }
    if (entries.length === 0 && fs.existsSync(assetsDir)) {
      entries = (await fsp.readdir(assetsDir))
        .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
        .map((file) => ({ name: path.parse(file).name, file, emotion: 'neutral', tags: [path.parse(file).name] }));
    }
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    for (const entry of entries) {
      if (this.repo.getByName(entry.name)) {
        skipped++;
        continue;
      }
      const full = path.join(assetsDir, entry.file);
      try {
        const data = await fsp.readFile(full);
        const media = await this.store.save({
          kind: 'sticker',
          origin: 'builtin',
          data,
          filename: entry.file,
          meta: { builtin: true, name: entry.file }
        });
        this.repo.create({
          mediaId: media.id,
          name: entry.name,
          tags: entry.tags,
          emotion: entry.emotion,
          description: entry.description,
          imageText: entry.imageText,
          nameSource: 'builtin',
          analysisSource: entry.description ? 'manual' : 'legacy',
          analysisStatus: entry.description ? 'ready' : 'pending'
        });
        imported++;
      } catch {
        failed++;
      }
    }
    return { imported, skipped, failed };
  }

  /** Enabled stickers whose media file actually exists on disk. */
  available(): Sticker[] {
    if (this.availableCache) return this.availableCache;
    const result = this.repo
      .list({ enabledOnly: true })
      .map((s) => {
        const media = this.mediaRepo.get(s.mediaId);
        const ok = media ? this.store.exists(media) : false;
        return { ...s, available: ok, mime: media?.mime, animated: media?.animated === 1 };
      })
      .filter((s) => s.available);
    this.availableCache = result;
    return result;
  }

  all(): Sticker[] {
    if (this.allCache) return this.allCache;
    const result = this.repo.list().map((s) => {
      const media = this.mediaRepo.get(s.mediaId);
      return { ...s, available: media ? this.store.exists(media) : false, mime: media?.mime, animated: media?.animated === 1 };
    });
    this.allCache = result;
    return result;
  }

  markUsed(id: string): void {
    this.repo.markUsed(id);
  }

  markUserUsed(id: string): Sticker | undefined {
    return this.repo.markUserUsed(id);
  }

  getByMediaId(mediaId: string): Sticker | undefined {
    return this.repo.getByMediaId(mediaId);
  }

  semanticText(sticker: Sticker | string): string {
    const resolved = typeof sticker === 'string' ? this.repo.get(sticker) : sticker;
    return resolved ? stickerSemanticText(resolved) : '';
  }

  /**
   * Choose a sticker for the given emotion/keyword hint.
   * Returns null when nothing matches well enough — SOOYA never force-sends
   * an unrelated sticker.
   */
  select(opts: {
    hint?: string | null;
    text?: string | null;
    excludeIds?: string[];
    requireMatch?: boolean;
  }): StickerSelection | null {
    const pool = this.available().filter((s) => !(opts.excludeIds ?? []).includes(s.id));
    if (pool.length === 0) return null;
    const hint = (opts.hint ?? '').trim().toLowerCase();
    const text = (opts.text ?? '').toLowerCase();
    const haystack = `${hint} ${text}`;

    let best: StickerSelection | null = null;
    for (const s of pool) {
      let score = 0;
      const reasons: string[] = [];
      if (hint) {
        if (s.name.toLowerCase() === hint || s.emotion.toLowerCase() === hint) {
          score += 10;
          reasons.push('exact-hint');
        }
        for (const tag of s.tags) {
          const t = tag.toLowerCase();
          if (t === hint) {
            score += 8;
            reasons.push(`tag:${tag}`);
          } else if (hint.includes(t) || t.includes(hint)) {
            score += 4;
            reasons.push(`tag~:${tag}`);
          }
        }
      }
      if (text) {
        for (const tag of s.tags) {
          if (haystack.includes(tag.toLowerCase())) {
            score += 2;
            reasons.push(`text:${tag}`);
          }
        }
        if (haystack.includes(s.emotion.toLowerCase())) score += 2;
      }
      const recency = s.lastUsedAt ? (Date.now() - Date.parse(s.lastUsedAt)) / (1000 * 60 * 60) : 999;
      score += Math.min(recency / 24, 1) * 0.8;
      score -= Math.min(s.useCount, 20) * 0.02;
      if (!best || score > best.score) best = { sticker: s, score, reason: reasons.join(',') || 'rotation' };
    }
    if (!best) return null;
    const threshold = opts.requireMatch === false ? 0 : 2;
    if (best.score < threshold) return null;
    return best;
  }

  /** Compact catalogue string for prompting the model. */
  catalogueForPrompt(limit = 40): string {
    const list = this.available().slice(0, limit);
    if (list.length === 0) return '（当前没有可用表情包）';
    return list.map((s) => `${s.name}[${s.emotion}${s.tags.length ? `/${s.tags.slice(0, 3).join('/')}` : ''}]`).join('、');
  }

  count(): number {
    return this.available().length;
  }
}
