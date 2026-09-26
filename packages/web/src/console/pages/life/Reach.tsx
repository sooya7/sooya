import { useEffect, useRef, useState } from 'react';
import { adminApi } from '../../../lib/admin.js';
import { featureApi, type LifePanelData, type LifeSettings, type ProactiveAttempt } from '../../../lib/features.js';
import { contactBoundaryPayload } from '../../../lib/lifeObservation.js';
import { proactiveReasonText, reachReasonText, shareModeText } from '../../../lib/lifeView.js';
import { consolePath } from '../../routes.js';
import {
  Button, Callout, Empty, Facts, Field, Fields, Input, Loadable, Section, Select, Status, Switch, fmtAgo, useAction, useConsole, useLoad
} from '../../ui.js';
import { herWhen, useLife } from './shared.js';

export function ReachTab({ panel }: { panel: LifePanelData }) {
  return (
    <>
      <ReachStatus panel={panel} />
      <ReachSettings panel={panel} />
      <Attempts />
    </>
  );
}

function ReachStatus({ panel }: { panel: LifePanelData }) {
  const { reachOut, settings } = panel;
  const { navigate } = useConsole();
  const raw = reachReasonText(panel);
  // Some reasons only exist in the fuller proactive label table.
  const reason = raw === reachOut.reason ? proactiveReasonText(reachOut.reason) ?? raw : raw;
  const tone = !reachOut.enabledByDeployment || !settings.reachOut ? 'off' : reachOut.reach ? 'ok' : 'warn';
  return (
    <Section
      title="她会不会主动找你"
      desc="她主动的方式是发一条生活动态，分享刚做完的事，不会插进聊天记录。这里说的是按现在的条件，下一次检查时她会不会发。"
    >
      <div className="cs-actions">
        <Status tone={tone}>{reachOut.reach ? '会：' : '暂时不会：'}{reason}</Status>
        {reachOut.reason === 'chat_unavailable' && (
          <Button kind="text" size="sm" onClick={() => navigate(consolePath('models'))}>去配置聊天模型</Button>
        )}
      </div>
      {!reachOut.enabledByDeployment && (
        <Callout tone="warn">部署配置里关掉了主动分享（ENABLE_LIFE_ENGINE 或 ENABLE_LIFE_REACH_OUT），下面的设置暂时不起作用。要打开得改服务器的 .env 再重启服务。</Callout>
      )}
      <Facts items={[
        ['过去一天分享了', `${reachOut.sharedLastDay} 次，上限每天 ${settings.maxReachOutsPerDay} 次`],
        ['想分享的事', reachOut.candidate ? `${reachOut.candidate.activity}（${fmtAgo(reachOut.candidate.endedAt)}做完）` : '暂时没有'],
        ['你上次说话', reachOut.lastUserAt ? fmtAgo(reachOut.lastUserAt) : '还没有'],
        ['她上次说话', reachOut.lastAssistantAt ? fmtAgo(reachOut.lastAssistantAt) : '还没有']
      ]} />
    </Section>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));

type VisibleMode = 'auto' | 'text' | 'image';

function visibleMode(value: LifeSettings['proactiveMode']): VisibleMode {
  if (value === 'image') return 'image';
  if (value === 'auto' || value === undefined) return 'auto';
  return 'text';
}

