import type { Sticker } from '../../db/repos/sticker.repo.js';
import type { EmbeddingProvider } from '../../providers/types.js';
import type { StickerRepo } from '../../db/repos/sticker.repo.js';
import type { StickerLibrary } from '../../media/stickers.js';
import { STICKER_DIRECT_PICK_LIMIT, STICKER_EMBEDDING_TOP_K, STICKER_FTS_TOP_K, STICKER_PICKER_MAX_CANDIDATES } from './constants.js';

export type StickerRetrievalStrategy = 'all' | 'embedding' | 'fts' | 'hybrid' | 'fallback';

export interface StickerRetrievalResult {
  candidates: Sticker[];
  strategy: StickerRetrievalStrategy;
}

export class StickerRetriever {
  constructor(
    private readonly repo: StickerRepo,
    private readonly library: StickerLibrary,
    private readonly embedding: () => EmbeddingProvider | null,
    private readonly onError?: (error: unknown) => void
  ) {}

  async retrieve(intent: string, excludeIds: string[] = []): Promise<StickerRetrievalResult> {
    const excluded = new Set(excludeIds);
    const available = this.library.available().filter((sticker) => !excluded.has(sticker.id));
    if (available.length <= STICKER_DIRECT_PICK_LIMIT) return { candidates: available, strategy: 'all' };

    const byId = new Map<string, Sticker>();
    const fts = this.repo.searchFts(intent, { enabledOnly: true, limit: STICKER_FTS_TOP_K });
    for (const sticker of fts) if (!excluded.has(sticker.id) && available.some((item) => item.id === sticker.id)) byId.set(sticker.id, sticker);

    let embeddingFound = false;
    const provider = this.embedding();
    if (provider?.configured) {
      try {
        const query = await provider.embed([intent.slice(0, 500)]);
        const vector = query.vectors[0];
        if (!vector) {
          const lexical = fts.filter((sticker) => !excluded.has(sticker.id));
          return lexical.length > 0
            ? { candidates: lexical.slice(0, STICKER_PICKER_MAX_CANDIDATES), strategy: 'fts' }
            : { candidates: rotationFallback(available, STICKER_PICKER_MAX_CANDIDATES), strategy: 'fallback' };
        }
        const rows = this.repo.withEmbeddings({ enabledOnly: true, dimensions: query.dimensions });
        const scored = rows
          .filter((sticker) => !excluded.has(sticker.id) && available.some((item) => item.id === sticker.id))
          .map((sticker) => ({ sticker, score: cosine(vector, decodeVector(sticker.embedding)) }))
          .filter((entry) => Number.isFinite(entry.score))
          .sort((a, b) => b.score - a.score)
          .slice(0, STICKER_EMBEDDING_TOP_K);
        for (const entry of scored) {
          embeddingFound = true;
          byId.set(entry.sticker.id, entry.sticker);
        }
      } catch (error) {
        this.onError?.(error);
      }
    }

    const candidates = [...byId.values()].slice(0, STICKER_PICKER_MAX_CANDIDATES);
    if (candidates.length > 0) {
      return { candidates, strategy: embeddingFound && fts.length > 0 ? 'hybrid' : embeddingFound ? 'embedding' : 'fts' };
    }
    return { candidates: rotationFallback(available, STICKER_PICKER_MAX_CANDIDATES), strategy: 'fallback' };
  }
}

function decodeVector(value: Buffer | null): number[] {
  if (!value || value.byteLength < 4) return [];
  const view = new Float32Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / 4));
  return [...view];
}

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return Number.NaN;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i]! * right[i]!;
    leftNorm += left[i]! * left[i]!;
    rightNorm += right[i]! * right[i]!;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator > 0 ? dot / denominator : Number.NaN;
}

function rotationFallback(pool: Sticker[], limit: number): Sticker[] {
  return pool
    .slice()
    .sort((a, b) => {
      const aTime = a.userLastUsedAt ? Date.parse(a.userLastUsedAt) : 0;
      const bTime = b.userLastUsedAt ? Date.parse(b.userLastUsedAt) : 0;
      return aTime - bTime || a.useCount - b.useCount || a.createdAt.localeCompare(b.createdAt);
    })
    .slice(0, limit);
}
