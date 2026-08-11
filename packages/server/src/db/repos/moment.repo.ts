import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

export type MomentImageKind = 'pov' | 'selfie';

export interface MomentRow {
  id: string;
  candidate_id: string;
  text: string;
  image_media_id: string | null;
  image_kind: MomentImageKind | null;
  activity: string;
  location_id: string | null;
  location_name: string | null;
  city: string | null;
  weather_condition: string | null;
  temperature_c: number | null;
  liked: number;
  created_at: string;
}

export interface CreateMomentInput {
  candidateId: string;
  text: string;
  imageMediaId?: string | null;
  imageKind?: MomentImageKind | null;
  activity: string;
  locationId?: string | null;
  locationName?: string | null;
  city?: string | null;
  weatherCondition?: string | null;
  temperatureC?: number | null;
  createdAt?: string;
}

export class MomentRepo {
  constructor(private readonly db: DbLike) {}

  inTransaction<T>(work: () => T): T {
    return (this.db.transaction(work) as () => T)();
  }

  create(input: CreateMomentInput): MomentRow {
    const id = sortableId('moment');
    this.db.prepare(`
      INSERT INTO moments(
        id,candidate_id,text,image_media_id,image_kind,activity,
        location_id,location_name,city,weather_condition,temperature_c,liked,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      input.candidateId,
      input.text.trim(),
      input.imageMediaId ?? null,
      input.imageKind ?? null,
      input.activity,
      input.locationId ?? null,
      input.locationName ?? null,
      input.city ?? null,
      input.weatherCondition ?? null,
      input.temperatureC ?? null,
      0,
      input.createdAt ?? nowIso()
    );
    return this.get(id)!;
  }

  get(id: string): MomentRow | undefined {
    return this.db.prepare('SELECT * FROM moments WHERE id = ?').get(id) as MomentRow | undefined;
  }

  latest(): MomentRow | undefined {
    return this.db.prepare('SELECT * FROM moments ORDER BY created_at DESC LIMIT 1').get() as MomentRow | undefined;
  }

  list(limit = 50): MomentRow[] {
    return this.db.prepare('SELECT * FROM moments ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit))) as MomentRow[];
  }

  setLiked(id: string, liked: boolean): MomentRow | undefined {
    const changed = this.db.prepare('UPDATE moments SET liked = ? WHERE id = ?').run(liked ? 1 : 0, id).changes;
    return changed > 0 ? this.get(id) : undefined;
  }
}
