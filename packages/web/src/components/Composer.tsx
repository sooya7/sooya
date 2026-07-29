import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import type { MediaRef, StickerInfo } from '../lib/types.js';
import { VoiceRecorder } from './VoiceRecorder.js';
import { AuthenticatedImage } from './AuthenticatedMedia.js';

export interface PendingAttachment {
  key: string;
  media: MediaRef;
  previewUrl: string;
  kind: 'image' | 'audio' | 'file';
  name: string;
}

interface Props {
  disabled: boolean;
  onSend: (content: Array<Record<string, unknown>>) => Promise<unknown>;
  onNotice: (text: string) => void;
}

export function Composer({ disabled, onSend, onNotice }: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [stickers, setStickers] = useState<StickerInfo[]>([]);
  const [showStickers, setShowStickers] = useState(false);
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void api
      .stickers()
      .then((r) => setStickers(r.stickers))
      .catch(() => setStickers([]));
  }, []);

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, []);

  useEffect(autoGrow, [text, autoGrow]);

  const uploadFiles = useCallback(
    async (files: File[], field: 'image' | 'file') => {
      if (files.length === 0) return;
      setUploading(true);
      try {
        const res = await api.upload(
          files.map((f) => ({ file: f, field: f.type.startsWith('image/') ? 'image' : field, name: f.name }))
        );
        if (res.failed.length > 0) {
          onNotice(`${res.failed.length} 个文件未能上传：${res.failed[0]!.error}`);
        }
        setAttachments((prev) => [
          ...prev,
          ...res.media.map((m) => ({
            key: m.id,
            media: m,
            previewUrl: '',
            kind: m.kind === 'sticker' ? ('image' as const) : (m.kind as 'image' | 'audio' | 'file'),
            name: m.name ?? '文件'
          }))
        ]);
      } catch (err) {
        onNotice(`上传失败：${(err as Error).message}`);
      } finally {
        setUploading(false);
      }
    },
    [onNotice]
  );

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

  const canSend = !disabled && !sending && (text.trim().length > 0 || attachments.length > 0);

  const doSend = useCallback(async () => {
    if (!canSend) return;
    const content: Array<Record<string, unknown>> = [];
    if (text.trim()) content.push({ type: 'text', text: text.trim() });
    for (const a of attachments) {
      if (a.kind === 'image') content.push({ type: 'image', mediaId: a.media.id });
      else if (a.kind === 'audio')
        content.push({
          type: 'audio',
          mediaId: a.media.id,
          duration: a.media.duration ?? undefined,
          transcript: a.media.transcript ?? undefined
        });
      else content.push({ type: 'file', mediaId: a.media.id });
    }
    if (content.length === 0) return;
    setSending(true);
    try {
      await onSend(content);
      setText('');
      setAttachments([]);
      setShowStickers(false);
    } catch {
      /* error surfaced by the parent */
    } finally {
      setSending(false);
    }
  }, [attachments, canSend, onSend, text]);

  const sendSticker = useCallback(
    async (sticker: StickerInfo) => {
      setShowStickers(false);
      try {
        await onSend([{ type: 'sticker', mediaId: sticker.mediaId }]);
      } catch {
        /* handled upstream */
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
              <AuthenticatedImage path={s.url} scope="user" alt={s.name} loading="lazy" />
            </button>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="attachment-strip" data-testid="attachment-strip">
          {attachments.map((a) => (
            <div key={a.key} className="attachment">
              {a.kind === 'image' ? (
                <AuthenticatedImage path={a.media.url} scope="user" alt={a.name} />
              ) : a.kind === 'audio' ? (
                <span className="attachment-generic">🎤 {Math.round(a.media.duration ?? 0)}s</span>
              ) : (
                <span className="attachment-generic">{a.name}</span>
              )}
              <button
                type="button"
                className="attachment-remove"
                aria-label="移除附件"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.key !== a.key))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {recording ? (
        <VoiceRecorder
          onCancel={() => setRecording(false)}
          onNotice={onNotice}
          onReady={(media) => {
            setAttachments((prev) => [
              ...prev,
              { key: media.id, media, previewUrl: '', kind: 'audio', name: '语音' }
            ]);
            setRecording(false);
          }}
        />
      ) : (
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
            placeholder={disabled ? '连接中…' : '说点什么…'}
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
            className="icon-btn"
            aria-label="录制语音"
            data-testid="btn-voice"
            onClick={() => setRecording(true)}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>

          <button
            type="button"
            className={`send-btn ${canSend ? 'active' : ''}`}
            data-testid="btn-send"
            disabled={!canSend}
            onClick={() => void doSend()}
            aria-label="发送"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M3.5 11.5 20 4l-7.5 16.5-2-7-7-2z" fill="currentColor" />
            </svg>
          </button>
        </div>
      )}

      {uploading && <div className="composer-hint">正在上传…</div>}

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
