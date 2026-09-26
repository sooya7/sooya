import { policyReasonText } from '../labels.js';
import { useMemo, useState, useEffect } from 'react';
import {
  adminApi, adminRequest, type AdminCapabilities, type AdminError, type AdminJob, type AdminSystemStatus, type MetricAggregate, type MetricsDistribution
} from '../../lib/admin.js';
import { consolePath } from '../routes.js';
import {
  Button, Callout, ConfirmButton, Empty, Facts, Loadable, Page, Section, Select, Status, Tabs, Tag,
  fmtAgo, fmtBytes, fmtDuration, fmtTime, useAction, useConsole, useLoad, type Tone
} from '../ui.js';
import './Ops.css';

/* ================================================================ labels */

const CAPABILITIES: Record<string, string> = {
  chat: '聊天', vision: '看图', summary: '对话总结', director: '媒体导演（表情、语音、出图提示）', embedding: '记忆向量',
  rerank: '记忆重排', image: '生图', video: '生成视频', tts: '语音合成', webSearch: '联网搜索', decision: '行为决策',
  weather: '天气', mcp: '工具', qq: 'QQ'
};

const CAPABILITY_DETAIL: Record<string, string> = {
  'not configured': '还没有配置',
  'model does not declare vision support': '当前模型没有标明支持看图',
  'media director model': '单独配置了媒体导演模型'
};

function capabilityState(value: unknown): { ok: boolean; configured: boolean; provider?: string; model?: string; detail?: string; checkedAt?: string } {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    ok: v.ok === true,
    configured: v.configured === true,
    provider: typeof v.provider === 'string' && v.provider !== 'none' ? v.provider : undefined,
    model: typeof v.model === 'string' ? v.model : undefined,
    detail: typeof v.detail === 'string' ? v.detail : undefined,
    checkedAt: typeof v.checkedAt === 'string' ? v.checkedAt : undefined
  };
}

function areaOf(scope: string): string {
  const s = scope.toLowerCase();
  if (s.includes('sticker') && s.includes('analy')) return '表情分析';
  if (s.includes('sticker')) return '表情处理';
  if (s.startsWith('qq')) return 'QQ 通道';
  if (s.includes('ombre')) return '记忆服务';
  if (s.includes('mcp')) return '工具服务';
  if (s.includes('moment') || s.includes('proactive')) return '主动消息';
  if (s.includes('life')) return '生活模拟';
  if (s.includes('weather')) return '天气更新';
  if (s.includes('video')) return '视频生成';
  if (s.includes('image')) return '生图';
  if (s.includes('tts') || s.includes('voice')) return '语音';
  if (s.includes('backup')) return '备份';
  if (s.includes('storage') || s.includes('media')) return '媒体存储';
  if (s.includes('push')) return '消息推送';
  if (s.includes('chat') || s.includes('reply')) return '聊天回复';
  if (s.includes('memory') || s.includes('embedding') || s.includes('rerank') || s.includes('summary')) return '记忆';
  if (s.includes('database') || s.includes('sqlite') || s.includes('db')) return '数据库';
  if (s.includes('model') || s.includes('discover') || s.includes('provider')) return '模型服务';
  if (s.startsWith('job')) return '后台任务';
  return '系统';
}

/** Group by what a person can act on, not by the raw backend message. */
function errorCopy(error: AdminError): { title: string; explanation: string } {
  const area = areaOf(error.scope);
  const m = error.message.toLowerCase();
  if (m.includes('invalid_analysis_json')) return { title: '表情分析的结果格式不对', explanation: '看图模型返回的内容不是要求的格式，这次分析没有保存。经常出现的话，检查看图模型的配置。' };
  if (/timeout|timed out|etimedout/.test(m)) return { title: `${area}超时`, explanation: '对方服务在规定时间内没有回应。系统会按任务规则重试，一直出现的话检查网络或服务速度。' };
  if (/rate.?limit|too many requests|\b429\b/.test(m)) return { title: `${area}请求太频繁`, explanation: '对方服务限制了请求频率。一般等一会儿就好，经常出现的话需要提高额度。' };
  if (/unauthor|forbidden|invalid.?key|\b401\b|\b403\b/.test(m)) return { title: `${area}被拒绝访问`, explanation: '对方不认当前的密钥。检查对应服务的 API Key、权限和地址。' };
  if (/not configured|unconfigured|provider.*config|missing.*(key|token)/.test(m)) return { title: `${area}还没配置完整`, explanation: '缺少必要的配置，所以没有继续执行。去对应的设置里补上地址、模型或密钥。' };
  if (/fetch failed|network|econn|socket|dns|connection/.test(m)) return { title: `${area}连不上`, explanation: '没能连到对方服务。检查网络、代理、服务地址，以及对方服务是否在线。' };
  if (/json|parse|schema|invalid.*format/.test(m)) return { title: `${area}返回的格式不对`, explanation: '对方返回的内容和预期不一致，这次结果没有采用。' };
  if (/not found|missing|enoent|\b404\b/.test(m)) return { title: `${area}要用的东西找不到了`, explanation: '任务用到的文件或地址已经不存在，检查对应的媒体或配置。' };
  return { title: `${area}出了问题`, explanation: '记录到一次异常，原始错误在下面的技术详情里。' };
}

