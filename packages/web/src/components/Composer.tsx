import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { clearComposerDraft, readComposerDraft, writeComposerDraft } from '../lib/composerDraft.js';
import type { ChatMessage, MediaRef, StickerInfo } from '../lib/types.js';
import { mediaThumbnailPath } from '../lib/authenticatedMedia.js';
import { AuthenticatedImage } from './AuthenticatedMedia.js';

export interface PendingAttachment {
  key: string;
  media?: MediaRef;
  localFile?: File;
  previewUrl?: string;
  kind: 'image' | 'file';
  name: string;
  status: 'queued' | 'uploading' | 'ready' | 'failed' | 'cancelled';
  progress: number;
  error?: string;
}

export interface ComposerSendPayload {
  content: Array<Record<string, unknown>>;
  optimisticParts: ChatMessage['content'];
}

interface Props {
  disabled: boolean;
  disabledLabel?: string;
  conversationId?: string;
  replyToId?: string | null;
  onRestoreReplyTo?: (id: string) => void;
  stickers: StickerInfo[];
  onSend: (payload: ComposerSendPayload) => Promise<unknown>;
  onNotice: (text: string) => void;
}

export function Composer({ disabled, disabledLabel, conversationId = 'main', replyToId = null, onRestoreReplyTo, stickers, onSend, onNotice }: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [showStickers, setShowStickers] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const controllersRef = useRef(new Map<string, AbortController>());
  const cancelledKeysRef = useRef(new Set<string>());

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftHydratedRef = useRef(false);

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, []);

  useEffect(autoGrow, [text, autoGrow]);
  useEffect(() => {
    const draft = readComposerDraft(typeof window === 'undefined' ? undefined : window.sessionStorage, conversationId);
    if (!draft) { draftHydratedRef.current = true; return; }
    setText(draft.text);
    if (draft.replyTo) onRestoreReplyTo?.(draft.replyTo);
    if (draft.readyAttachmentIds.length === 0) { draftHydratedRef.current = true; return; }
    let cancelled = false;
    void Promise.all(draft.readyAttachmentIds.map(async (id) => {
      try {
        const result = await api.mediaMeta(id);
        return result.exists ? result.media : null;
      } catch { return null; }
    })).then((media) => {
      if (cancelled) return;
      setAttachments(media.filter((item): item is MediaRef => Boolean(item)).map((item, index) => ({
        key: `restored_${item.id}_${index}`, media: item, kind: item.kind === 'image' || item.kind === 'sticker' ? 'image' : 'file',
        name: item.name ?? item.id, status: 'ready', progress: 100
      })));
      draftHydratedRef.current = true;
    });
    return () => { cancelled = true; };
  }, [conversationId, onRestoreReplyTo]);
  useEffect(() => {
    if (!draftHydratedRef.current) return;
    const timer = window.setTimeout(() => writeComposerDraft(window.sessionStorage, conversationId, {
      text, replyTo: replyToId, readyAttachmentIds: attachments.filter((item) => item.status === 'ready' && item.media).map((item) => item.media!.id)
    }), 300);
    return () => window.clearTimeout(timer);
  }, [attachments, conversationId, replyToId, text]);
  useEffect(() => () => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
  }, []);

  const updateAttachment = useCallback((key: string, patch: Partial<PendingAttachment>) => {
    setAttachments((previous) => previous.map((item) => item.key === key ? { ...item, ...patch } : item));
  }, []);

  const uploadTask = useCallback(async (task: PendingAttachment) => {
    if (!task.localFile || cancelledKeysRef.current.has(task.key)) return;
    const controller = new AbortController();
    controllersRef.current.set(task.key, controller);
    updateAttachment(task.key, { status: 'uploading', progress: 0, error: undefined });
    try {
      const result = await api.upload([{ file: task.localFile, field: task.kind, name: task.name }], { signal: controller.signal });
      const media = result.media.find((item) => item.kind === 'image' || item.kind === 'sticker' || item.kind === 'file');
      if (!media) throw new Error(result.failed[0]?.error ?? '文件上传失败');
      if (cancelledKeysRef.current.has(task.key)) return;
      updateAttachment(task.key, {
        media,
        kind: media.kind === 'image' || media.kind === 'sticker' ? 'image' : 'file',
        name: media.name ?? task.name,
        status: 'ready',
        progress: 100
      });
      if (result.failed.length > 0) onNotice(`${result.failed.length} 个文件未能上传：${result.failed[0]!.error}`);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : '文件上传失败';
      updateAttachment(task.key, { status: 'failed', progress: 0, error: message });
      onNotice(`上传失败：${message}`);
    } finally {
      controllersRef.current.delete(task.key);
    }
  }, [onNotice, updateAttachment]);

  const uploadFiles = useCallback(async (files: File[], field: 'image' | 'file') => {
    const queued = files.map((file, index): PendingAttachment => ({
      key: `upload_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 7)}`,
      localFile: file,
      kind: file.type.startsWith('image/') ? 'image' : field,
      name: file.name,
      status: 'queued',
      progress: 0
    }));
    if (queued.length === 0) return;
    setAttachments((previous) => [...previous, ...queued]);
    let cursor = 0;
    const worker = async () => {
      while (cursor < queued.length) {
        const task = queued[cursor++];
        if (task) await uploadTask(task);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, queued.length) }, () => worker()));
  }, [uploadTask]);

  const cancelUpload = useCallback((task: PendingAttachment) => {
    cancelledKeysRef.current.add(task.key);
    controllersRef.current.get(task.key)?.abort();
    controllersRef.current.delete(task.key);
    setAttachments((previous) => previous.filter((item) => item.key !== task.key));
  }, []);

  const retryUpload = useCallback((task: PendingAttachment) => {
    if (!task.localFile) return;
    cancelledKeysRef.current.delete(task.key);
    updateAttachment(task.key, { status: 'queued', progress: 0, error: undefined });
    void uploadTask({ ...task, status: 'queued', progress: 0, error: undefined });
  }, [updateAttachment, uploadTask]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files: File[] = [];
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void uploadFiles(files, 'image');
      }
    },
    [uploadFiles]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) void uploadFiles(files, 'file');
    },
    [uploadFiles]
  );

  const readyAttachments = attachments.filter((item) => item.status === 'ready' && item.media);
  const hasPendingUploads = attachments.some((item) => item.status === 'queued' || item.status === 'uploading');
  const settledAttachmentCount = attachments.filter((item) => item.status === 'ready' || item.status === 'failed').length;
  const canSend = !disabled && !sending && !hasPendingUploads && (text.trim().length > 0 || readyAttachments.length > 0);

  const doSend = useCallback(async () => {
    if (!canSend) return;
    const content: Array<Record<string, unknown>> = [];
    if (text.trim()) content.push({ type: 'text', text: text.trim() });
    const optimisticParts: ChatMessage['content'] = [];
    if (text.trim()) optimisticParts.push({ id: 'localpart_text', type: 'text', text: text.trim(), status: 'pending' });
    for (const a of readyAttachments) {
      if (!a.media) continue;
      const type = a.kind === 'image' ? 'image' : 'file';
      content.push({ type, mediaId: a.media.id });
      optimisticParts.push({ id: `localpart_${a.key}`, type, mediaId: a.media.id, media: a.media, status: 'pending' });
    }
    if (content.length === 0) return;
    setSending(true);
    try {
      await onSend({ content, optimisticParts });
      setText('');
      setAttachments([]);
      setShowStickers(false);
      clearComposerDraft(window.sessionStorage, conversationId);
    } catch {
      /* error surfaced by the parent */
    } finally {
      setSending(false);
    }
  }, [canSend, conversationId, onSend, readyAttachments, text]);

  const sendSticker = useCallback(
    async (sticker: StickerInfo) => {
      setShowStickers(false);
      setSending(true);
      try {
        await onSend({
          content: [{ type: 'sticker', mediaId: sticker.mediaId }],
          optimisticParts: [{ id: `localpart_${sticker.id}`, type: 'sticker', mediaId: sticker.mediaId, status: 'pending', media: { id: sticker.mediaId, kind: 'sticker', mime: 'image/*', bytes: 0, url: sticker.url, name: sticker.name } }]
        });
      } catch {
        /* handled upstream */
      } finally {
        setSending(false);
      }
    },
    [onSend]
  );

  return (
    <div
      className={`composer ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      {showStickers && (
        <div className="sticker-panel" data-testid="sticker-panel">
          {stickers.length === 0 && <div className="sticker-empty">还没有可用的表情包</div>}
          {stickers.map((s) => (
            <button key={s.id} type="button" className="sticker-choice" onClick={() => void sendSticker(s)} title={s.emotion}>
              <AuthenticatedImage path={mediaThumbnailPath(s.url, 96)} scope="user" alt={s.name} loading="lazy" />
            </button>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="attachment-strip" data-testid="attachment-strip">
          {hasPendingUploads && <small role="status">附件处理进度 {settledAttachmentCount}/{attachments.length}</small>}
          {attachments.map((a) => (
            <div key={a.key} className="attachment">
              {a.kind === 'image' && a.media ? (
                <AuthenticatedImage path={a.media.url} scope="user" alt={a.name} />
              ) : (
                <span className="attachment-generic">{a.name}</span>
              )}
              {a.status === 'queued' && <small role="status">等待上传</small>}
              {a.status === 'uploading' && <small role="status">正在上传</small>}
              {a.status === 'failed' && <small role="status">上传失败：{a.error}</small>}
              <button
                type="button"
                className="attachment-remove"
                aria-label={a.status === 'failed' ? '移除失败附件' : '取消上传'}
                onClick={() => cancelUpload(a)}
              >
                ×
              </button>
              {a.status === 'failed' && <button type="button" onClick={() => retryUpload(a)}>重试上传</button>}
            </div>
          ))}
        </div>
      )}
      {attachments.some((attachment) => attachment.kind === 'file') && <div className="composer-file-hint" role="note">文件会被保存并发送；当前仅部分文本格式可读取，其他格式机器人只能看到文件名。</div>}

      <div className="composer-row">
          <button
            type="button"
            className="icon-btn"
            aria-label="表情"
            data-testid="btn-sticker"
            onClick={() => setShowStickers((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <circle cx="9" cy="10" r="1.3" fill="currentColor" />
              <circle cx="15" cy="10" r="1.3" fill="currentColor" />
              <path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>

          <button
            type="button"
            className="icon-btn"
            aria-label="发送图片"
            data-testid="btn-image"
            onClick={() => imageInputRef.current?.click()}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <circle cx="8.5" cy="10" r="1.5" fill="currentColor" />
              <path d="M4.5 17.5 10 12l3.5 3.5L16 13l3.5 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            </svg>
          </button>

          <button
            type="button"
            className="icon-btn"
            aria-label="发送文件"
            data-testid="btn-file"
            onClick={() => fileInputRef.current?.click()}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path
                d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8L9.7 17.3a1.8 1.8 0 0 1-2.5-2.5l8-8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>

          <textarea
            ref={textareaRef}
            className="composer-input"
            data-testid="composer-input"
            value={text}
            rows={1}
            placeholder={disabledLabel ?? (disabled ? '连接中…' : '说点什么…')}
            onChange={(e) => setText(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void doSend();
              }
            }}
          />

          <button
            type="button"
            className={`send-btn ${canSend ? 'active' : ''}`}
            data-testid="btn-send"
            disabled={!canSend}
            onClick={() => void doSend()}
            aria-label={disabledLabel ?? '发送'}
            title={disabledLabel}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M3.5 11.5 20 4l-7.5 16.5-2-7-7-2z" fill="currentColor" />
            </svg>
          </button>
        </div>

      {disabled && disabledLabel && <div className="composer-hint composer-offline-hint" role="status">{disabledLabel}</div>}
      {hasPendingUploads && <div className="composer-hint">正在上传…</div>}

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="input-image"
        onChange={(e) => {
          void uploadFiles(Array.from(e.target.files ?? []), 'image');
          e.target.value = '';
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        data-testid="input-file"
        onChange={(e) => {
          void uploadFiles(Array.from(e.target.files ?? []), 'file');
          e.target.value = '';
        }}
      />
    </div>
  );
}
