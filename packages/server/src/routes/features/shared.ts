import type { SooyaApp } from '../../app.js';
import { mediaMeta, toMediaRef, type MediaRow } from '../../db/repos/media.repo.js';

export const IdSchema = /^[A-Za-z0-9_-]{1,80}$/u;
export const ADMIN_MEDIA_KIND_BY_FIELD: Record<string, 'image' | 'file'> = {
  image: 'image',
  images: 'image',
  file: 'file',
  files: 'file'
};

export function galleryItem(app: SooyaApp, row: MediaRow) {
  const parsed = mediaMeta(row);
  return {
    ...toMediaRef(row),
    origin: row.origin,
    exists: app.services.mediaStore.exists(row),
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    favorite: row.favorite === 1,
    tags: parsed.tags,
    meta: parsed.meta,
    references: app.repos.media.references(row.id)
  };
}

export function sanitizeName(name: string): string {
  return name.replace(/[\\/\0]/g, '_').slice(0, 120);
}

export function mediaIdFromUrl(url: string): string | null {
  return /\/api\/media\/([A-Za-z0-9_-]+)/u.exec(url)?.[1] ?? null;
}