interface ErrorGroup { key: string; title: string; explanation: string; items: AdminError[] }

function groupErrors(errors: AdminError[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const error of errors) {
    const copy = errorCopy(error);
    const group = groups.get(copy.title) ?? { key: copy.title, ...copy, items: [] };
    group.items.push(error);
    groups.set(copy.title, group);
  }
  for (const g of groups.values()) g.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [...groups.values()].sort((a, b) => b.items[0]!.createdAt.localeCompare(a.items[0]!.createdAt));
}

const JOB_TYPES: Record<string, string> = {
  'backup.create': '自动备份', 'future.analyze': '分析未来的约定', 'life.conversation': '把聊天写进生活', 'life.tick': '生活模拟推进',
  maintenance: '定期维护', 'media.extract_text': '识别图片文字', 'ombre.memory_commit': '写入长期记忆', 'qq.deliver': '发送 QQ 消息',
  'sticker.analyze': '分析表情', 'sticker.analyze.backfill': '补分析旧表情', 'sticker.embed': '给表情建索引', 'sticker.embed.backfill': '补建表情索引',
  'summary.build': '总结对话', 'weather.refresh': '更新天气'
};

type JobStatus = 'failed' | 'running' | 'retry' | 'pending' | 'done' | 'cancelled' | 'other';
const JOB_STATUS: Record<JobStatus, [string, Tone]> = {
  failed: ['失败', 'bad'], running: ['正在处理', 'warn'], retry: ['等待重试', 'warn'], pending: ['排队中', 'off'],
  done: ['已完成', 'ok'], cancelled: ['已取消', 'off'], other: ['其他', 'off']
};
const JOB_ORDER: JobStatus[] = ['failed', 'running', 'retry', 'pending', 'done', 'cancelled', 'other'];

function jobStatus(job: AdminJob): JobStatus {
  const s = job.status.toLowerCase();
  if (s === 'failed' || s === 'dead') return 'failed';
  if (s === 'running' || s === 'processing' || s === 'leased') return 'running';
  if (s.includes('retry') || (s === 'pending' && job.attempts > 0 && job.last_error)) return 'retry';
  if (s === 'pending' || s === 'queued') return 'pending';
  if (s === 'done' || s === 'completed' || s === 'success' || s === 'succeeded') return 'done';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  return 'other';
}

interface JobGroup { key: string; type: string; status: JobStatus; items: AdminJob[] }

function groupJobs(jobs: AdminJob[]): JobGroup[] {
  const groups = new Map<string, JobGroup>();
  for (const job of jobs) {
    const status = jobStatus(job);
    const key = `${job.type}\u0000${status}`;
    const group = groups.get(key) ?? { key, type: job.type, status, items: [] };
    group.items.push(job);
    groups.set(key, group);
  }
  for (const g of groups.values()) g.items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return [...groups.values()].sort((a, b) =>
    JOB_ORDER.indexOf(a.status) - JOB_ORDER.indexOf(b.status) || b.items[0]!.updated_at.localeCompare(a.items[0]!.updated_at));
}

