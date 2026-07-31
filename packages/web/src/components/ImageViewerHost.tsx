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

  /*
   * The clicked image may not be in the list yet: its blob is still loading, so
   * the scan above filtered it out. Clamping findIndex(-1) to 0 opened the
   * first image instead — looking like the viewer works while showing the user
   * a picture they never clicked. Not opening is the honest answer.
   */
  const index = images.findIndex((image) => image.id === openId);
  if (!openId || index < 0) return null;

  return (
    <ImageViewer
      images={images}
      index={index}
      onIndexChange={(next) => setOpenId(images[next]?.id ?? openId)}
      onClose={() => setOpenId(null)}
    />
  );
}
