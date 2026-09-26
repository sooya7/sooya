import { useState } from 'react';
import { adminApi, type AdminQqDelivery, type AdminQqEvent, type AdminQqStatus, type MetricAggregate } from '../../lib/admin.js';
import {
  Button, Callout, Empty, Facts, Field, Input, Loadable, Page, Section, Select, Status, Tag, fmtAgo, fmtTime, useAction, useLoad,
  type Tone
} from '../ui.js';
import './Qq.css';

/*
 * QQ 通道页只显示服务端给的摘要：开关、App ID 摘要、绑定的人、投递队列、事件和错误。
 * 服务端从不下发 App Secret / Access Token / 回调签名密钥，这里也不渲染任何原始 detail，
 * 错误只挑出 code / eventId / messageId 这类安全字段。
 */

const DELIVERY_STATUS: Record<string, [string, Tone]> = {
  pending: ['等待发送', 'off'],
  sending: ['正在发送', 'warn'],
  retry: ['等待重试', 'warn'],
  sent: ['已送达', 'ok'],
  failed: ['发送失败', 'bad']
};

const EVENT_STATUS: Record<string, [string, Tone]> = {
  processed: ['已处理', 'ok'],
  received: ['等待处理', 'off'],
  rejected: ['已拒收', 'warn'],
  failed: ['处理失败', 'bad']
};

const EVENT_TYPES: Record<string, string> = {
  C2C_MESSAGE_CREATE: '私聊消息'
};

const ERROR_SCOPES: Record<string, string> = {
  'qq.verify': '来源校验',
  'qq.inbound': '收消息',
  'qq.send': '发消息',
  'qq.media': '上传图片或语音'
};

const METRIC_LABELS: Record<string, string> = {
  'inbound.accepted': '收到的消息',
  'inbound.duplicate': '重复推送（已忽略）',
  'inbound.rejected_user': '非授权用户的消息',
  'inbound.validation_rejected': '来源校验没通过',
  'inbound.attachment_failed': '附件下载失败',
  'outbound.sent': '发出的消息',
  'outbound.failed': '发送失败',
  'outbound.retry': '发送重试',
  'outbound.latency': '平均发送耗时（毫秒）',
  'media.upload_success': '图片或语音上传成功',
  'media.upload_failed': '图片或语音上传失败',
  'proactive.sent': '她主动发出的消息'
};

const FILTERS = [
  { value: '', label: '全部投递' },
  { value: 'failed', label: '只看发送失败' },
  { value: 'retry', label: '只看等待重试' },
  { value: 'pending', label: '只看等待发送' },
  { value: 'sending', label: '只看正在发送' },
  { value: 'sent', label: '只看已送达' }
];

type QqError = { scope: string; message: string; detail: unknown; createdAt: string };

/** Only whitelisted, non-secret fields from an error's detail. */
function safeErrorFields(detail: unknown): string[] {
  if (!detail || typeof detail !== 'object') return [];
  const d = detail as Record<string, unknown>;
  const out: string[] = [];
  if (typeof d.code === 'string') out.push(`错误码 ${d.code}`);
  if (typeof d.eventId === 'string') out.push(`事件 ${d.eventId}`);
  if (typeof d.messageId === 'string') out.push(`消息 ${d.messageId}`);
  if (typeof d.attempts === 'number') out.push(`第 ${d.attempts} 次尝试`);
  if (d.retryable === false) out.push('不会自动重试');
  return out;
}

function Label({ map, value }: { map: Record<string, [string, Tone]>; value: string }) {
  const [label, tone] = map[value] ?? [value, 'off' as Tone];
  return <Status tone={tone}>{label}</Status>;
}

