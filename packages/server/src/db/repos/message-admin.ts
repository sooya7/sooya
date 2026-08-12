import type { DbLike } from '../handle.js';
import type { ChatMessage, Role } from '../../core/types.js';
import { MessageRepo } from './message.repo.js';
import type { MediaTextRepo } from './media-text.repo.js';

export interface AdminHistoryOptions {
  q?: string;
  from?: string;
  to?: string;
  role?: Extract<Role, 'user' | 'assistant'>;
  hasMedia?: boolean;
  mediaKind?: 'image' | 'audio' | 'sticker' | 'file';
  limit?: number;
  offset?: number;
}

export interface AdminHistoryPage {
  messages: ChatMessage[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** Read-only admin projection that never returns system/tool trace messages. */
export class AdminMessageRepo {
  private readonly messages: MessageRepo;

  constructor(private readonly db: DbLike, mediaText?: MediaTextRepo) {
    this.messages = new MessageRepo(db, mediaText);
  }

  page(options: AdminHistoryOptions = {}): AdminHistoryPage {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 40)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const { where, values } = historyWhere(options);
    const total = (this.db.prepare(`SELECT COUNT(*) c FROM messages m WHERE ${where.join(' AND ')}`).get(...values) as { c: number }).c;
    const rows = this.db.prepare(
      `SELECT m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.seq DESC LIMIT ? OFFSET ?`
    ).all(...values, limit, offset) as Array<{ id: string; conversation_id: string; role: Role; created_at: string; updated_at: string; seq: number; status: 'pending' | 'sending' | 'sent' | 'failed'; client_msg_id: string | null; reply_to: string | null; error: string | null; meta_json: string }>;
    const messages = this.messages.hydrate(rows).filter((message) => message.role === 'user' || message.role === 'assistant');
    return { messages, total, limit, offset, hasMore: offset + messages.length < total };
  }

  context(id: string, before = 10, after = 10): { target: ChatMessage; messages: ChatMessage[]; hasOlder: boolean; hasNewer: boolean } | undefined {
    const context = this.messages.context(id, before, after);
    if (!context || (context.target.role !== 'user' && context.target.role !== 'assistant')) return undefined;
    return {
      target: context.target,
      messages: context.messages.filter((message) => message.role === 'user' || message.role === 'assistant'),
      hasOlder: context.hasOlder,
      hasNewer: context.hasNewer
    };
  }
}

function historyWhere(options: AdminHistoryOptions): { where: string[]; values: unknown[] } {
  const where = ["m.conversation_id = 'main'", "m.role IN ('user','assistant')"];
  const values: unknown[] = [];
  if (options.role) { where.push('m.role = ?'); values.push(options.role); }
  if (options.from) { where.push('m.created_at >= ?'); values.push(options.from); }
  if (options.to) { where.push('m.created_at <= ?'); values.push(options.to); }
  const q = options.q?.trim();
  if (q) {
    where.push(`EXISTS (
      SELECT 1 FROM message_parts p
      LEFT JOIN media ON media.id = p.media_id
      LEFT JOIN media_text ON media_text.media_id = p.media_id
      WHERE p.message_id = m.id
        AND lower(COALESCE(p.text, p.transcript, media.rel_path, media_text.text, '')) LIKE lower('%' || ? || '%')
    )`);
    values.push(q.slice(0, 200));
  }
  if (options.hasMedia === true) where.push('EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.id AND p.media_id IS NOT NULL)');
  if (options.hasMedia === false) where.push('NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.id AND p.media_id IS NOT NULL)');
  if (options.mediaKind) {
    where.push('EXISTS (SELECT 1 FROM message_parts p JOIN media ON media.id = p.media_id WHERE p.message_id = m.id AND media.kind = ?)');
    values.push(options.mediaKind);
  }
  return { where, values };
}