const METRICS: Record<string, string> = {
  'reply.start': '开始回复', 'reply.success': '回复成功', 'reply.partial': '回复中断（只发出一部分）', 'reply.auto_retry': '回复自动重试',
  'reply.first_visible_ms': '到她开口的等待（毫秒）', 'reply.latency_ms': '整条回复耗时（毫秒）',
  'voice.tts_success': '语音合成成功', 'voice.tts_failure': '语音合成失败', 'voice.tts_latency_ms': '语音合成耗时（毫秒）',
  'voice.fallback_text': '语音改发文字', 'voice.script_rewrite': '语音稿改写', 'voice.semantic_rejection': '不适合念出来的内容',
  'proactive.sent': '她主动找你', 'future.proactive.sent': '按约定主动找你',
  'life.activity_score': '生活活动评分', 'life.plan_create': '新建计划', 'life.plan_complete': '完成计划', 'life.plan_skip': '跳过计划',
  'life.thread_create': '新的惦记的事', 'life.thread_resolve': '了结惦记的事',
  'qq.inbound.accepted': 'QQ 收到消息', 'qq.inbound.duplicate': 'QQ 重复推送', 'qq.inbound.rejected_user': 'QQ 非授权用户',
  'qq.inbound.validation_rejected': 'QQ 来源校验失败', 'qq.inbound.attachment_failed': 'QQ 附件下载失败',
  'qq.outbound.sent': 'QQ 发出消息', 'qq.outbound.failed': 'QQ 发送失败', 'qq.outbound.retry': 'QQ 发送重试', 'qq.outbound.latency': 'QQ 发送耗时（毫秒）',
  'qq.media.upload_success': 'QQ 媒体上传成功', 'qq.media.upload_failed': 'QQ 媒体上传失败', 'qq.proactive.sent': 'QQ 主动消息'
};

function metricLabel(category: string, metric: string): string {
  return METRICS[`${category}.${metric}`] ?? `${category}.${metric}`;
}

const AUDIT_CATEGORY: Record<string, string> = {
  backup: '备份', life: '生活', media: '媒体', ombre: '记忆服务', persona: '人设', sticker: '表情', storage: '存储', video: '视频', voice: '语音'
};
const AUDIT_ACTION: Record<string, string> = {
  'backup.deleted': '删除了备份', 'backup.ipa-exported': '导出了完整备份',
  'life.plan.created': '新建了计划', 'life.plan.updated': '修改了计划', 'life.settings': '修改了生活设置',
  'media.admin.imported': '导入了媒体', 'media.metadata.updated': '修改了媒体信息', 'media.permanently.deleted': '永久删除了媒体',
  'media.restored': '从回收站恢复了媒体', 'media.trashed': '把媒体移进回收站', 'media.trashed.legacy': '把媒体移进回收站',
  'ombre.memory.commit.retry': '重试写入记忆', 'persona.avatar.updated': '换了头像', 'persona.reference.deleted': '删除了形象参考图',
  'persona.reference.uploaded': '上传了形象参考图', 'sticker.deleted': '删除了表情', 'storage.cleanup.applied': '执行了存储清理',
  'storage.cleanup.previewed': '预览了存储清理', 'storage.policy.updated': '修改了清理规则', 'video.model.updated': '修改了视频模型',
  'video.policy.updated': '修改了视频规则', 'video.task.deleted': '删除了视频任务', 'voice.behavior.updated': '修改了语音行为',
  'voice.settings.updated': '修改了语音设置'
};

function detailText(detail: unknown): string | null {
  if (detail == null) return null;
  if (typeof detail === 'string') return detail.trim() || null;
  try {
    const text = JSON.stringify(detail, null, 2);
    return text === '{}' ? null : text;
  } catch {
    return String(detail);
  }
}

/* ============================================================== overview */