function StatusSection({ status }: { status: AdminQqStatus }) {
  const { counts } = status;
  const inFlight = counts.pending + counts.sending + counts.retry;
  return (
    <>
      <Status tone={!status.enabled ? 'off' : !status.credentialConfigured ? 'bad' : counts.failed ? 'warn' : 'ok'}>
        {!status.enabled ? 'QQ 通道没有开启' : !status.credentialConfigured ? '已开启，但机器人凭据不完整' : '通道在工作'}
      </Status>
      {!status.enabled && (
        <Callout>
          她现在收不到也发不出 QQ 消息。要开启，在服务器的环境变量里把 <code>QQ_BOT_ENABLED</code> 设为 true，并填好 <code>QQ_APP_ID</code>、<code>QQ_APP_SECRET</code>，然后重启服务。
        </Callout>
      )}
      {status.enabled && !status.credentialConfigured && (
        <Callout tone="bad">机器人凭据不完整，QQ 那边会拒绝请求。请在服务器环境变量里检查 App ID 和 App Secret，改完重启服务。</Callout>
      )}
      {status.enabled && status.allowedUserCount === 0 && (
        <Callout tone="warn">还没有设置允许和她聊天的 QQ 用户（<code>QQ_ALLOWED_USERS</code>），所有人发来的消息都会被拒收。</Callout>
      )}
      <Facts items={[
        ['运行环境', status.env === 'sandbox' ? '沙箱（测试用）' : '正式'],
        ['机器人凭据', status.credentialConfigured ? '已配置' : '没有配置'],
        ['App ID', status.appIdSummary && status.appIdSummary !== '(unset)' ? status.appIdSummary : '没有填写'],
        ['允许聊天的 QQ 用户', `${status.allowedUserCount} 个`],
        ['她能不能主动发消息', status.proactiveEnabled ? '可以' : '不可以'],
        ['绑定的 QQ 用户', status.owner ? status.owner.externalUserId : '还没有绑定'],
        ['绑定时间', status.owner ? fmtTime(status.owner.boundAt) : '—'],
        ['对方最近一次发消息', status.owner?.lastSeenAt ? fmtAgo(status.owner.lastSeenAt) : '—']
      ]} />
      {!status.owner && status.enabled && (
        <p className="cs-muted">允许的 QQ 用户第一次给她发消息时，会自动绑定为她聊天的对象。</p>
      )}
      <Facts items={[
        ['正在排队', `${inFlight} 条`],
        ['等待重试', `${counts.retry} 条`],
        ['发送失败', `${counts.failed} 条`],
        ['已送达', `${counts.sent} 条`]
      ]} />
      {(counts.failed > 0 || counts.retry > 0) && (
        <Callout tone="warn">有 {counts.failed} 条发送失败、{counts.retry} 条在等待重试，可以在下面的投递记录里手动重新投递。</Callout>
      )}
    </>
  );
}

