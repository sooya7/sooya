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

function extensionFromUrl(src: string): string {
  const clean = src.split('?')[0] ?? '';
  const match = /\.([a-z0-9]{2,5})$/i.exec(clean);
  return match?.[1]?.toLowerCase() ?? 'jpg';
}

async function saveImage(image: ViewerImage): Promise<void> {
  try {
    const response = await fetch(image.src);
    if (!response.ok) throw new Error(`download failed (${response.status})`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `${image.alt || 'sooya-image'}.${extensionFromUrl(image.src)}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch {
    // iOS may ignore `download`; opening the image still exposes "存储到照片".
    window.open(image.src, '_blank', 'noopener,noreferrer');
  }
}

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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && current) {
        event.preventDefault();
        void saveImage(current);
      }
    };
    const pop = () => onClose();
    window.addEventListener('keydown', key);
    window.addEventListener('popstate', pop, { once: true });
    return () => {
      document.body.style.overflow = oldOverflow;
      window.removeEventListener('keydown', key);
      window.removeEventListener('popstate', pop);
    };
  }, [index, images.length, onClose, current]);

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
      <div className="image-viewer-backdrop" style={{ backgroundImage: `url(${JSON.stringify(current.src).slice(1, -1)})` }} />
      <div className="image-viewer-shade" />

      <div className="image-viewer-actions">
        <a className="image-viewer-action" href="/gallery" onClick={(event) => event.stopPropagation()}>图库</a>
        <button type="button" className="image-viewer-action" onClick={(event) => { event.stopPropagation(); void saveImage(current); }}>保存</button>
        <button type="button" className="image-viewer-close" onClick={onClose} aria-label="关闭图片">×</button>
      </div>

      {images.length > 1 && (
        <>
          <button type="button" className="image-viewer-nav previous" onClick={previous} aria-label="上一张">‹</button>
          <button type="button" className="image-viewer-nav next" onClick={next} aria-label="下一张">›</button>
          <div className="image-viewer-count">{index + 1} / {images.length}</div>
        </>
      )}
      <img
        className="image-viewer-current"
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
