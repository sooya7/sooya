import type { ReactNode } from 'react';
import { adminFailureKind } from '../../lib/admin.js';

interface AdminStateProps {
  kind: 'loading' | 'empty' | 'unauthorized' | 'flag-disabled' | 'provider-unconfigured' | 'error';
  /** Message to show; defaults are provided per kind. */
  message?: string;
  onRetry?: () => void;
  testId?: string;
}

const DEFAULT_TEXT: Record<AdminStateProps['kind'], string> = {
  loading: '加载中…',
  empty: '（暂无数据）',
  unauthorized: '缺少管理令牌或无权访问，请先在管理面板登录。',
  'flag-disabled': '该功能尚未启用（feature flag 默认关闭）。',
  'provider-unconfigured': 'Provider 尚未配置，此功能暂不可用。',
  error: '加载失败，请稍后重试。'
};

/**
 * Uniform loading / empty / error / flag-disabled / unauthorized /
 * provider-unconfigured state block shared by the next-phase admin surfaces.
 */
export function AdminState({ kind, message, onRetry, testId }: AdminStateProps) {
  if (kind === 'loading') {
    return <p className="admin-state admin-state-loading" data-testid={testId ?? 'admin-state'} aria-busy="true">加载中…</p>;
  }
  if (kind === 'empty') {
    return <p className="admin-state admin-state-empty" data-testid={testId ?? 'admin-state'}>{message ?? DEFAULT_TEXT.empty}</p>;
  }
  const text = message ?? DEFAULT_TEXT[kind];
  return (
    <div className={`admin-state admin-state-${kind}`} data-testid={testId ?? 'admin-state'} role={kind === 'error' ? 'alert' : 'status'}>
      <span>{text}</span>
      {onRetry && <button type="button" className="admin-state-retry" onClick={onRetry}>重试</button>}
    </div>
  );
}

/** Maps a thrown value to the state kind + message for `AdminState`. */
export function adminStateFromError(error: unknown): { kind: 'unauthorized' | 'flag-disabled' | 'provider-unconfigured' | 'error'; message: string } {
  const kind = adminFailureKind(error);
  const message = error instanceof Error ? error.message : String(error);
  return { kind, message };
}

export function AdminNotice({ kind, children }: { kind: 'ok' | 'error'; children: ReactNode }) {
  return <div className={`admin-notice ${kind === 'error' ? 'admin-notice-error' : ''}`} role="status">{children}</div>;
}
