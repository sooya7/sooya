import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '../../ui.js';

const LAYER_KEY = 'csMediaLayer';
let pendingBack: number | null = null;
const isLayerEntry = () => Boolean((window.history.state as Record<string, unknown> | null)?.[LAYER_KEY]);

/**
 * Full-screen layer for looking at one item: the media on one side, details and
 * actions on the other. Esc and the browser's back close it, arrow keys step through the list.
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

    // Phones close a full-screen view with the back gesture: the layer owns one history entry
    // (same URL, marked in state) and the browser's back pops it to close the layer.
    if (pendingBack !== null) { window.clearTimeout(pendingBack); pendingBack = null; }
    if (!isLayerEntry()) window.history.pushState({ ...(window.history.state ?? {}), [LAYER_KEY]: true }, '');
    let poppedByBack = false;
    const onPop = () => {
      if (isLayerEntry()) return;
      poppedByBack = true;
      handlers.current.onClose();
    };
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      document.body.style.overflow = overflow;
      before?.focus?.();
      // Closed from inside (button, Esc): drop our entry so history does not grow. Deferred so a
      // StrictMode remount, which runs this cleanup and mounts again at once, can take it back.
      if (!poppedByBack && isLayerEntry()) {
        pendingBack = window.setTimeout(() => { pendingBack = null; if (isLayerEntry()) window.history.back(); }, 0);
      }
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