function SystemSections({ system, reload, reloading }: { system: AdminSystemStatus; reload: () => void; reloading: boolean }) {
  const { navigate } = useConsole();
  const db = system.database;
  const storage = system.storage as Record<string, unknown>;
  const stream = system.stream as { subscribers?: number; lastEventSeq?: number };
  const agent = system.agent as { active?: boolean; tools?: Array<{ name?: string } | string>; capabilities?: Array<{ name: string; available: boolean }> };
  const load = system.loadAvg ?? [];
  const noLoad = load.every((n) => !n) && system.platform.startsWith('win');
  const agentCaps = agent.capabilities ?? [];
  const agentTools = agent.tools ?? [];

  return (
    <>
      <Section title="系统" desc="服务本身的运行情况。">
        <div className="cs-actions" style={{ justifyContent: 'space-between' }}>
          <Status tone="ok">服务在运行</Status>
          <Button kind="text" size="sm" busy={reloading} onClick={reload}>刷新</Button>
        </div>
        <Facts items={[
          ['版本', system.version],
          ['启动于', fmtTime(system.startedAt)],
          ['已连续运行', fmtDuration(system.uptimeSec)],
          ['占用内存', `${system.memoryMb} MB`],
          ['系统负载', noLoad ? 'Windows 上读不到' : load.map((n) => n.toFixed(2)).join(' / ')],
          ['运行环境', `Node ${system.node.replace(/^v/, '')}，${system.platform}`]
        ]} />
      </Section>

      <Section title="数据与存储" desc="数据库里有多少东西，占了多少空间。">
        {Boolean(db.recovered) && (
          <Callout tone="warn">
            数据库上次启动时出过问题，已经自动从{db.recoveredFrom ? `备份 ${String(db.recoveredFrom)} ` : '备份'}恢复。最近的一些记录可能丢了，建议去看看聊天记录。
          </Callout>
        )}
        {db.inconsistent != null && db.inconsistent !== false && (
          <Callout tone="bad">数据库检查发现不一致：{typeof db.inconsistent === 'string' ? db.inconsistent : JSON.stringify(db.inconsistent)}。建议先创建一份备份再排查。</Callout>
        )}
        <Facts items={[
          ['消息', Number(db.messages ?? 0).toLocaleString()],
          ['记忆', Number(db.memories ?? 0).toLocaleString()],
          ['对话总结', Number(db.summaries ?? 0).toLocaleString()],
          ['媒体文件', Number(db.media ?? 0).toLocaleString()],
          ['等待处理的任务', Number(db.pendingJobs ?? 0).toLocaleString()],
          ['媒体占用', fmtBytes(storage.mediaBytes)],
          ['数据库大小', fmtBytes(storage.dataBytes)],
          ['备份占用', fmtBytes(storage.backupBytes)],
          ['磁盘剩余', storage.freeBytes == null ? '读不到' : fmtBytes(storage.freeBytes)],
          ['空间提醒', storage.warning === 'hard' ? '已超过上限' : storage.warning === 'soft' ? '超过提醒线' : '正常'],
          ['正在维护', storage.maintenanceRunning ? '是' : '否']
        ]} />
        <div className="cs-actions"><Button kind="quiet" size="sm" onClick={() => navigate(consolePath('storage'))}>去存储与备份</Button></div>
      </Section>

      <Section title="实时推送与代理" desc="管理页面的实时连接，以及负责调用工具的代理。">
        <Facts items={[
          ['正在接收实时推送的页面', `${stream.subscribers ?? 0} 个`],
          ['最新事件编号', String(stream.lastEventSeq ?? '—')],
          ['代理（Agent）', agent.active ? '在运行' : '没有在运行'],
          ['代理可用的内置工具', agentTools.length ? `${agentTools.length} 个` : '没有'],
          ['代理可用的能力', agentCaps.length ? `${agentCaps.filter((c) => c.available).length} / ${agentCaps.length}` : '—']
        ]} />
        {agentTools.length > 0 && (
          <p className="cs-muted">内置工具：{agentTools.map((t) => typeof t === 'string' ? t : t.name ?? '?').join('、')}</p>
        )}
      </Section>
    </>
  );
}

function CapabilityList({ caps }: { caps: AdminCapabilities }) {
  const { navigate } = useConsole();
  const entries = Object.entries(caps.capabilities ?? {});
  const ready = entries.filter(([, v]) => capabilityState(v).ok || capabilityState(v).configured).length;
  if (entries.length === 0) return <Empty>服务端没有报告任何能力。</Empty>;
  return (
    <>
      <div className="cs-actions" style={{ justifyContent: 'space-between' }}>
        <Status tone={ready === entries.length ? 'ok' : ready === 0 ? 'bad' : 'warn'}>{ready} / {entries.length} 项可用</Status>
        <Button kind="text" size="sm" onClick={() => navigate(consolePath('models'))}>去配置模型</Button>
      </div>
      <div className="cs-list">
        {entries.map(([key, value]) => {
          const c = capabilityState(value);
          const tone: Tone = c.ok ? 'ok' : c.configured ? 'warn' : 'off';
          return (
            <div className="cs-list-item" key={key}>
              <span className="cs-list-title">{CAPABILITIES[key] ?? key}</span>
              <span className="cs-list-side"><Status tone={tone}>{c.ok ? '可用' : c.configured ? '已配置但有问题' : '没有配置'}</Status></span>
              <span className="cs-list-meta">
                {[c.provider, c.model, c.detail && c.detail !== 'ok' ? CAPABILITY_DETAIL[c.detail] ?? c.detail : null, c.checkedAt ? `检查于 ${fmtAgo(c.checkedAt)}` : null]
                  .filter(Boolean).join('，') || '—'}
              </span>
            </div>
          );
        })}
      </div>
      {caps.embeddingDimensions != null && <p className="cs-muted">记忆向量维度：{caps.embeddingDimensions}</p>}
    </>
  );
}

