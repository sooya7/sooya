import { adminApi, type AdminLifeVitals } from '../../lib/admin.js';
import { lifeEventText } from '../../lib/lifeView.js';
import { policyReasonText } from '../labels.js';
import { consolePath } from '../routes.js';
import {
  Button, Callout, Empty, Facts, Loadable, Meter, Page, Section, Status, fmtAgo, fmtBytes, fmtDuration, fmtTime, useConsole, useLoad
} from '../ui.js';

type Vital = [keyof AdminLifeVitals, string];

/** What keeps her going (low is bad) and what weighs on her (high is bad). */
const SUSTAINING: Vital[] = [['energy', '精力'], ['focus', '专注'], ['comfort', '舒适'], ['curiosity', '好奇']];
const WEIGHING: Vital[] = [['hunger', '饥饿'], ['stress', '压力'], ['loneliness', '孤单'], ['social_need', '想找人说话'], ['sleep_debt', '缺觉']];

/** Vitals arrive either as 0..1 or 0..100. */
export function unit(value: number): number {
  return value > 1 ? value / 100 : value;
}

function tone(risk: number): 'warn' | 'bad' | undefined {
  return risk >= 0.8 ? 'bad' : risk >= 0.6 ? 'warn' : undefined;
}

const CAPABILITY_LABELS: Record<string, string> = {
  chat: '聊天', vision: '看图', summary: '对话总结', director: '媒体导演', sticker: '表情', embedding: '记忆向量',
  rerank: '记忆重排', image: '生图', video: '视频', tts: '语音', webSearch: '联网搜索', decision: '行为决策',
  weather: '天气', mcp: '工具', qq: 'QQ'
};

function capabilityReady(value: unknown): boolean {
  return !!value && typeof value === 'object' && Boolean((value as { ok?: boolean }).ok || (value as { configured?: boolean }).configured);
}

export default function Now() {
  const { moment, navigate } = useConsole();
  const health = useLoad(async () => {
    const [system, capabilities, backups, errors] = await Promise.all([
      adminApi.system(), adminApi.capabilities(), adminApi.backups(), adminApi.errors()
    ]);
    return { system, capabilities, backups: backups.backups, errors: errors.errors };
  });
  const overview = moment?.overview;
  const vitals = overview?.vitals;

  return (
    <Page title="此刻" register="her" headless>
      {moment !== null && !overview && (
        <Section title="她的生活" desc="顶部的状态来自生活模拟。">
          <Empty action={<Button kind="quiet" size="sm" onClick={() => navigate(consolePath('life'))}>去生活页面看看</Button>}>
            读不到生活模拟的数据，可能是生活功能没有开启。
          </Empty>
        </Section>
      )}

      {vitals && (
        <Section title="身体和情绪" desc="数值越偏向一边，她的言行越会受影响。可以在生活页面调整。">
          <div className="cs-meters">
            <div className="cs-meters-group">
              <h3>撑着她的</h3>
              {SUSTAINING.map(([key, label]) => {
                const value = unit(Number(vitals[key] ?? 0));
                return <Meter key={key} label={label} value={value} tone={tone(1 - value)} />;
              })}
            </div>
            <div className="cs-meters-group">
              <h3>压着她的</h3>
              {WEIGHING.map(([key, label]) => {
                const value = unit(Number(vitals[key] ?? 0));
                return <Meter key={key} label={label} value={value} tone={tone(value)} />;
              })}
            </div>
          </div>
        </Section>
      )}

      {overview && (overview.openThreads.length > 0 || overview.recentEvents.length > 0) && (
        <Section title="她惦记的事" desc="还没结束的事情，以及最近发生的。">
          {overview.openThreads.length > 0 && (
            <div className="cs-list">
              {overview.openThreads.map((thread) => (
                <div className="cs-list-item" key={thread.id}>
                  <span className="cs-list-title">{thread.title}</span>
                  <span className="cs-list-meta">进度 {Math.round(unit(thread.progress) * 100)}%</span>
                </div>
              ))}
            </div>
          )}
          {overview.recentEvents.length > 0 && (
            <div className="cs-list">
              {overview.recentEvents.slice(0, 6).map((event) => (
                <div className="cs-list-item" key={event.id}>
                  <span>{event.description || lifeEventText(event.eventType)}</span>
                  <span className="cs-list-meta">{fmtAgo(event.happenedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      <Section title="系统" desc="只列出需要你注意的部分。" wide>
        <Loadable state={health} label="系统状态">
          {({ system, capabilities, backups, errors }) => {
            const entries = Object.entries(capabilities.capabilities ?? {});
            const missing = entries.filter(([, value]) => !capabilityReady(value)).map(([key]) => CAPABILITY_LABELS[key] ?? key);
            const latestBackup = [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            const backupAgeDays = latestBackup ? (Date.now() - new Date(latestBackup.createdAt).getTime()) / 86400000 : Infinity;
            const db = system.database;
            return (
              <>
                <div className="cs-actions" style={{ justifyContent: 'space-between' }}>
                  <Status tone="ok">服务在运行，已连续运行 {fmtDuration(system.uptimeSec)}</Status>
                  <Button kind="text" size="sm" busy={health.loading} onClick={() => void health.reload()}>刷新</Button>
                </div>
                <div className="cs-stats">
                  <div className="cs-stat" data-tone={missing.length ? 'warn' : undefined}>
                    <span className="cs-stat-value">{entries.length - missing.length}<small>/ {entries.length}</small></span>
                    <span className="cs-stat-label">项能力可用</span>
                    {missing.length > 0 && <span className="cs-stat-note">未就绪：{missing.join('、')}</span>}
                    <Button kind="text" size="sm" onClick={() => navigate(consolePath('models'))}>去配置模型</Button>
                  </div>
                  <div className="cs-stat" data-tone={errors.length ? 'bad' : undefined}>
                    <span className="cs-stat-value">{errors.length}<small>条</small></span>
                    <span className="cs-stat-label">错误记录</span>
                    {errors[0] && <span className="cs-stat-note">最近：{errors[0].message}（{fmtAgo(errors[0].createdAt)}）</span>}
                    <Button kind="text" size="sm" onClick={() => navigate(consolePath('ops'))}>查看运行状况</Button>
                  </div>
                  <div className="cs-stat" data-tone={!latestBackup ? 'bad' : backupAgeDays > 7 ? 'warn' : undefined}>
                    <span className="cs-stat-value">{latestBackup ? fmtAgo(latestBackup.createdAt) : '没有'}</span>
                    <span className="cs-stat-label">{latestBackup ? '最近一次备份' : '还没有任何备份'}</span>
                    <Button kind="text" size="sm" onClick={() => navigate(consolePath('storage'))}>去备份</Button>
                  </div>
                </div>
                <Facts items={[
                  ['消息', Number(db.messages ?? 0).toLocaleString()],
                  ['记忆', Number(db.memories ?? 0).toLocaleString()],
                  ['媒体文件', `${Number(db.media ?? 0).toLocaleString()} 个，${fmtBytes(system.storage.mediaBytes)}`],
                  ['待处理任务', Number(db.pendingJobs ?? 0).toLocaleString()],
                  ['版本', system.version],
                  ['启动于', fmtTime(system.startedAt)]
                ]} />
                {capabilities.policy?.proactive && capabilities.policy.proactive.effective === false && (
                  <Callout tone="warn">她现在不会主动找你{capabilities.policy.proactive.reasons?.length ? `：${capabilities.policy.proactive.reasons.map(policyReasonText).join('；')}` : '。'}</Callout>
                )}
              </>
            );
          }}
        </Loadable>
      </Section>
    </Page>
  );
}
