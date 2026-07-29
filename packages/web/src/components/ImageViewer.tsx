import { useEffect, useRef, useState } from 'react';

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
}

const SWIPE_X = 52;
const CLOSE_Y = 80;

export function ImageViewer({ images, index, onIndexChange, onClose }: Props) {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const current = images[index];

  const previous = () => onIndexChange((index - 1 + images.length) % images.length);
  const next = () => onIndexChange((index + 1) % images.length);

  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    history.pushState({ sooyaImageViewer: true }, '');

    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && images.length > 1) previous();
      if (event.key === 'ArrowRight' && images.length > 1) next();
    };
    const pop = () => onClose();
    window.addEventListener('keydown', key);
    window.addEventListener('popstate', pop, { once: true });
    return () => {
      document.body.style.overflow = oldOverflow;
      window.removeEventListener('keydown', key);
      window.removeEventListener('popstate', pop);
    };
  }, [index, images.length, onClose]);

  if (!current) return null;

  const finish = () => {
    const { x, y } = drag;
    if (Math.abs(y) >= CLOSE_Y && Math.abs(y) > Math.abs(x)) onClose();
    else if (images.length > 1 && x <= -SWIPE_X) next();
    else if (images.length > 1 && x >= SWIPE_X) previous();
    setDrag({ x: 0, y: 0 });
    startRef.current = null;
  };

  return (
    <div
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="图片查看器"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onPointerDown={(event) => {
        startRef.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = startRef.current;
        if (!start) return;
        setDrag({ x: event.clientX - start.x, y: event.clientY - start.y });
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      <button type="button" className="image-viewer-close" onClick={onClose} aria-label="关闭图片">×</button>
      {images.length > 1 && (
        <>
          <button type="button" className="image-viewer-nav previous" onClick={previous} aria-label="上一张">‹</button>
          <button type="button" className="image-viewer-nav next" onClick={next} aria-label="下一张">›</button>
          <div className="image-viewer-count">{index + 1} / {images.length}</div>
        </>
      )}
      <img
        src={current.src}
        alt={current.alt}
        draggable={false}
        style={{
          transform: `translate3d(${drag.x}px, ${drag.y}px, 0) scale(${Math.max(0.88, 1 - Math.abs(drag.y) / 900)})`,
          opacity: Math.max(0.45, 1 - Math.abs(drag.y) / 400)
        }}
      />
      <div className="image-viewer-hint">左右滑动切换 · 下滑或点背景退出</div>
    </div>
  );
}
