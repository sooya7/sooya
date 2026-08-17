import { useCallback, useEffect, useState } from 'react';
import {
  adminApi,
  type AdminQqDelivery,
  type AdminQqEvent,
  type AdminQqStatus
} from '../../lib/admin.js';
import { AdminState } from './AdminState.js';

function dateText(value: string | null | undefined): string {
  if (!value) return '—';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : value;
}

function deliveryStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '待发送',
    sending: '发送中',
    retry: '退避重试',
    sent: '已发送',
    failed: '失败'
  };
  return labels[status] ?? status;
}

function eventStatusLabel(status: string): string {
  const labels: Record<string, string> = { processed: '已处理', rejected: '已拒绝', failed: '失败', received: '待处理' };
  return labels[status] ?? status;
}

/**
 * QQ 官方 Bot 通道管理（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §17）。
 * 只显示状态摘要：启用/凭据（仅 App ID 摘要）/owner/计数、投递队列、最近事件、
 * 测试发送、安全错误摘要。绝不显示 App Secret / Access Token / 签名 Secret。
 */
export function QqAdminPage({ onNotice }: { onNotice: (message: string) => void }) {
  const [status, setStatus] = useState<AdminQqStatus | null>(null);
  const [events, setEvents] = useState<AdminQqEvent[]>([]);
  const [deliveries, setDeliveries] = useState<AdminQqDelivery[]>([]);
  const [errors, setErrors] = useState<Array<{ scope: string; message: string; createdAt: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; messageId?: string; errorCode?: string; errorSummary?: string } | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statusData, eventsData, deliveriesData, errorsData] = await Promise.all([
        adminApi.qqStatus(),
        adminApi.qqEvents(),
        adminApi.qqDeliveries(),
        adminApi.qqErrors()
      ]);
      setStatus(statusData);
      setEvents(eventsData.events);
      setDeliveries(deliveriesData.deliveries);
      setErrors(errorsData.errors);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'QQ 状态加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sendTest = async () => {
    const content = testText.trim();
    if (!content || testBusy) return;
    setTestBusy(true);
    try {
      setTestResult(await adminApi.qqTestSend(content));
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : '测试发送失败');
    } finally {
      setTestBusy(false);
    }
  };

  const retryDelivery = async (id: string) => {
    setRetrying(id);
    try {
      const result = await adminApi.qqRetryDelivery(id);
      onNotice(`已重新入队投递 ${result.deliveryId}`);
      await load();
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : '重试失败');
    } finally {
      setRetrying(null);
    }
  };

  if (loading && !status) return <AdminState kind="loading" testId="admin-qq-loading" />;
  if (error && !status) return <AdminState kind="error" message={error} onRetry={() => void load()} testId="admin-qq-error" />;
  if (!status) return <AdminState kind="empty" testId="admin-qq-empty" />;

  const failedCount = status.counts.failed;
  const requireAttention = status.enabled && (status.counts.retry > 0 || failedCount > 0 || !status.credentialConfigured);

  return (
    <section className="admin-mcp-page admin-qq-page" data-testid="admin-qq-page">
      <header className="admin-subpage-header">
        <div>
          <span className="admin-eyebrow">CHANNEL · QQ</span>
          <h2>QQ 通道</h2>
          <p>QQ 官方 Bot 是 SOOYA 唯一的消息通道与出口。此处只显示状态摘要，Secret 永不显示。</p>
        </div>
        <button type="button" className="admin-header-button" onClick={() => void load()} disabled={loading} aria-busy={loading} title="刷新 QQ 状态" aria-label="刷新 QQ 状态">
          refresh
        </button>
      </header>

      {requireAttention && <p className="admin-inline-error" role="status">有需要处理的投递或配置问题（{status.counts.retry} 退避 / {failedCount} 失败）</p>}
      {error && <p className="admin-inline-error" role="status">{error}</p>}

      <section className="admin-mcp-summary" aria-label="QQ 状态总览">
        <article className="admin-card">
          <span className="admin-card-kicker">通道开关</span>
          <strong>{status.enabled ? '已启用' : '已停用'}</strong>
          <span className={`admin-status-chip ${status.enabled ? 'ok' : 'flag-disabled'}`}>{status.enabled ? 'active' : 'disabled'}</span>
          <small>环境 {status.env === 'sandbox' ? '沙箱' : '生产'} · 主动消息 {status.proactiveEnabled ? '开' : '关'}</small>
        </article>
        <article className="admin-card">
          <span className="admin-card-kicker">凭据</span>
          <strong>{status.credentialConfigured ? '已配置' : '未配置'}</strong>
          <small>App ID {status.appIdSummary} · 授权用户 {status.allowedUserCount}</small>
        </article>
        <article className="admin-card">
          <span className="admin-card-kicker">绑定用户</span>
          <strong className="admin-breakable">{status.owner?.externalUserId ?? '未绑定'}</strong>
          <small>{status.owner ? `绑定于 ${dateText(status.owner.boundAt)}` : '等待授权 QQ 用户首次发消息'}</small>
        </article>
        <article className="admin-card">
          <span className="admin-card-kicker">投递计数</span>
          <strong>{status.counts.pending + status.counts.retry + status.counts.sending} 在途</strong>
          <small>待发 {status.counts.pending} · 退避 {status.counts.retry} · 失败 {status.counts.failed} · 成功 {status.counts.sent}</small>
        </article>
      </section>

      <section className="admin-card" aria-label="投递队列">
        <div className="admin-mcp-tools-header">
          <h3>投递队列</h3>
          <button type="button" className="admin-link-button" onClick={() => void load()} disabled={loading}>刷新</button>
        </div>
        <div className="admin-simple-table-wrap">
          <table className="admin-simple-table" data-testid="admin-qq-deliveries">
            <thead>
              <tr><th>状态</th><th>消息</th><th>尝试</th><th>远程 id</th><th>最近错误</th><th>操作</th></tr>
            </thead>
            <tbody>
              {deliveries.length === 0 ? (
                <tr><td colSpan={6} className="admin-muted">暂无投递记录</td></tr>
              ) : deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td><span className={`admin-status-chip ${delivery.status === 'sent' ? 'ok' : delivery.status === 'failed' ? 'error' : ''}`}>{deliveryStatusLabel(delivery.status)}</span></td>
                  <td className="admin-breakable">{delivery.messageId}</td>
                  <td>{delivery.attempts}</td>
                  <td className="admin-breakable">{delivery.remoteMessageId ?? '—'}</td>
                  <td title={delivery.lastErrorSummary ?? undefined}>
                    {delivery.lastErrorCode ? `${delivery.lastErrorCode} — ${delivery.lastErrorSummary ?? ''}` : '—'}
                  </td>
                  <td>
                    {delivery.status === 'failed' || delivery.status === 'retry' ? (
                      <button type="button" className="admin-link-button" disabled={retrying === delivery.id} onClick={() => void retryDelivery(delivery.id)}>
                        {retrying === delivery.id ? '重试中…' : '重试'}
                      </button>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-card" aria-label="测试发送">
        <h3>测试发送</h3>
        <p className="admin-muted">向绑定用户发一条测试消息，验证通道可用（不暴露任何凭证）。</p>
        <div className="admin-qq-test-row">
          <label htmlFor="admin-qq-test-text">内容</label>
          <input
            id="admin-qq-test-text"
            type="text"
            value={testText}
            onChange={(event) => setTestText(event.target.value)}
            placeholder="例如：这是一条来自 SOOYA 的测试消息"
          />
          <button type="button" className="admin-header-button" disabled={!testText.trim() || testBusy} onClick={() => void sendTest()}>
            {testBusy ? '发送中…' : '发送'}
          </button>
        </div>
        {testResult && (
          <p className={testResult.ok ? 'admin-inline-success' : 'admin-inline-error'} role="status">
            {testResult.ok ? `已发送，远程消息 ${testResult.messageId}` : `发送失败：${testResult.errorCode} — ${testResult.errorSummary}`}
          </p>
        )}
      </section>

      <section className="admin-card" aria-label="最近事件">
        <div className="admin-mcp-tools-header">
          <h3>最近事件</h3>
          <span className="admin-muted">来源校验通过的事件（含被拒绝/幂等消费）</span>
        </div>
        <ul className="admin-qq-events" data-testid="admin-qq-events">
          {events.length === 0 ? (
            <li className="admin-muted">暂无入站事件</li>
          ) : events.map((event) => (
            <li key={event.eventId}>
              <span className={`admin-status-chip ${event.status === 'processed' ? 'ok' : event.status === 'rejected' ? 'flag-disabled' : ''}`}>{eventStatusLabel(event.status)}</span>
              <span className="admin-breakable">{event.eventType}</span>
              <span className="admin-muted">{event.errorCode ?? ''}</span>
              <span className="admin-muted">{dateText(event.receivedAt)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="admin-card" aria-label="错误摘要">
        <h3>错误摘要</h3>
        {errors.length === 0 ? (
          <p className="admin-muted">暂无 QQ 相关错误</p>
        ) : (
          <ul className="admin-qq-events" data-testid="admin-qq-errors">
            {errors.slice(0, 20).map((entry, index) => (
              <li key={`${entry.createdAt}-${index}`}>
                <code>{entry.scope}</code>
                <span className="admin-breakable">{entry.message}</span>
                <span className="admin-muted">{dateText(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}