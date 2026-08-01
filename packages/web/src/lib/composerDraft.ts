export interface ComposerDraft {
  text: string;
  replyTo: string | null;
  readyAttachmentIds: string[];
  updatedAt: number;
}

export const COMPOSER_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function composerDraftKey(conversationId: string): string {
  return `sooya.composer-draft:${conversationId}`;
}

export function readComposerDraft(
  storage: Storage | undefined,
  conversationId: string,
  now = Date.now()
): ComposerDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(composerDraftKey(conversationId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ComposerDraft>;
    if (!Number.isFinite(value.updatedAt) || now - Number(value.updatedAt) > COMPOSER_DRAFT_MAX_AGE_MS || now < Number(value.updatedAt) - 60_000) {
      storage.removeItem(composerDraftKey(conversationId));
      return null;
    }
    return {
      text: typeof value.text === 'string' ? value.text : '',
      replyTo: typeof value.replyTo === 'string' && value.replyTo ? value.replyTo : null,
      readyAttachmentIds: Array.isArray(value.readyAttachmentIds)
        ? value.readyAttachmentIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 20)
        : [],
      updatedAt: Number(value.updatedAt)
    };
  } catch {
    return null;
  }
}

export function writeComposerDraft(storage: Storage | undefined, conversationId: string, draft: Omit<ComposerDraft, 'updatedAt'>, now = Date.now()): void {
  if (!storage) return;
  try {
    if (!draft.text.trim() && !draft.replyTo && draft.readyAttachmentIds.length === 0) {
      storage.removeItem(composerDraftKey(conversationId));
      return;
    }
    storage.setItem(composerDraftKey(conversationId), JSON.stringify({ ...draft, updatedAt: now } satisfies ComposerDraft));
  } catch {
    // Private browsing and quota errors must never interrupt typing.
  }
}

export function clearComposerDraft(storage: Storage | undefined, conversationId: string): void {
  try { storage?.removeItem(composerDraftKey(conversationId)); } catch { /* private mode */ }
}
