import { useCallback, useEffect, useRef, useState } from 'react';
import { blobForMediaUrl } from '../lib/authenticatedMedia.js';

export interface ViewerImage {
  id: string;
  src: string;
  alt: string;
}

interface Props {
  images: ViewerImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Optional async boundary loaders. Used by paginated galleries/chat history. */
  onRequestPrevious?: () => void | Promise<void>;
  onRequestNext?: () => void | Promise<void>;
  /** Override the local loaded-array count, e.g. `61 / 120` or `60+`. */
  countLabel?: string;
  navigationBusy?: boolean;
}

const SWIPE_X = 52;
const CLOSE_Y = 80;
const MIN_SCALE = 1;
const MAX_SCALE = 4;

function extensionFromUrl(src: string): string {
  const clean = src.split('?')[0] ?? '';
  return /\.([a-z0-9]{2,5})$/i.exec(clean)?.[1]?.toLowerCase() ?? 'jpg';
}

async function imageBlob(image: ViewerImage): Promise<Blob> {
  const loaded = blobForMediaUrl(image.src);
  if (loaded) return loaded;
  const response = await fetch(image.src);
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  return await response.blob();
}

async function saveImage(image: ViewerImage): Promise<void> {
  const blob = await imageBlob(image);
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `${image.alt || 'sooya-image'}.${extensionFromUrl(image.src)}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

async function shareImage(image: ViewerImage): Promise<void> {
  try {
    const blob = await imageBlob(image);
    const file = new File([blob], `${image.alt || 'sooya-image'}.${extensionFromUrl(image.src)}`, { type: blob.type || 'image/jpeg' });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({ title: image.alt || 'SOOYA 图片', files: [file] });
      return;
    }
    await saveImage(image);
  } catch (error) {
    if ((error as DOMException).name === 'AbortError') return;
    await saveImage(image);
  }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function withoutViewerMarker(state: unknown): unknown {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const next = { ...(state as Record<string, unknown>) };
  delete next.sooyaImageViewer;
  return next;
}

export function ImageViewer({
  images,
  index,
  onIndexChange,
  onClose,
  onRequestPrevious,
  onRequestNext,
  countLabel,
  navigationBusy = false
}: Props) {
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startX: number; startY: number; panX: number; panY: number; scale: number; pinchDistance: number } | null>(null);
  const dragRef = useRef({ x: 0, y: 0 });
  const onCloseRef = useRef(onClose);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const current = images[index];
  onCloseRef.current = onClose;

  const clampPan = useCallback((x: number, y: number, nextScale = scale) => {
    const maxX = Math.max(0, (window.innerWidth * (nextScale - 1)) / 2);
    const maxY = Math.max(0, (window.innerHeight * (nextScale - 1)) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  }, [scale]);

  const reset = useCallback(() => { dragRef.current = { x: 0, y: 0 }; setScale(1); setPan({ x: 0, y: 0 }); setDrag({ x: 0, y: 0 }); }, []);
  const canPrevious = !navigationBusy && (index > 0 || Boolean(onRequestPrevious));
  const canNext = !navigationBusy && (index < images.length - 1 || Boolean(onRequestNext));
  const previous = useCallback(() => {
    if (navigationBusy) return;
    reset();
    if (index > 0) onIndexChange(index - 1);
    else if (onRequestPrevious) void onRequestPrevious();
  }, [index, navigationBusy, onIndexChange, onRequestPrevious, reset]);
  const next = useCallback(() => {
    if (navigationBusy) return;
    reset();
    if (index < images.length - 1) onIndexChange(index + 1);
    else if (onRequestNext) void onRequestNext();
  }, [images.length, index, navigationBusy, onIndexChange, onRequestNext, reset]);
  const setZoom = useCallback((value: number) => {
    const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
    setScale(nextScale);
    setPan((before) => nextScale === 1 ? { x: 0, y: 0 } : clampPan(before.x, before.y, nextScale));
  }, [clampPan]);

  /*
   * A modal owns exactly one history entry. The old effect depended on the
   * parent's inline onClose callback, so every parent render briefly removed
   * and re-added the popstate listener. That made same-URL back navigation
   * flaky under load. Keep one stable listener for the lifetime of the viewer.
   * Also strip a stale legacy marker before pushing the owned entry so an old
   * broken session cannot require two Back presses to close the next viewer.
   */
  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const baseState = withoutViewerMarker(history.state);
    if (history.state?.sooyaImageViewer) history.replaceState(baseState, '');
    history.pushState({ ...(baseState && typeof baseState === 'object' ? baseState : {}), sooyaImageViewer: true }, '');
    const pop = () => onCloseRef.current();
    window.addEventListener('popstate', pop);
    return () => {
      document.body.style.overflow = oldOverflow;
      window.removeEventListener('popstate', pop);
    };
  }, []);

  const requestClose = useCallback(() => {
    if (history.state?.sooyaImageViewer === true) history.back();
    else onCloseRef.current();
  }, []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
      else if (event.key === 'ArrowLeft' && canPrevious && scale === 1) previous();
      else if (event.key === 'ArrowRight' && canNext && scale === 1) next();
      else if (event.key === '+' || event.key === '=') setZoom(scale + 0.5);
      else if (event.key === '-') setZoom(scale - 0.5);
      else if (event.key === '0') reset();
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && current) { event.preventDefault(); void saveImage(current); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [canNext, canPrevious, current, next, previous, requestClose, reset, scale, setZoom]);

  useEffect(reset, [index, reset]);
  if (!current) return null;

  const finishGesture = () => {
    if (pointers.current.size > 0) return;
    const movement = dragRef.current;
    if (scale === 1) {
      if (Math.abs(movement.y) >= CLOSE_Y && Math.abs(movement.y) > Math.abs(movement.x)) requestClose();
      else if (canNext && movement.x <= -SWIPE_X) next();
      else if (canPrevious && movement.x >= SWIPE_X) previous();
    }
    dragRef.current = { x: 0, y: 0 };
    setDrag({ x: 0, y: 0 });
    gesture.current = null;
  };

  return (
    <div
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="图片查看器"
      aria-busy={navigationBusy || undefined}
      onClick={(event) => { if (event.target === event.currentTarget && scale === 1) requestClose(); }}
      onWheel={(event) => { event.preventDefault(); setZoom(scale + (event.deltaY < 0 ? 0.25 : -0.25)); }}
      onPointerDown={(event) => {
        if ((event.target as Element).closest('.image-viewer-actions, .image-viewer-nav')) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture(event.pointerId);
        const points = [...pointers.current.values()];
        gesture.current = {
          startX: event.clientX,
          startY: event.clientY,
          panX: pan.x,
          panY: pan.y,
          scale,
          pinchDistance: points.length >= 2 ? distance(points[0]!, points[1]!) : 0
        };
      }}
      onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId)) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const points = [...pointers.current.values()];
        const start = gesture.current;
        if (!start) return;
        if (points.length >= 2 && start.pinchDistance > 0) {
          const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, start.scale * distance(points[0]!, points[1]!) / start.pinchDistance));
          setScale(nextScale);
          setPan((before) => clampPan(before.x, before.y, nextScale));
        } else if (scale > 1) {
          setPan(clampPan(start.panX + event.clientX - start.startX, start.panY + event.clientY - start.startY));
        } else {
          const movement = { x: event.clientX - start.startX, y: event.clientY - start.startY };
          dragRef.current = movement;
          setDrag(movement);
        }
      }}
      onPointerUp={(event) => { pointers.current.delete(event.pointerId); finishGesture(); }}
      onPointerCancel={(event) => { pointers.current.delete(event.pointerId); finishGesture(); }}
    >
      <div className="image-viewer-backdrop" style={{ backgroundImage: `url(${JSON.stringify(current.src).slice(1, -1)})` }} />
      <div className="image-viewer-shade" />
      <div className="image-viewer-actions">
        <a className="image-viewer-action" href="/gallery" onClick={(event) => event.stopPropagation()}>图库</a>
        <button type="button" className="image-viewer-action" onClick={(event) => { event.stopPropagation(); void shareImage(current); }}>分享</button>
        <button type="button" className="image-viewer-action" onClick={(event) => { event.stopPropagation(); void saveImage(current); }}>保存</button>
        <button type="button" className="image-viewer-action" onClick={(event) => { event.stopPropagation(); setZoom(scale - 0.5); }} aria-label="缩小">−</button>
        <button type="button" className="image-viewer-action" onClick={(event) => { event.stopPropagation(); setZoom(scale + 0.5); }} aria-label="放大">＋</button>
        <button type="button" className="image-viewer-close" onClick={requestClose} aria-label="关闭图片">×</button>
      </div>
      {(canPrevious || canNext || images.length > 1) && scale === 1 && <>
        {canPrevious && <button type="button" className="image-viewer-nav previous" onClick={previous} aria-label="上一张">‹</button>}
        {canNext && <button type="button" className="image-viewer-nav next" onClick={next} aria-label="下一张">›</button>}
        <div className="image-viewer-count">{countLabel ?? `${index + 1} / ${images.length}`}</div>
      </>}
      <img
        className="image-viewer-current"
        src={current.src}
        alt={current.alt}
        draggable={false}
        onDoubleClick={(event) => { event.stopPropagation(); if (scale > 1) reset(); else setZoom(2); }}
        style={{
          touchAction: 'none',
          transform: `translate3d(${scale > 1 ? pan.x : drag.x}px, ${scale > 1 ? pan.y : drag.y}px, 0) scale(${scale > 1 ? scale : Math.max(0.88, 1 - Math.abs(drag.y) / 900)})`,
          opacity: scale > 1 ? 1 : Math.max(0.45, 1 - Math.abs(drag.y) / 400),
          cursor: scale > 1 ? 'grab' : 'zoom-in'
        }}
      />
      <div className="image-viewer-hint">{scale > 1 ? `${Math.round(scale * 100)}% · 拖动查看细节 · 双击还原` : '左右滑动切换 · 下滑退出 · 双击或捏合放大'}</div>
    </div>
  );
}
