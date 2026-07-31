import { useCallback, useEffect, useState } from 'react';
import { getToken } from './api.js';
import { getAdminToken } from './admin.js';
import {
  acquireAuthenticatedMedia,
  isRetriableMediaError,
  releaseCachedMedia,
  takeCachedMedia,
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
    // 引用是按「路径+作用域」持有的，卸载时必须还回去，否则条目永远不可淘汰。
    let held = false;
    setError(null);
    setRetriable(false);
    const cleanup = () => {
      active = false;
      controller.abort();
      if (held) releaseCachedMedia(path as string, { scope, expected });
    };
    if (!path) {
      setUrl(null);
      setLoading(false);
      return cleanup;
    }
    if (path.startsWith('blob:')) {
      setUrl(path);
      setLoading(false);
      return cleanup;
    }
    // 缓存命中同步显示：切标签页、画廊往回滚都不该再闪一下空白。
    const cached = takeCachedMedia(path, { scope, expected });
    if (cached) {
      held = true;
      setUrl(cached.url);
      setLoading(false);
      return cleanup;
    }
    const token = scope === 'admin' ? getAdminToken() : getToken();
    setUrl(null);
    setLoading(true);
    void acquireAuthenticatedMedia(path, { scope, token, expected, signal: controller.signal })
      .then((result) => {
        if (!active) {
          releaseCachedMedia(path, { scope, expected });
          return;
        }
        held = true;
        setUrl(result.url);
        setLoading(false);
      })
      .catch((cause) => {
        if (!active || (cause instanceof DOMException && cause.name === 'AbortError')) return;
        setError(cause instanceof Error ? cause.message : '媒体加载失败');
        setRetriable(isRetriableMediaError(cause));
        setLoading(false);
      });
    return cleanup;
  }, [path, scope, expected, attempt]);

  return { url, error, loading, retriable, retry };
}