function MetricsBlock({ metrics }: { metrics: MetricAggregate[] }) {
  if (metrics.length === 0) return <p className="cs-muted">最近 7 天没有统计数据。统计需要在服务器上开启 METRICS_DASHBOARD_ENABLED。</p>;
  return (
    <div className="cs-table-wrap">
      <table className="cs-table">
        <thead><tr><th>最近 7 天</th><th>次数</th><th>数值</th></tr></thead>
        <tbody>
          {metrics.map((row) => (
            <tr key={`${row.category}.${row.metric}`}>
              <td>{METRIC_LABELS[row.metric] ?? row.metric}</td>
              <td data-num>{row.count.toLocaleString()}</td>
              <td data-num>{row.metric.endsWith('latency') ? Math.round(row.avg).toLocaleString() : row.sum.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TestSend({ status, onSent }: { status: AdminQqStatus; onSent: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const { run, busy } = useAction();
  const blocked = !status.enabled ? 'QQ 通道没有开启，暂时不能测试。' : !status.owner ? '还没有绑定的 QQ 用户，测试消息没有人可发。' : null;

  const send = async () => {
    const content = text.trim();
    if (!content) return;
    setResult(null);
    const res = await run('send', () => adminApi.qqTestSend(content));
    if (!res) return;
    setResult(res.ok
      ? { ok: true, text: `测试消息已发出${res.messageId ? `，QQ 那边的消息编号是 ${res.messageId}` : ''}。` }
      : { ok: false, text: `没发出去：${[res.errorCode, res.errorSummary].filter(Boolean).join('，') || '原因未知'}。` });
    onSent();
  };

  return (
    <div data-no-dirty style={{ display: 'grid', gap: '0.75rem' }}>
      {blocked && <p className="cs-muted">{blocked}</p>}
      <Field label="测试内容" hint="会以她的身份发给绑定的 QQ 用户，最多 2000 字。">
        <Input value={text} maxLength={2000} placeholder="例如：这是一条测试消息" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !blocked && text.trim()) void send(); }} disabled={!!blocked} />
      </Field>
      <div className="cs-actions">
        <Button busy={busy === 'send'} disabled={!!blocked || !text.trim()} onClick={() => void send()}>发送测试消息</Button>
      </div>
      {result && <Callout tone={result.ok ? 'ok' : 'bad'}>{result.text}</Callout>}
    </div>
  );
}

function Deliveries({ onChanged }: { onChanged: () => void }) {
  const [filter, setFilter] = useState('');
  const list = useLoad(() => adminApi.qqDeliveries(filter || undefined), [filter]);
  const { run, busy } = useAction();

  const retry = async (delivery: AdminQqDelivery) => {
    const res = await run(delivery.id, () => adminApi.qqRetryDelivery(delivery.id), '已重新投递');
    if (res) { await list.reload(); onChanged(); }
  };

  return (
    <>
      <div className="cs-actions" data-no-dirty style={{ justifyContent: 'space-between' }}>
        <Select aria-label="按状态筛选投递" style={{ width: 'auto', maxWidth: '100%' }} options={FILTERS} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button kind="text" size="sm" busy={list.loading} onClick={() => void list.reload()}>刷新投递记录</Button>
      </div>
      <Loadable state={list} label="投递记录">
        {({ deliveries }) => deliveries.length === 0 ? (
          <Empty>{filter ? '没有这个状态的投递。' : '还没有发出过 QQ 消息。她回复或主动发消息后，每一条都会在这里留下记录。'}</Empty>
        ) : (
          <div className="cs-table-wrap">
            <table className="cs-table">
              <thead><tr><th>状态</th><th>创建时间</th><th>尝试</th><th>结果</th><th /></tr></thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="cs-nowrap"><Label map={DELIVERY_STATUS} value={d.status} /></td>
                    <td className="cs-nowrap">{fmtTime(d.createdAt)}</td>
                    <td data-num>{d.attempts} 次</td>
                    <td>
                      {d.status === 'sent'
                        ? <span className="cs-muted">送达于 {fmtTime(d.deliveredAt)}{d.remoteMessageId ? `，QQ 消息编号 ${d.remoteMessageId}` : ''}</span>
                        : d.lastErrorCode || d.lastErrorSummary
                          ? <span>{[d.lastErrorCode, d.lastErrorSummary].filter(Boolean).join('：')}</span>
                          : <span className="cs-muted">—</span>}
                      {d.status === 'retry' && d.nextRetryAt && <div className="cs-muted">将在 {fmtTime(d.nextRetryAt)} 自动重试</div>}
                      <div className="cs-muted">消息 {d.messageId}</div>
                    </td>
                    <td data-actions>
                      {(d.status === 'failed' || d.status === 'retry') && (
                        <Button kind="quiet" size="sm" busy={busy === d.id} onClick={() => void retry(d)}>重新投递</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Loadable>
    </>
  );
}

function Events({ events }: { events: AdminQqEvent[] }) {
  if (events.length === 0) return <Empty>还没有收到 QQ 推送的事件。开启通道并让授权用户发一条消息，这里就会出现记录。</Empty>;
  return (
    <div className="cs-list">
      {events.map((event) => (
        <div className="cs-list-item" key={event.eventId}>
          <span><span className="cs-list-title">{EVENT_TYPES[event.eventType] ?? event.eventType}</span></span>
          <span className="cs-list-side"><Label map={EVENT_STATUS} value={event.status} /></span>
          <span className="cs-list-meta">
            收到于 {fmtTime(event.receivedAt)}{event.processedAt ? `，处理于 ${fmtTime(event.processedAt)}` : ''}
            {event.errorCode ? `，错误码 ${event.errorCode}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function Errors({ errors }: { errors: QqError[] }) {
  const [all, setAll] = useState(false);
  if (errors.length === 0) return <Empty>没有 QQ 相关的错误。</Empty>;
  const shown = all ? errors : errors.slice(0, 10);
  return (
    <>
      <div className="cs-list">
        {shown.map((error, index) => {
          const fields = safeErrorFields(error.detail);
          return (
            <div className="cs-list-item" key={`${error.createdAt}-${index}`}>
              <span className="cs-list-title">{error.message}</span>
              <span className="cs-list-side"><Tag tone="bad">{ERROR_SCOPES[error.scope] ?? error.scope}</Tag></span>
              <span className="cs-list-meta">{fmtTime(error.createdAt)}{fields.length ? `，${fields.join('，')}` : ''}</span>
            </div>
          );
        })}
      </div>
      {errors.length > 10 && (
        <div className="cs-actions">
          <Button kind="text" size="sm" onClick={() => setAll((v) => !v)}>{all ? '只看最近 10 条' : `显示全部 ${errors.length} 条`}</Button>
        </div>
      )}
    </>
  );
}

export default function Qq() {
  const data = useLoad(async () => {
    const [status, events, errors] = await Promise.all([adminApi.qqStatus(), adminApi.qqEvents(), adminApi.qqErrors()]);
    return { status, events: events.events, errors: errors.errors as QqError[] };
  });
  const [deliveryKey, setDeliveryKey] = useState(0);

  return (
    <div className="qq-root">
      <Page
        title="QQ 通道"
        register="system"
        intro="她通过 QQ 官方机器人和你聊天。这里看通道是否正常、消息有没有送到，以及出错的原因。这里不会显示任何密钥。"
        actions={<Button kind="quiet" size="sm" busy={data.loading} onClick={() => { void data.reload(); setDeliveryKey((k) => k + 1); }}>刷新全部</Button>}
      >
        <Section title="连接状态" desc="通道开关、机器人凭据和绑定的人。这些都在服务器环境变量里设置。">
          <Loadable state={data} label="QQ 通道状态">{({ status }) => <StatusSection status={status} />}</Loadable>
        </Section>

        <Section title="测试发送" desc="给绑定的 QQ 用户发一条消息，确认通道能用。">
          <Loadable state={data} label="QQ 通道状态">{({ status }) => <TestSend status={status} onSent={() => setDeliveryKey((k) => k + 1)} />}</Loadable>
        </Section>

        <Section title="投递记录" desc="她发出的每条 QQ 消息。失败或在等待重试的可以手动重新投递。">
          <Deliveries key={deliveryKey} onChanged={() => void data.reload()} />
        </Section>

        <Section title="最近收到的事件" desc="QQ 推送过来、通过来源校验的事件，包括被拒收和重复推送的。">
          <Loadable state={data} label="事件">{({ events }) => <Events events={events} />}</Loadable>
        </Section>

        <Section title="错误" desc="只保留错误摘要和编号，便于对照排查。">
          <Loadable state={data} label="错误记录">{({ errors }) => <Errors errors={errors} />}</Loadable>
        </Section>

        <Section title="最近 7 天的统计">
          <Loadable state={data} label="统计">{({ status }) => <MetricsBlock metrics={status.metrics} />}</Loadable>
        </Section>
      </Page>
    </div>
  );
}

