import { useEffect, useState } from 'react';
import { getToken } from './api.js';
import { getAdminToken } from './admin.js';
import {
  fetchAuthenticatedMedia,
  releaseMediaUrl,
  type ExpectedMedia,
  type MediaAuthScope
} from './authenticatedMedia.js';

export function useAuthenticatedMedia(path: string | null | undefined, scope: MediaAuthScope, expected: ExpectedMedia) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    if (!path) return () => controller.abort();
    if (path.startsWith('blob:')) {
      setUrl(path);
      return () => controller.abort();
    }
    const token = scope === 'admin' ? getAdminToken() : getToken();
    void fetchAuthenticatedMedia(path, { scope, token, expected, signal: controller.signal })
      .then((result) => {
        objectUrl = result.url;
        if (!active) {
          releaseMediaUrl(objectUrl);
          objectUrl = null;
          return;
        }
        setUrl(result.url);
      })
      .catch((cause) => {
        if (!active || (cause instanceof DOMException && cause.name === 'AbortError')) return;
        setError(cause instanceof Error ? cause.message : '媒体加载失败');
      });
    return () => {
      active = false;
      controller.abort();
      releaseMediaUrl(objectUrl);
    };
  }, [path, scope, expected]);

  return { url, error };
}
