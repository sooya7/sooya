// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { clearComposerDraft, composerDraftKey, readComposerDraft, writeComposerDraft } from './composerDraft.js';

describe('composer draft storage', () => {
  beforeEach(() => sessionStorage.clear());

  it('stores only the serializable draft fields', () => {
    writeComposerDraft(sessionStorage, 'main', { text: '还没说完', replyTo: 'm_7', readyAttachmentIds: ['media_1'] }, 1000);

    expect(JSON.parse(sessionStorage.getItem(composerDraftKey('main'))!)).toEqual({
      text: '还没说完', replyTo: 'm_7', readyAttachmentIds: ['media_1'], updatedAt: 1000
    });
    expect(readComposerDraft(sessionStorage, 'main', 1000)).toEqual({
      text: '还没说完', replyTo: 'm_7', readyAttachmentIds: ['media_1'], updatedAt: 1000
    });
  });

  it('drops drafts older than seven days and malformed values', () => {
    writeComposerDraft(sessionStorage, 'old', { text: '过期', replyTo: null, readyAttachmentIds: [] }, 0);
    expect(readComposerDraft(sessionStorage, 'old', 7 * 24 * 60 * 60 * 1000 + 1)).toBeNull();
    sessionStorage.setItem(composerDraftKey('bad'), '{not json');
    expect(readComposerDraft(sessionStorage, 'bad')).toBeNull();
  });

  it('clears empty drafts and explicitly clears after successful send', () => {
    writeComposerDraft(sessionStorage, 'main', { text: 'x', replyTo: null, readyAttachmentIds: [] });
    writeComposerDraft(sessionStorage, 'main', { text: '', replyTo: null, readyAttachmentIds: [] });
    expect(sessionStorage.getItem(composerDraftKey('main'))).toBeNull();
    writeComposerDraft(sessionStorage, 'main', { text: 'x', replyTo: null, readyAttachmentIds: [] });
    clearComposerDraft(sessionStorage, 'main');
    expect(readComposerDraft(sessionStorage, 'main')).toBeNull();
  });
});
