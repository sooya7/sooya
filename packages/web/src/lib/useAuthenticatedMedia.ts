import { useCallback, useEffect, useState } from 'react';
import { getToken } from './api.js';
import { getAdminToken } from './admin.js';
import {
  fetchAuthenticatedMediaWithRetry,
  isRetriableMediaError,
  releaseMediaUrl,
  type ExpectedMedia,
  type MediaAuthScope
} from './authenticatedMedia.js';

export interface AuthenticatedMediaState {
  url: string | null;
  error: string | null;
  /** True while a request is in flight, including automatic retries. */
  loading: boolean;
  /** True when another attempt could plausibly succeed, so offer a retry. */
  retriable: boolean;
  retry: () => void;
}

export function useAuthenticatedMedia(
  path: string | null | undefined,
  scope: MediaAuthScope,
  expected: ExpectedMedia
): AuthenticatedMediaState {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retriable, setRetriable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    setRetriable(false);
    setLoading(false);
    if (!path) return () => controller.abort();
    if (path.startsWith('blob:')) {
      setUrl(path);
      return () => controller.abort();
    }
    const token = scope === 'admin' ? getAdminToken() : getToken();
    setLoading(true);
    void fetchAuthenticatedMediaWithRetry(path, { scope, token, expected, signal: controller.signal })
      .then((result) => {
        objectUrl = result.url;
        if (!active) {
          releaseMediaUrl(objectUrl);
          objectUrl = null;
          return;
        }
        setUrl(result.url);
        setLoading(false);
      })
      .catch((cause) => {
        if (!active || (cause instanceof DOMException && cause.name === 'AbortError')) return;
        setError(cause instanceof Error ? cause.message : '媒体加载失败');
        setRetriable(isRetriableMediaError(cause));
        setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
      releaseMediaUrl(objectUrl);
    };
  }, [path, scope, expected, attempt]);

  return { url, error, loading, retriable, retry };
}
