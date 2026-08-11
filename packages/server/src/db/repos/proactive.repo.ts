import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

export type ProactiveMode = 'text' | 'text_sticker' | 'voice' | 'image';
export type ProactiveAttemptStatus = 'blocked' | 'sent' | 'failed';

export interface ProactiveAttempt {
  id: string;
  candidateId: string | null;
  candidateKind: string | null;
  candidateActivity: string | null;
  status: ProactiveAttemptStatus;
  blockedReason: string | null;
  requestedMode: ProactiveMode | null;
  finalMode: ProactiveMode | null;
  fallbackReason: string | null;
  messageId: string | null;
  momentId: string | null;
  sendSuccess: boolean;
  userResponseMessageId: string | null;
  userRespondedAt: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveAttemptInput {
  candidateId?: string | null;
  candidateKind?: string | null;
  candidateActivity?: string | null;
  status?: ProactiveAttemptStatus;
  blockedReason?: string | null;
  requestedMode?: ProactiveMode | null;
  finalMode?: ProactiveMode | null;
  fallbackReason?: string | null;
  messageId?: string | null;
  momentId?: string | null;
  sendSuccess?: boolean;
  detail?: Record<string, unknown>;
}

export interface ProactiveAttemptPatch {
  status?: ProactiveAttemptStatus;
  blockedReason?: string | null;
  requestedMode?: ProactiveMode | null;
  finalMode?: ProactiveMode | null;
  fallbackReason?: string | null;
  messageId?: string | null;
  momentId?: string | null;
  sendSuccess?: boolean;
  detail?: Record<string, unknown>;
}

interface ProactiveAttemptRow {
  id: string;
  candidate_id: string | null;
  candidate_kind: string | null;
  candidate_activity: string | null;
  status: ProactiveAttemptStatus;
  blocked_reason: string | null;
  requested_mode: ProactiveMode | null;
  final_mode: ProactiveMode | null;
  fallback_reason: string | null;
  message_id: string | null;
  moment_id: string | null;
  send_success: number;
  user_response_message_id: string | null;
  user_responded_at: string | null;
  detail_json: string;
  created_at: string;
  updated_at: string;
}

export class ProactiveAttemptRepo {
  constructor(private readonly db: DbLike) {}

  create(input: ProactiveAttemptInput = {}): ProactiveAttempt {
    const id = sortableId('proactive');
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO proactive_attempts(
        id,candidate_id,candidate_kind,candidate_activity,status,blocked_reason,
        requested_mode,final_mode,fallback_reason,message_id,moment_id,send_success,
        detail_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      input.candidateId ?? null,
      input.candidateKind ?? null,
      input.candidateActivity ?? null,
      input.status ?? 'blocked',
      input.blockedReason ?? null,
      input.requestedMode ?? null,
      input.finalMode ?? null,
      input.fallbackReason ?? null,
      input.messageId ?? null,
      input.momentId ?? null,
      input.sendSuccess ? 1 : 0,
      JSON.stringify(input.detail ?? {}),
      timestamp,
      timestamp
    );
    return this.get(id)!;
  }

  get(id: string): ProactiveAttempt | undefined {
    const row = this.db.prepare('SELECT * FROM proactive_attempts WHERE id = ?').get(id) as ProactiveAttemptRow | undefined;
    return row ? toAttempt(row) : undefined;
  }

  update(id: string, patch: ProactiveAttemptPatch): ProactiveAttempt | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const detail = patch.detail ? { ...current.detail, ...patch.detail } : current.detail;
    this.db.prepare(`
      UPDATE proactive_attempts SET
        status=?, blocked_reason=?, requested_mode=?, final_mode=?, fallback_reason=?,
        message_id=?, moment_id=?, send_success=?, detail_json=?, updated_at=?
      WHERE id=?
    `).run(
      patch.status ?? current.status,
      patch.blockedReason === undefined ? current.blockedReason : patch.blockedReason,
      patch.requestedMode === undefined ? current.requestedMode : patch.requestedMode,
      patch.finalMode === undefined ? current.finalMode : patch.finalMode,
      patch.fallbackReason === undefined ? current.fallbackReason : patch.fallbackReason,
      patch.messageId === undefined ? current.messageId : patch.messageId,
      patch.momentId === undefined ? current.momentId : patch.momentId,
      patch.sendSuccess === undefined ? (current.sendSuccess ? 1 : 0) : (patch.sendSuccess ? 1 : 0),
      JSON.stringify(detail),
      nowIso(),
      id
    );
    return this.get(id);
  }

  list(limit = 50): ProactiveAttempt[] {
    const rows = this.db.prepare('SELECT * FROM proactive_attempts ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit))) as ProactiveAttemptRow[];
    return rows.map(toAttempt);
  }

  /** Legacy history hook. New Moments posts no longer bind the next chat message as a response. */
  recordUserResponse(messageId: string, messageCreatedAt: string): boolean {
    const parsed = Date.parse(messageCreatedAt);
    if (!Number.isFinite(parsed)) return false;
    const cutoff = new Date(parsed - 7 * 24 * 60 * 60 * 1000).toISOString();
    const row = this.db.prepare(`
      SELECT id FROM proactive_attempts
      WHERE status='sent' AND send_success=1
        AND moment_id IS NULL
        AND user_response_message_id IS NULL
        AND created_at <= ? AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(messageCreatedAt, cutoff) as { id: string } | undefined;
    if (!row) return false;
    const changed = this.db.prepare(`
      UPDATE proactive_attempts
      SET user_response_message_id=?, user_responded_at=?, updated_at=?
      WHERE id=? AND user_response_message_id IS NULL
    `).run(messageId, messageCreatedAt, nowIso(), row.id).changes;
    return changed > 0;
  }
}

function toAttempt(row: ProactiveAttemptRow): ProactiveAttempt {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    candidateKind: row.candidate_kind,
    candidateActivity: row.candidate_activity,
    status: row.status,
    blockedReason: row.blocked_reason,
    requestedMode: row.requested_mode,
    finalMode: row.final_mode,
    fallbackReason: row.fallback_reason,
    messageId: row.message_id,
    momentId: row.moment_id,
    sendSuccess: row.send_success === 1,
    userResponseMessageId: row.user_response_message_id,
    userRespondedAt: row.user_responded_at,
    detail: parseDetail(row.detail_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseDetail(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
