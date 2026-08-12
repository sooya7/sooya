import { useEffect, type AudioHTMLAttributes, type ImgHTMLAttributes } from 'react';
import { useAuthenticatedMedia } from '../lib/useAuthenticatedMedia.js';
import type { MediaAuthScope } from '../lib/authenticatedMedia.js';

interface AuthenticatedImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  path: string | null | undefined;
  scope: MediaAuthScope;
  onResolved?: (url: string | null) => void;
}

export function AuthenticatedImage({ path, scope, onResolved, alt, ...props }: AuthenticatedImageProps) {
  const { url, error } = useAuthenticatedMedia(path, scope, 'image');
  useEffect(() => onResolved?.(url), [onResolved, url]);
  if (error) return <span role="img" aria-label={`${alt ?? '图片'}不可用`} title={error}>图片不可用</span>;
  if (!url) return <span aria-hidden="true" className={props.className} />;
  return <img {...props} src={url} alt={alt ?? ''} />;
}

interface AuthenticatedAudioProps extends Omit<AudioHTMLAttributes<HTMLAudioElement>, 'src'> {
  path: string | null | undefined;
  scope: MediaAuthScope;
}

export function AuthenticatedAudio({ path, scope, ...props }: AuthenticatedAudioProps) {
  const { url, error } = useAuthenticatedMedia(path, scope, 'audio');
  if (error) return <span role="status" title={error}>音频不可用</span>;
  if (!url) return <span aria-hidden="true" className={props.className} />;
  return <audio {...props} src={url} controls />;
}
