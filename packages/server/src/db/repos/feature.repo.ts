import type { DbLike } from '../handle.js';
import { nowIso, randomId } from '../../util/ids.js';

export interface PushSubscriptionRow { endpoint: string; p256dh: string; auth: string; expiration_time: number | null; visible: number; last_seen_at: string | null; fail_count: number; created_at: string; updated_at: string; }
export class PushSubscriptionRepo {
  constructor(private readonly db: DbLike) {}
  upsert(input: { endpoint: string; p256dh: string; auth: string; expirationTime?: number | null }): PushSubscriptionRow { const ts = nowIso(); this.db.prepare(`INSERT INTO push_subscriptions(endpoint,p256dh,auth,expiration_time,visible,last_seen_at,fail_count,created_at,updated_at) VALUES(?,?,?,?,0,?,0,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,expiration_time=excluded.expiration_time,fail_count=0,updated_at=excluded.updated_at`).run(input.endpoint,input.p256dh,input.auth,input.expirationTime ?? null,ts,ts,ts); return this.get(input.endpoint)!; }
  get(endpoint: string): PushSubscriptionRow | undefined { return this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as PushSubscriptionRow | undefined; }
  list(): PushSubscriptionRow[] { return this.db.prepare('SELECT * FROM push_subscriptions ORDER BY updated_at DESC').all() as PushSubscriptionRow[]; }
  count(): number { return (this.db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get() as { c: number }).c; }
  remove(endpoint: string): boolean { return this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0; }
  markVisibility(endpoint: string, visible: boolean): void { const ts = nowIso(); this.db.prepare('UPDATE push_subscriptions SET visible=?,last_seen_at=?,updated_at=? WHERE endpoint=?').run(visible ? 1 : 0,ts,ts,endpoint); }
  markSuccess(endpoint: string): void { this.db.prepare('UPDATE push_subscriptions SET fail_count=0,updated_at=? WHERE endpoint=?').run(nowIso(),endpoint); }
  markFailure(endpoint: string): number { this.db.prepare('UPDATE push_subscriptions SET fail_count=fail_count+1,updated_at=? WHERE endpoint=?').run(nowIso(),endpoint); return this.get(endpoint)?.fail_count ?? 0; }
}

export type WorldKind = 'entity' | 'relation' | 'fact' | 'scene' | 'timeline';
export type WorldAuthority = 'model' | 'user' | 'admin';
export interface WorldEntryRow { id: string; kind: WorldKind; subject: string; predicate: string; object: string; value_json: string; confidence: number; authority: WorldAuthority; source_message_id: string | null; active: number; conflict_of: string | null; created_at: string; updated_at: string; }
export interface WorldCandidate { kind: WorldKind; subject: string; predicate: string; object: string; value?: Record<string, unknown>; confidence?: number; authority?: WorldAuthority; }
export interface WorldApplyResult { stored: number; merged: number; conflicts: number; entries: WorldEntryRow[]; }
const authorityRank: Record<WorldAuthority, number> = { model: 1, user: 2, admin: 3 };

