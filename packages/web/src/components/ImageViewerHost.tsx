import { useEffect, useMemo, useState } from 'react';
import { ImageViewer, type ViewerImage } from './ImageViewer.js';

interface OpenImageDetail {
  id: string;
}

export function ImageViewerHost() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<OpenImageDetail>).detail;
      if (!detail?.id) return;
      setVersion((value) => value + 1);
      setOpenId(detail.id);
    };
    window.addEventListener('sooya:open-image', open as EventListener);
    return () => window.removeEventListener('sooya:open-image', open as EventListener);
  }, []);

  const images = useMemo<ViewerImage[]>(() => {
    if (!openId) return [];
    return [...document.querySelectorAll<HTMLButtonElement>('.image-part[data-media-id]')]
      .map((button) => ({
        id: button.dataset.mediaId ?? '',
        src: button.dataset.src ?? '',
        alt: button.dataset.alt ?? '图片'
      }))
      .filter((image) => image.id && image.src);
  }, [openId, version]);

  const index = Math.max(0, images.findIndex((image) => image.id === openId));
  if (!openId || images.length === 0) return null;

  return (
    <ImageViewer
      images={images}
      index={index}
      onIndexChange={(next) => setOpenId(images[next]?.id ?? openId)}
      onClose={() => setOpenId(null)}
    />
  );
}