function onOffStatus(on: boolean | undefined) {
  return <Status tone={on ? 'ok' : 'off'}>{on ? '开启' : '关闭'}</Status>;
}

function PolicyList({ caps }: { caps: AdminCapabilities }) {
  const p = caps.policy;
  if (!p) return <Empty>服务端没有返回能力策略。</Empty>;
  const pro = p.proactive;
  const reasons = (pro?.reasons ?? []).map(policyReasonText);
  return (
    <>
      {pro && (
        <Callout tone={pro.effective ? 'ok' : 'warn'}>
          {pro.effective ? '她现在会主动找你。' : `她现在不会主动找你${reasons.length ? `：${reasons.join('；')}` : '。'}`}
        </Callout>
      )}
      <Facts items={[
        ['主动消息总开关', onOffStatus(pro?.enabled)],
        ['主动消息走 QQ 发出', onOffStatus(pro?.qqDelivery)],
        ['从生活里找话题', onOffStatus(pro?.lifeCandidates)],
        ['按约定的事主动提起', onOffStatus(pro?.futureCandidates)],
        ['QQ 通道', p.messaging?.qqBot && !p.messaging.qqConfigured ? <Status tone="warn">开启，但凭据不完整</Status> : onOffStatus(p.messaging?.qqBot)],
        ['记住以后要做的事', onOffStatus(p.continuity?.future)],
        ['关系的连续性', onOffStatus(p.continuity?.relationship)],
        ['时间线', onOffStatus(p.continuity?.timeline)],
        ['根据你的反馈调整', onOffStatus(p.continuity?.feedback)],
        ['记忆存放在', p.memory?.backend === 'ombre' ? 'Ombre 服务' : p.memory?.backend ? '本地数据库' : '—'],
        ['读取记忆', onOffStatus(p.memory?.read)],
        ['写入记忆', onOffStatus(p.memory?.write)],
        ['世界信息', onOffStatus(p.world?.enabled)],
        ['地点', onOffStatus(p.world?.location)],
        ['天气', onOffStatus(p.world?.weather)]
      ]} />
      <p className="cs-muted">这些开关由服务器配置综合算出，这里只能看，不能改。</p>
    </>
  );
}

function OverviewTab() {
  const data = useLoad(async () => {
    const [system, caps] = await Promise.all([adminApi.system(), adminApi.capabilities()]);
    return { system, caps };
  });
  return (
    <>
      {data.data ? (
        <SystemSections system={data.data.system} reloading={data.loading} reload={() => void data.reload()} />
      ) : (
        <Section title="系统"><Loadable state={data} label="系统信息">{() => null}</Loadable></Section>
      )}
      <Section title="能力" desc="每项能力背后要有配置好的模型或服务才能用。">
        <Loadable state={data} label="能力">{({ caps }) => <CapabilityList caps={caps} />}</Loadable>
      </Section>
      <Section title="能力策略" desc="哪些行为现在是打开的，以及为什么没打开。">
        <Loadable state={data} label="能力策略">{({ caps }) => <PolicyList caps={caps} />}</Loadable>
      </Section>
    </>
  );
}

/* ============================================================ jobs/errors */

