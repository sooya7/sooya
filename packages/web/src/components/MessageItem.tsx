import { memo, useState } from 'react';
import { mediaUrl } from '../lib/api.js';
import type { ChatMessage, MessagePart } from '../lib/types.js';
import { AudioBubble } from './AudioBubble.js';

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ImagePart({ part, onOpen }: { part: MessagePart; onOpen?: (mediaId: string) => void }) {
  const [failed, setFailed] = useState(false);
  if (part.status === 'failed') {
    return <div className="bubble bubble-note">图片没有发出去{part.error ? `：${part.error}` : ''}</div>;
  }
  if (part.status === 'pending' || !part.media) return <div className="bubble bubble-note pulsing">图片生成中…</div>;
  if (failed) return <div className="bubble bubble-note">图片加载失败</div>;
  const ratio = part.media.width && part.media.height ? part.media.width / part.media.height : undefined;
  return (
    <button className="image-part" type="button" onClick={() => onOpen?.(part.media!.id)} aria-label="查看大图">
      <img
        src={mediaUrl(part.media.url)}
        alt={part.media.name ?? '图片'}
        loading="lazy"
        style={ratio ? { aspectRatio: String(ratio) } : undefined}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

function StickerPart({ part }: { part: MessagePart }) {
  const [failed, setFailed] = useState(false);
  if (!part.media || failed) return null;
  return <img className="sticker-part" src={mediaUrl(part.media.url)} alt={String(part.meta?.stickerName ?? '表情')} loading="lazy" onError={() => setFailed(true)} />;
}

function FilePart({ part }: { part: MessagePart }) {
  if (!part.media) return <div className="bubble bubble-note">文件不可用</div>;
  return (
    <a className="bubble bubble-file" href={mediaUrl(part.media.url)} target="_blank" rel="noreferrer" download>
      <span className="file-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M14 2v5h5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
      </span>
      <span className="file-meta"><span className="file-name">{part.media.name ?? '文件'}</span><span className="file-size">{formatBytes(part.media.bytes)}</span></span>
    </a>
  );
}

interface Props {
  message: ChatMessage;
  personaName: string;
  avatar: string;
  userAvatar: string;
  showAvatar: boolean;
  onRetry?: (message: ChatMessage) => void;
  onOpenImage?: (mediaId: string) => void;
}

export const MessageItem = memo(function MessageItem({ message, personaName, avatar, userAvatar, showAvatar, onRetry, onOpenImage }: Props) {
  const mine = message.role === 'user';
  const visible = message.content.filter((p) => p.type !== 'system');
  const failedMessage = message.status === 'failed';

  if (message.role === 'system') {
    return <div className="system-row"><span>{message.content.map((p) => p.text).filter(Boolean).join(' ')}</span></div>;
  }

  return (
    <div className={`msg-row ${mine ? 'mine' : 'theirs'}`} data-role={message.role} data-status={message.status} data-testid="message">
      <div className="avatar-slot">{showAvatar && <img className="avatar" src={mine ? userAvatar : avatar} alt={mine ? '我' : personaName} draggable={false} />}</div>
      <div className="msg-body">
        <div className="bubbles">
          {visible.map((part) => {
            switch (part.type) {
              case 'text': return part.text ? <div key={part.id} className={`bubble bubble-text ${mine ? 'mine' : 'theirs'}`} data-testid="text-bubble">{part.text}</div> : null;
              case 'sticker': return <StickerPart key={part.id} part={part} />;
              case 'image': return <ImagePart key={part.id} part={part} onOpen={onOpenImage} />;
              case 'audio': return <AudioBubble key={part.id} part={part} mine={mine} />;
              case 'file': return <FilePart key={part.id} part={part} />;
              default: return null;
            }
          })}
        </div>
        <div className="msg-meta">
          <span className="clock">{formatClock(message.createdAt)}</span>
          {message.pendingLocal && message.status !== 'failed' && <span className="sending-dot" aria-label="发送中" />}
          {failedMessage && <span className="failed-flag">发送失败{onRetry && <button type="button" className="retry-btn" onClick={() => onRetry(message)}>重试</button>}</span>}
        </div>
      </div>
    </div>
  );
});
