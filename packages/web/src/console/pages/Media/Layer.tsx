import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '../../ui.js';

/**
 * Full-screen layer for looking at one item: the media on one side, details and
 * actions on the other. Esc closes, arrow keys step through the list.
 */
export function Layer({ title, position, onClose, onPrev, onNext, media, children }: {
  title: string;
  position?: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  media: ReactNode;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const handlers = useRef({ onClose, onPrev, onNext });
  handlers.current = { onClose, onPrev, onNext };

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable]');
      if (event.key === 'Escape') { event.stopPropagation(); handlers.current.onClose(); }
      else if (!typing && event.key === 'ArrowLeft') handlers.current.onPrev?.();
      else if (!typing && event.key === 'ArrowRight') handlers.current.onNext?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, []);

  return (
    <div className="media-layer" role="dialog" aria-modal="true" aria-label={title}>
      <div className="media-layer-bar">
        <strong className="media-layer-title">{title}</strong>
        {position && <span className="cs-muted">{position}</span>}
        <span className="media-layer-nav">
          {(onPrev || onNext) && (
            <>
              <Button kind="quiet" size="sm" disabled={!onPrev} onClick={onPrev}>上一个</Button>
              <Button kind="quiet" size="sm" disabled={!onNext} onClick={onNext}>下一个</Button>
            </>
          )}
          <button ref={closeRef} type="button" className="cs-btn" data-kind="quiet" data-size="sm" onClick={onClose}>关闭</button>
        </span>
      </div>
      <div className="media-layer-body">
        <div className="media-layer-media">{media}</div>
        <div className="media-layer-side">{children}</div>
      </div>
    </div>
  );
}