function JobsSection() {
  const jobs = useLoad(() => adminApi.jobs());
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => groupJobs(jobs.data?.jobs ?? []), [jobs.data]);
  return (
    <Section title="后台任务" desc="最近 50 个后台任务，按类型和状态归在一起。失败的排在最前面。">
      <div className="cs-actions" style={{ justifyContent: 'flex-end' }}>
        <Button kind="text" size="sm" busy={jobs.loading} onClick={() => void jobs.reload()}>刷新任务</Button>
      </div>
      <Loadable state={jobs} label="后台任务">
        {({ jobs: list }) => list.length === 0 ? <Empty>最近没有后台任务。</Empty> : (
          <div className="cs-list">
            {groups.map((group) => {
              const [label, tone] = JOB_STATUS[group.status];
              const latest = group.items[0]!;
              const isOpen = open === group.key;
              return (
                <div className="cs-list-item" key={group.key}>
                  <span className="cs-list-title">{JOB_TYPES[group.type] ?? group.type}</span>
                  <span className="cs-list-side"><Status tone={tone}>{label}</Status><span className="cs-nowrap">{group.items.length} 个</span></span>
                  <span className="cs-list-meta">
                    最近一个更新于 {fmtAgo(latest.updated_at)}
                    {latest.last_error && group.status !== 'done' ? `，错误：${latest.last_error.slice(0, 120)}` : ''}
                  </span>
                  <span className="cs-list-body">
                    <Button kind="text" size="sm" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : group.key)}>{isOpen ? '收起' : '看每一个'}</Button>
                  </span>
                  {isOpen && (
                    <span className="cs-list-body">
                      <span className="cs-table-wrap" style={{ display: 'block' }}>
                        <table className="cs-table">
                          <thead><tr><th>创建</th><th>更新</th><th>尝试</th><th>错误</th></tr></thead>
                          <tbody>
                            {group.items.map((job) => (
                              <tr key={job.id} title={`${job.id}，${job.type}，${job.status}`}>
                                <td className="cs-nowrap">{fmtTime(job.created_at)}</td>
                                <td className="cs-nowrap">{fmtTime(job.updated_at)}</td>
                                <td data-num>{job.attempts} / {job.max_attempts}</td>
                                <td style={{ overflowWrap: 'anywhere' }}>{job.last_error ?? <span className="cs-muted">—</span>}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Loadable>
    </Section>
  );
}

function ErrorGroupItem({ group }: { group: ErrorGroup }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const latest = group.items[0]!;
  const shown = all ? group.items : group.items.slice(0, 5);
  return (
    <div className="cs-list-item">
      <span className="cs-list-title">{group.title}</span>
      <span className="cs-list-side"><Tag tone="bad">{group.items.length} 次</Tag></span>
      <span className="cs-list-meta">最近一次 {fmtAgo(latest.createdAt)}</span>
      <span className="cs-list-body">
        {group.explanation}{' '}
        <Button kind="text" size="sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? '收起技术详情' : '查看技术详情'}</Button>
      </span>
      {open && (
        <span className="cs-list-body" style={{ display: 'grid', gap: '0.75rem' }}>
          {shown.map((error) => {
            const detail = detailText(error.detail);
            return (
              <span key={error.id} style={{ display: 'grid', gap: '0.25rem' }}>
                <span className="cs-muted">{fmtTime(error.createdAt)}，来源 {error.scope}</span>
                <span style={{ overflowWrap: 'anywhere', color: 'var(--c-ink)' }}>{error.message}</span>
                {detail && <pre className="cs-code">{detail}</pre>}
              </span>
            );
          })}
          {group.items.length > 5 && (
            <Button kind="text" size="sm" onClick={() => setAll((v) => !v)}>{all ? '只看最近 5 次' : `看全部 ${group.items.length} 次`}</Button>
          )}
        </span>
      )}
    </div>
  );
}

function ErrorsSection() {
  const errors = useLoad(() => adminApi.errors());
  const { run, busy } = useAction();
  const groups = useMemo(() => groupErrors(errors.data?.errors ?? []), [errors.data]);
  const clear = async () => {
    const res = await run('clear', () => adminApi.clearErrors(), '错误记录已清空');
    if (res) await errors.reload();
  };
  return (
    <Section title="错误记录" desc="最近 100 条错误，同一类问题归在一起。处理完可以清空，方便看新问题有没有再出现。">
      <Loadable state={errors} label="错误记录">
        {({ errors: list }) => (
          <>
            <div className="cs-actions" style={{ justifyContent: 'space-between' }}>
              <Status tone={list.length ? 'bad' : 'ok'}>{list.length ? `${groups.length} 类问题，共 ${list.length} 次` : '没有错误记录'}</Status>
              <span className="cs-actions">
                <Button kind="text" size="sm" busy={errors.loading} onClick={() => void errors.reload()}>刷新</Button>
                {list.length > 0 && (
                  <ConfirmButton label="清空错误记录" question={`${list.length} 条记录会全部删掉，确定？`} confirmLabel="清空" busy={busy === 'clear'} onConfirm={clear} />
                )}
              </span>
            </div>
            {list.length === 0 ? <Empty>一切正常，没有需要处理的错误。</Empty> : (
              <div className="cs-list">{groups.map((g) => <ErrorGroupItem key={g.key} group={g} />)}</div>
            )}
          </>
        )}
      </Loadable>
    </Section>
  );
}

/* ================================================================ metrics */

const DAYS = [
  { value: '1', label: '今天' },
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
  { value: '90', label: '最近 90 天' }
];

function sumOf(rows: MetricAggregate[], category: string, metric: string): number {
  return rows.find((r) => r.category === category && r.metric === metric)?.sum ?? 0;
}
function avgOf(rows: MetricAggregate[], category: string, metric: string): number | null {
  const row = rows.find((r) => r.category === category && r.metric === metric);
  return row && row.count > 0 ? avgValue(row) : null;
}
/** The metrics endpoint sends sum and count; the average is derived here when it is missing. */
function avgValue(row: MetricAggregate): number {
  return typeof row.avg === 'number' && Number.isFinite(row.avg) ? row.avg : row.count > 0 ? row.sum / row.count : 0;
}
const rate = (good: number, total: number) => total > 0 ? `${Math.round((good / total) * 100)}%` : '—';
const seconds = (ms: number | null) => ms === null || !Number.isFinite(ms) ? '—' : ms < 1000 ? '1 秒内' : `${(ms / 1000).toFixed(1)} 秒`;
const num = (n: number | null | undefined) => typeof n !== 'number' || !Number.isFinite(n) ? '—'
  : Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 1 });

function MetricsTab() {
  const [days, setDays] = useState('7');
  const data = useLoad(async () => {
    const n = Number(days);
    const [agg, dist] = await Promise.all([adminApi.metrics(n), adminApi.metricsDistributions(n)]);
    return { aggregates: agg.aggregates, distributions: dist.distributions };
  }, [days]);
  const label = DAYS.find((d) => d.value === days)?.label ?? '';
  const picker = (
    <div className="cs-actions" data-no-dirty style={{ justifyContent: 'space-between' }}>
      <Select aria-label="统计时间范围" style={{ width: 'auto', maxWidth: '100%' }} options={DAYS} value={days} onChange={(e) => setDays(e.target.value)} />
      <Button kind="text" size="sm" busy={data.loading} onClick={() => void data.reload()}>刷新</Button>
    </div>
  );
  const rows = data.data;
  const empty = rows && rows.aggregates.length === 0 && rows.distributions.length === 0;

  return (
    <>
      <Section title="体验" desc={`${label}，你能直接感受到的几个数字。`}>
        {picker}
        <Loadable state={data} label="统计">
          {({ aggregates }) => empty ? (
            <Empty>这段时间还没有统计数据。如果一直是空的，检查服务器上的 METRICS_DASHBOARD_ENABLED 是否设为 true。</Empty>
          ) : (
            <Facts items={[
              ['到她开口的平均等待', seconds(avgOf(aggregates, 'reply', 'first_visible_ms'))],
              ['回复成功率', rate(sumOf(aggregates, 'reply', 'success'), sumOf(aggregates, 'reply', 'start'))],
              ['回复次数', num(sumOf(aggregates, 'reply', 'start'))],
              ['语音成功率', rate(sumOf(aggregates, 'voice', 'tts_success'), sumOf(aggregates, 'voice', 'tts_success') + sumOf(aggregates, 'voice', 'tts_failure'))],
              ['她主动找你', `${num(sumOf(aggregates, 'proactive', 'sent'))} 次`]
            ]} />
          )}
        </Loadable>
      </Section>
      {rows && !empty && (
        <>
          <Section title="全部统计" desc="每一项的次数、合计和平均值。">
            {rows.aggregates.length === 0 ? <Empty>这段时间没有记录。</Empty> : (
              <div className="cs-table-wrap">
                <table className="cs-table">
                  <thead><tr><th>项目</th><th>次数</th><th>合计</th><th>平均</th></tr></thead>
                  <tbody>
                    {rows.aggregates.map((row) => (
                      <tr key={`${row.category}.${row.metric}`}>
                        <td>{metricLabel(row.category, row.metric)}</td>
                        <td data-num>{num(row.count)}</td>
                        <td data-num>{num(row.sum)}</td>
                        <td data-num>{num(avgValue(row))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
          <Section title="分布" desc="耗时类数字的分布：中位数是一半情况比它快，95 分位是只有 5% 比它慢。">
            {rows.distributions.length === 0 ? <Empty>这段时间没有分布数据。</Empty> : (
              <div className="cs-table-wrap">
                <table className="cs-table">
                  <thead><tr><th>项目</th><th>次数</th><th>最小</th><th>中位数</th><th>95 分位</th><th>最大</th><th>平均</th></tr></thead>
                  <tbody>
                    {rows.distributions.map((row: MetricsDistribution) => (
                      <tr key={`${row.category}.${row.metric}`}>
                        <td>{metricLabel(row.category, row.metric)}</td>
                        <td data-num>{num(row.count)}</td>
                        <td data-num>{num(row.min)}</td>
                        <td data-num>{num(row.p50)}</td>
                        <td data-num>{num(row.p95)}</td>
                        <td data-num>{num(row.max)}</td>
                        <td data-num>{num(row.mean)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}

/* ================================================================== audit */

interface AuditEntry { id: string; category: string; action: string; target: string | null; detail: unknown; createdAt: string }

function AuditTab() {
  const [limit, setLimit] = useState(50);
  const audit = useLoad(() => adminRequest<{ audit: AuditEntry[] }>(`/api/admin/audit?limit=${limit}`), [limit]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Section title="操作记录" desc="在后台做过的改动：删了什么、改了什么设置、导出过什么。" wide>
      <div className="cs-actions" style={{ justifyContent: 'flex-end' }}>
        <Button kind="text" size="sm" busy={audit.loading} onClick={() => void audit.reload()}>刷新</Button>
      </div>
      <Loadable state={audit} label="操作记录">
        {({ audit: list }) => list.length === 0 ? <Empty>还没有操作记录。</Empty> : (
          <>
            <div className="cs-list">
              {list.map((entry) => {
                const detail = detailText(entry.detail);
                const isOpen = open === entry.id;
                return (
                  <div className="cs-list-item" key={entry.id}>
                    <span>
                      <span className="cs-list-title">{AUDIT_ACTION[`${entry.category}.${entry.action}`] ?? `${entry.category} ${entry.action}`}</span>
                      {entry.target && <span className="cs-muted" style={{ display: 'block', overflowWrap: 'anywhere' }}>{entry.target}</span>}
                    </span>
                    <span className="cs-list-side">
                      <Tag>{AUDIT_CATEGORY[entry.category] ?? entry.category}</Tag>
                      <span className="cs-muted cs-nowrap">{fmtTime(entry.createdAt)}</span>
                    </span>
                    {detail && (
                      <span className="cs-list-body">
                        <Button kind="text" size="sm" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : entry.id)}>{isOpen ? '收起详情' : '看详情'}</Button>
                        {isOpen && <pre className="cs-code">{detail}</pre>}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {list.length >= limit && limit < 500 && (
              <div className="cs-actions">
                <Button kind="quiet" size="sm" busy={audit.loading} onClick={() => setLimit((n) => Math.min(500, n + 100))}>再多看 100 条</Button>
              </div>
            )}
          </>
        )}
      </Loadable>
    </Section>
  );
}

/* =================================================================== page */

type TabId = 'overview' | 'health' | 'metrics' | 'audit';
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: '系统与能力' },
  { id: 'health', label: '任务与错误' },
  { id: 'metrics', label: '统计' },
  { id: 'audit', label: '操作记录' }
];

function initialTab(): TabId {
  const hash = typeof window !== 'undefined' ? window.location.hash.replace('#', '') : '';
  if (hash === 'errors' || hash === 'jobs') return 'health';
  return TABS.some((t) => t.id === hash) ? hash as TabId : 'overview';
}

export default function Ops() {
  const [tab, setTab] = useState<TabId>(initialTab);
  // follow the address when only its #fragment changes (a link to #errors while the page is open)
  useEffect(() => {
    const onHash = () => setTab(initialTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const change = (next: TabId) => {
    setTab(next);
    try { window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${next}`); } catch { /* ignore */ }
  };
  return (
    <div className="ops-root">
      <Page title="运行状况" register="system" intro="服务有没有正常运转，出了什么错，以及一段时间里的使用统计。">
        <Tabs label="运行状况分类" tabs={TABS} value={tab} onChange={change} />
        {tab === 'overview' && <OverviewTab />}
        {tab === 'health' && <><ErrorsSection /><JobsSection /></>}
        {tab === 'metrics' && <MetricsTab />}
        {tab === 'audit' && <AuditTab />}
      </Page>
    </div>
  );
}