export class WorldRepo {
  constructor(private readonly db: DbLike) {}
  get(id: string): WorldEntryRow | undefined { return this.db.prepare('SELECT * FROM world_entries WHERE id=?').get(id) as WorldEntryRow | undefined; }
  list(input: { search?: string; kind?: WorldKind; active?: boolean; limit?: number; offset?: number } = {}): WorldEntryRow[] {
    const where: string[] = []; const values: unknown[] = [];
    if (input.kind) { where.push('kind=?'); values.push(input.kind); }
    if (input.active !== undefined) { where.push('active=?'); values.push(input.active ? 1 : 0); }
    if (input.search?.trim()) { const q = `%${input.search.trim()}%`; where.push('(subject LIKE ? OR predicate LIKE ? OR object LIKE ? OR value_json LIKE ?)'); values.push(q,q,q,q); }
    values.push(Math.max(1,Math.min(500,input.limit ?? 100)),Math.max(0,input.offset ?? 0));
    return this.db.prepare(`SELECT * FROM world_entries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY active DESC,updated_at DESC LIMIT ? OFFSET ?`).all(...values) as WorldEntryRow[];
  }
  relevant(query: string, limit = 18): WorldEntryRow[] {
    const terms = worldSearchTerms(query).slice(0,16);
    const authorityOrder = `CASE authority WHEN 'admin' THEN 3 WHEN 'user' THEN 2 ELSE 1 END`;
    if (!terms.length) return this.db.prepare(`SELECT * FROM world_entries WHERE active=1 AND conflict_of IS NULL ORDER BY ${authorityOrder} DESC,confidence DESC,updated_at DESC LIMIT ?`).all(limit) as WorldEntryRow[];
    const clauses = terms.map(() => '(subject LIKE ? OR predicate LIKE ? OR object LIKE ?)').join(' OR ');
    const values: unknown[] = terms.flatMap((term) => [`%${term}%`,`%${term}%`,`%${term}%`]); values.push(limit);
    return this.db.prepare(`SELECT * FROM world_entries WHERE active=1 AND conflict_of IS NULL AND (${clauses}) ORDER BY ${authorityOrder} DESC,confidence DESC,updated_at DESC LIMIT ?`).all(...values) as WorldEntryRow[];
  }
  apply(candidates: WorldCandidate[], sourceMessageId: string | null): WorldApplyResult {
    const result: WorldApplyResult = { stored: 0,merged: 0,conflicts: 0,entries: [] };
    this.db.transaction(() => {
      for (const raw of candidates) {
        const candidate = normalizeCandidate(raw); if (!candidate) continue;
        const existing = this.db.prepare(`SELECT * FROM world_entries WHERE active=1 AND conflict_of IS NULL AND lower(subject)=lower(?) AND lower(predicate)=lower(?) ORDER BY CASE authority WHEN 'admin' THEN 3 WHEN 'user' THEN 2 ELSE 1 END DESC,confidence DESC,updated_at DESC LIMIT 1`).get(candidate.subject,candidate.predicate) as WorldEntryRow | undefined;
        if (existing && normalize(existing.object) === normalize(candidate.object)) {
          const confidence = Math.max(existing.confidence,candidate.confidence ?? 0.6);
          const authority = authorityRank[candidate.authority ?? 'model'] > authorityRank[existing.authority] ? candidate.authority ?? 'model' : existing.authority;
          this.db.prepare('UPDATE world_entries SET confidence=?,authority=?,value_json=?,updated_at=? WHERE id=?').run(confidence,authority,JSON.stringify(candidate.value ?? safeJson(existing.value_json)),nowIso(),existing.id);
          if (sourceMessageId) this.addSource(existing.id,sourceMessageId);
          result.merged++; result.entries.push(this.get(existing.id)!); continue;
        }
        if (existing) {
          const incomingAuthority = candidate.authority ?? 'model';
          const canReplace = authorityRank[incomingAuthority] > authorityRank[existing.authority] || (authorityRank[incomingAuthority] === authorityRank[existing.authority] && (candidate.confidence ?? 0.6) > existing.confidence);
          if (canReplace) {
            const winner = this.insert(candidate,sourceMessageId,true,null);
            this.db.prepare('UPDATE world_entries SET active=0,conflict_of=?,updated_at=? WHERE id=?').run(winner.id,nowIso(),existing.id);
            result.entries.push(winner);
          } else result.entries.push(this.insert(candidate,sourceMessageId,false,existing.id));
          result.conflicts++; continue;
        }
        const created = this.insert(candidate,sourceMessageId,true,null); result.stored++; result.entries.push(created);
      }
    })();
    return result;
  }
  create(candidate: WorldCandidate, sourceMessageId: string | null = null): WorldEntryRow { const normalized = normalizeCandidate(candidate); if (!normalized) throw new Error('invalid world entry'); return this.insert(normalized,sourceMessageId,true,null); }
  update(id: string, patch: Partial<WorldCandidate> & { active?: boolean }): WorldEntryRow | undefined {
    const row = this.get(id); if (!row) return undefined;
    const normalized = normalizeCandidate({ kind: patch.kind ?? row.kind,subject: patch.subject ?? row.subject,predicate: patch.predicate ?? row.predicate,object: patch.object ?? row.object,value: patch.value ?? safeJson(row.value_json),confidence: patch.confidence ?? row.confidence,authority: patch.authority ?? row.authority }); if (!normalized) throw new Error('invalid world entry');
    const active = patch.active === undefined ? row.active : patch.active ? 1 : 0;
    const conflictOf = active ? null : row.conflict_of;
    this.db.prepare('UPDATE world_entries SET kind=?,subject=?,predicate=?,object=?,value_json=?,confidence=?,authority=?,active=?,conflict_of=?,updated_at=? WHERE id=?').run(normalized.kind,normalized.subject,normalized.predicate,normalized.object,JSON.stringify(normalized.value ?? {}),normalized.confidence ?? 0.6,normalized.authority ?? 'model',active,conflictOf,nowIso(),id);
    return this.get(id);
  }
  remove(id: string): boolean { return this.db.prepare('DELETE FROM world_entries WHERE id=?').run(id).changes > 0; }
  clear(): number { return this.db.prepare('DELETE FROM world_entries').run().changes; }
  count(active?: boolean): number { return active === undefined ? (this.db.prepare('SELECT COUNT(*) c FROM world_entries').get() as { c: number }).c : (this.db.prepare('SELECT COUNT(*) c FROM world_entries WHERE active=?').get(active ? 1 : 0) as { c: number }).c; }
  private insert(candidate: WorldCandidate, sourceMessageId: string | null, active: boolean, conflictOf: string | null): WorldEntryRow { const id=`world_${randomId(16)}`; const ts=nowIso(); this.db.prepare('INSERT INTO world_entries(id,kind,subject,predicate,object,value_json,confidence,authority,source_message_id,active,conflict_of,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,candidate.kind,candidate.subject,candidate.predicate,candidate.object,JSON.stringify(candidate.value ?? {}),candidate.confidence ?? 0.6,candidate.authority ?? 'model',sourceMessageId,active ? 1 : 0,conflictOf,ts,ts); if (sourceMessageId) this.addSource(id,sourceMessageId); return this.get(id)!; }
  private addSource(entryId: string, messageId: string): void { this.db.prepare('INSERT OR IGNORE INTO world_sources(entry_id,message_id,created_at) VALUES(?,?,?)').run(entryId,messageId,nowIso()); }
}

export class AuditRepo {
  constructor(private readonly db: DbLike) {}
  add(category: string, action: string, target?: string | null, detail: Record<string, unknown> = {}): void { this.db.prepare('INSERT INTO audit_log(id,category,action,target,detail_json,created_at) VALUES(?,?,?,?,?,?)').run(`audit_${randomId(14)}`,category.slice(0,60),action.slice(0,80),target?.slice(0,160) ?? null,JSON.stringify(detail),nowIso()); this.db.prepare('DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY created_at DESC LIMIT 1000)').run(); }
  list(limit = 100): Array<{ id: string; category: string; action: string; target: string | null; detail: unknown; createdAt: string }> { const rows=this.db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(Math.min(500,Math.max(1,limit))) as Array<{ id:string;category:string;action:string;target:string|null;detail_json:string;created_at:string }>; return rows.map((row)=>({ id:row.id,category:row.category,action:row.action,target:row.target,detail:safeJson(row.detail_json),createdAt:row.created_at })); }
}
export class StorageSampleRepo {
  constructor(private readonly db: DbLike) {}
  add(mediaBytes: number,dataBytes: number,freeBytes: number|null): void { this.db.prepare('INSERT INTO storage_samples(created_at,media_bytes,data_bytes,free_bytes) VALUES(?,?,?,?)').run(nowIso(),mediaBytes,dataBytes,freeBytes); this.db.prepare('DELETE FROM storage_samples WHERE id NOT IN (SELECT id FROM storage_samples ORDER BY created_at DESC LIMIT 720)').run(); }
  list(limit=48): Array<{ createdAt:string;mediaBytes:number;dataBytes:number;freeBytes:number|null }> { const rows=this.db.prepare('SELECT * FROM storage_samples ORDER BY created_at DESC LIMIT ?').all(Math.min(720,Math.max(1,limit))) as Array<{ created_at:string;media_bytes:number;data_bytes:number;free_bytes:number|null }>; return rows.map((row)=>({ createdAt:row.created_at,mediaBytes:row.media_bytes,dataBytes:row.data_bytes,freeBytes:row.free_bytes })); }
}
function worldSearchTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const token of query.split(/[\s，。！？、；：,.!?;:]+/).map((value) => value.trim()).filter(Boolean)) {
    if (token.length >= 2) terms.add(token);
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 2) {
      for (let size = 2; size <= Math.min(4, token.length); size++) {
        for (let index = 0; index + size <= token.length; index++) terms.add(token.slice(index, index + size));
      }
    }
  }
  return [...terms];
}
function normalizeCandidate(input: WorldCandidate): WorldCandidate|null { if (!['entity','relation','fact','scene','timeline'].includes(input.kind)) return null; const subject=String(input.subject ?? '').trim().slice(0,200); const predicate=String(input.predicate ?? '').trim().slice(0,120); const object=String(input.object ?? '').trim().slice(0,500); if (!subject || !predicate || !object) return null; const confidence=Math.max(0,Math.min(1,Number(input.confidence ?? 0.6))); const authority=input.authority && ['model','user','admin'].includes(input.authority) ? input.authority : 'model'; return { kind:input.kind,subject,predicate,object,value:input.value ?? {},confidence,authority }; }
function normalize(value:string):string { return value.trim().toLocaleLowerCase().replace(/[\s，。！？、；：,.!?;:]+/g,''); }
function safeJson(json:string):Record<string,unknown> { try { return JSON.parse(json) as Record<string,unknown>; } catch { return {}; } }