function ReachSettings({ panel }: { panel: LifePanelData }) {
  const { refresh, touch, settle } = useLife();
  const { run, busy } = useAction();
  const [draft, setDraft] = useState<LifeSettings>(panel.settings);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const legacyMode = panel.settings.proactiveMode === 'voice' || panel.settings.proactiveMode === 'text_sticker';

  // Background refreshes must not overwrite what you are typing.
  useEffect(() => {
    if (!dirtyRef.current) setDraft(panel.settings);
  }, [panel.settings]);

  const change = (patch: Partial<LifeSettings>) => {
    setDraft((old) => ({ ...old, ...patch }));
    setDirty(true);
    touch('reach-settings');
  };

  const gapError = !Number.isInteger(draft.quietGapMinutes) || draft.quietGapMinutes < 5 || draft.quietGapMinutes > 1440 ? '填 5 到 1440 之间的整数。' : null;
  const capError = !Number.isInteger(draft.maxReachOutsPerDay) || draft.maxReachOutsPerDay < 0 || draft.maxReachOutsPerDay > 20 ? '填 0 到 20 之间的整数。' : null;

  const save = async () => {
    if (gapError || capError) return;
    const result = await run('save', () => featureApi.updateLifeSettings(contactBoundaryPayload(draft)), '主动找你的设置已保存');
    if (!result) return;
    setDraft(result.settings);
    setDirty(false);
    settle('reach-settings');
    refresh();
  };
  const discard = () => {
    setDraft(panel.settings);
    setDirty(false);
    settle('reach-settings');
  };

  const silentText = draft.silentFrom === draft.silentTo
    ? '开始和结束一样，表示全天都可以。'
    : `每天 ${String(draft.silentFrom).padStart(2, '0')}:00 到 ${String(draft.silentTo).padStart(2, '0')}:00 她不会主动找你（按她那边的时间）。`;

  return (
    <Section title="主动找你的设置" desc="多久能主动一次、一天最多几次、什么时段别打扰你。">
      <Switch checked={draft.reachOut} onChange={(v) => change({ reachOut: v })} label="允许她主动找你" />
      <Fields>
        <Field label="两次之间至少隔多久（分钟）" hint="5 到 1440。" error={gapError}>
          <Input type="number" min={5} max={1440} step={5} value={Number.isFinite(draft.quietGapMinutes) ? draft.quietGapMinutes : ''} disabled={!draft.reachOut}
            onChange={(e) => change({ quietGapMinutes: e.target.value === '' ? NaN : Number(e.target.value) })} />
        </Field>
        <Field label="一天最多几次" hint="0 到 20；填 0 等于今天不找你。" error={capError}>
          <Input type="number" min={0} max={20} value={Number.isFinite(draft.maxReachOutsPerDay) ? draft.maxReachOutsPerDay : ''} disabled={!draft.reachOut}
            onChange={(e) => change({ maxReachOutsPerDay: e.target.value === '' ? NaN : Number(e.target.value) })} />
        </Field>
        <Field label="安静时段从">
          <Select value={String(draft.silentFrom)} options={HOURS} disabled={!draft.reachOut} onChange={(e) => change({ silentFrom: Number(e.target.value) })} />
        </Field>
        <Field label="到">
          <Select value={String(draft.silentTo)} options={HOURS} disabled={!draft.reachOut} onChange={(e) => change({ silentTo: Number(e.target.value) })} />
        </Field>
        <Field label="用什么方式" hint="图片动态需要生图服务，没配置时会自动改发文字。" full>
          <Select value={visibleMode(draft.proactiveMode)} disabled={!draft.reachOut} options={[
            { value: 'auto', label: '她自己决定' }, { value: 'text', label: '文字动态' }, { value: 'image', label: '带图的动态' }
          ]} onChange={(e) => change({ proactiveMode: e.target.value as VisibleMode })} />
        </Field>
      </Fields>
      <p className="cs-muted life-hint">{silentText}</p>
      {legacyMode && !dirty && (
        <p className="cs-muted life-hint">现在存的是旧的“{shareModeText(panel.settings.proactiveMode)}”方式，会按文字动态发；保存一次就会换成新的写法。</p>
      )}
      <div className="cs-actions">
        <Button busy={busy === 'save'} disabled={!dirty || !!gapError || !!capError} onClick={() => void save()}>保存主动找你的设置</Button>
        {dirty && <Button kind="text" onClick={discard}>放弃修改</Button>}
      </div>
    </Section>
  );
}

function attemptTone(status: string): 'ok' | 'warn' | 'bad' {
  return status === 'sent' ? 'ok' : status === 'blocked' ? 'warn' : 'bad';
}

const ATTEMPT_STATUS: Record<string, string> = { sent: '发出去了', blocked: '没有发', failed: '发送失败' };

function Attempts() {
  const { version, tz } = useLife();
  const state = useLoad(() => adminApi.proactiveAttempts(), [version]);
  const [onlySent, setOnlySent] = useState(false);

  return (
    <Section title="最近的主动尝试" desc="每次她想主动找你都会留一条：发没发、为什么没发、你有没有回应。最多显示最近 100 条。">
      <Loadable state={state} label="主动记录">
        {({ attempts: raw }) => {
          const attempts = raw as unknown as ProactiveAttempt[];
          const rows = onlySent ? attempts.filter((a) => a.status === 'sent') : attempts;
          if (!attempts.length) return <Empty>还没有主动尝试的记录。她有想分享的事、又满足上面的条件时，这里就会出现第一条。</Empty>;
          return (
            <>
              <div data-no-dirty>
                <Switch checked={onlySent} onChange={setOnlySent} label="只看发出去的" />
              </div>
              {rows.length ? (
                <div className="cs-table-wrap">
                  <table className="cs-table">
                    <thead><tr><th>时间</th><th>想分享的事</th><th>结果</th><th>方式</th><th>原因</th><th>你的回应</th></tr></thead>
                    <tbody>
                      {rows.map((a) => {
                        const requested = shareModeText(a.requestedMode);
                        const final = shareModeText(a.finalMode);
                        const reason = proactiveReasonText(a.blockedReason) ?? proactiveReasonText(a.fallbackReason);
                        return (
                          <tr key={a.id}>
                            <td className="cs-nowrap">{herWhen(a.createdAt, tz)}</td>
                            <td>{a.candidateActivity ?? <span className="cs-muted">—</span>}</td>
                            <td className="cs-nowrap"><Status tone={attemptTone(a.status)}>{ATTEMPT_STATUS[a.status] ?? a.status}</Status></td>
                            <td className="cs-nowrap">{final && requested && final !== requested ? `${requested}，改成了${final}` : final ?? requested ?? '—'}</td>
                            <td>{reason ?? <span className="cs-muted">—</span>}</td>
                            <td className="cs-nowrap">{a.userRespondedAt ? `${fmtAgo(a.userRespondedAt)}回了` : a.status === 'sent' ? '还没回' : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : <p className="cs-muted">最近没有发出去的。</p>}
            </>
          );
        }}
      </Loadable>
    </Section>
  );
}
