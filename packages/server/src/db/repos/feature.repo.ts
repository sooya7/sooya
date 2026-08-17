import type { DbLike } from '../handle.js';
import { nowIso, randomId } from '../../util/ids.js';

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

function safeJson(json: string): Record<string, unknown> { try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; } }
