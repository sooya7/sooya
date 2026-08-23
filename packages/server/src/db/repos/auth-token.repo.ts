import crypto from 'node:crypto';
import type { DbLike } from '../handle.js';
import { nowIso, randomId } from '../../util/ids.js';

export interface AuthTokenRow {
  id: string;
  token_hash: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface AuthTokenView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Rotatable admin tokens (§37): create a new one, brief overlap while both
 * work, revoke the old. Only hashes are stored; the plaintext exists exactly
 * once — in the creation response.
 */
export class AuthTokenRepo {
  constructor(private readonly db: DbLike) {}

  create(label: string): { token: string; view: AuthTokenView } {
    const token = `sooya_${randomId(24)}`;
    const id = `tok_${randomId(12)}`;
    const ts = nowIso();
    this.db
      .prepare('INSERT INTO auth_tokens(id, token_hash, label, created_at) VALUES (?, ?, ?, ?)')
      .run(id, hashToken(token), label.slice(0, 60), ts);
    return {
      token,
      view: { id, label: label.slice(0, 60), createdAt: ts, lastUsedAt: null, revokedAt: null }
    };
  }

  /** Timing-safe check against every non-revoked token; touches last_used_at. */
  verify(token: string): AuthTokenRow | null {
    const hash = hashToken(token);
    const rows = this.db
      .prepare('SELECT * FROM auth_tokens WHERE revoked_at IS NULL')
      .all() as AuthTokenRow[];
    for (const row of rows) {
      const a = Buffer.from(row.token_hash);
      const b = Buffer.from(hash);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        this.db.prepare('UPDATE auth_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
        return row;
      }
    }
    return null;
  }

  list(): AuthTokenView[] {
    return (this.db.prepare('SELECT * FROM auth_tokens ORDER BY created_at DESC').all() as AuthTokenRow[]).map(toView);
  }

  revoke(id: string): boolean {
    return this.db
      .prepare('UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(nowIso(), id).changes > 0;
  }
}

function toView(row: AuthTokenRow): AuthTokenView {
  return { id: row.id, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at };
}
