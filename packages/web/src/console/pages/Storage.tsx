import { useEffect, useMemo, useState } from 'react';
import { adminApi, getAdminToken, invalidateAdminSession, type AdminBackup } from '../../lib/admin.js';
import { featureApi } from '../../lib/features.js';
import {
  Button, Callout, ConfirmButton, Empty, Facts, Field, Fields, Input, Loadable, Meter, Page, Section, Status, Tag,
  fmtAgo, fmtBytes, fmtTime, useAction, useConsole, useLoad
} from '../ui.js';
import './Storage.css';

/* ------------------------------------------------------------------ types */

interface StoragePolicy {
  softLimitBytes: number;
  hardLimitBytes: number;
  trashRetentionDays: number;
  tempRetentionHours: number;
  backupKeep: number;
}

interface StorageStatus {
  mediaBytes: number;
  dataBytes: number;
  backupBytes: number;
  freeBytes: number | null;
  totalBytes: number | null;
  categories: Record<string, number>;
  policy: StoragePolicy;
  warning: 'soft' | 'hard' | null;
  maintenanceRunning: boolean;
  maintenance: { operation: string; startedAt: string } | null;
  activeWrites: number;
  trend: Array<{ createdAt: string; mediaBytes: number; dataBytes: number; freeBytes: number | null }>;
}

type CleanupItem = { id?: string; path?: string; relPath?: string; bytes: number; references?: number };

interface CleanupReport {
  reportId: string;
  generatedAt: string;
  candidates: Record<string, CleanupItem[]>;
  reclaimableBytes: number;
}

interface CleanupResult {
  applied: boolean;
  report: CleanupReport;
  deleted: Record<string, number>;
  skipped: Array<{ category: string; target: string; reason: string }>;
  releasedBytes: number;
  skippedBytes: number;
}

/* ----------------------------------------------------------------- labels */

const MB = 1024 * 1024;

const MEDIA_KINDS: Array<[string, string]> = [
  ['image', '图片'], ['audio', '语音'], ['sticker', '表情'], ['file', '文件'], ['trash', '回收站']
];

const CLEANUP: Record<string, { label: string; desc: string }> = {
  expiredTrash: { label: '回收站里过期的文件', desc: '放进回收站超过保留天数的图片、语音等。仍被聊天记录引用的不会删。' },
  unreferencedMedia: { label: '没人用的已删除媒体', desc: '已经删除、也没有任何消息引用的媒体文件。' },
  orphanFiles: { label: '没有记录的文件', desc: '磁盘上有、数据库里没有登记的文件。' },
  missingRecords: { label: '文件已丢失的记录', desc: '数据库里有登记、磁盘上找不到文件的媒体记录。清理只删记录。' },
  tempFiles: { label: '临时文件', desc: '上传或生成过程中留下、超过保留时长的临时文件。' },
  oldBackups: { label: '超出保留份数的旧备份', desc: '按“备份保留份数”，比最新几份更早的备份。' }
};

const SKIP_REASONS: Record<string, string> = {
  no_longer_safe: '预览之后又被使用了，保留',
  unsafe_path: '路径不在允许清理的目录里，保留',
  file_changed_or_missing: '预览之后文件变了或已不存在，跳过'
};

const OPERATIONS: Record<string, string> = {
  'backup.create': '创建备份', 'backup.restore': '恢复备份', 'backup.delete': '删除备份', 'storage.cleanup': '清理存储'
};

function itemTarget(item: CleanupItem): string {
  return String(item.path ?? item.relPath ?? item.id ?? '未知项目');
}

/* --------------------------------------------------------------- download */

/** Fetch a file with the admin token (a plain link can't carry the header) and hand the blob to the browser. */
async function downloadWithToken(path: string, fallbackName: string): Promise<{ name: string; bytes: number; plainSecrets: boolean }> {
  const token = getAdminToken();
  const headers = new Headers();
  if (token) headers.set('X-Admin-Token', token);
  const response = await fetch(path, { headers });
  if (response.status === 401 || response.status === 403) invalidateAdminSession(token);
  if (!response.ok) {
    const text = await response.text();
    let message = text || `导出失败（${response.status}）`;
    try {
      const body = JSON.parse(text) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch { /* plain text */ }
    throw new Error(message);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? fallbackName;
  const blob = await response.blob();
  saveBlob(blob, name);
  return { name, bytes: blob.size, plainSecrets: response.headers.get('x-sooya-backup-plain-secrets') === '1' };
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ usage */

function Usage({ data, onReload, reloading }: { data: StorageStatus; onReload: () => void; reloading: boolean }) {
  const { policy } = data;
  const ratio = policy.hardLimitBytes > 0 ? data.mediaBytes / policy.hardLimitBytes : 0;
  const trend = data.trend ?? [];
  const oldest = trend[trend.length - 1];
  const growth = oldest ? data.mediaBytes - oldest.mediaBytes : 0;
  return (
    <>
      <div className="cs-actions" style={{ justifyContent: 'space-between' }}>
        <Status tone={data.warning === 'hard' ? 'bad' : data.warning === 'soft' ? 'warn' : 'ok'}>
          {data.warning === 'hard' ? '媒体已经超过上限' : data.warning === 'soft' ? '媒体快到上限了' : '空间充足'}
        </Status>
        <Button kind="text" size="sm" busy={reloading} onClick={onReload}>刷新</Button>
      </div>
      {data.warning === 'hard' && <Callout tone="bad">媒体占用已超过上限 {fmtBytes(policy.hardLimitBytes)}，新图片和语音可能存不进去。先预览清理，或调高上限。</Callout>}
      {data.warning === 'soft' && <Callout tone="warn">媒体占用超过了提醒线 {fmtBytes(policy.softLimitBytes)}，建议清理一下回收站和旧文件。</Callout>}
      {data.maintenanceRunning && (
        <Callout tone="warn">
          正在{data.maintenance ? OPERATIONS[data.maintenance.operation] ?? data.maintenance.operation : '维护'}
          {data.maintenance?.startedAt ? `（开始于 ${fmtTime(data.maintenance.startedAt)}）` : ''}，期间不能再清理或恢复。
        </Callout>
      )}
      <Meter label="媒体占用" value={ratio} tone={data.warning === 'hard' ? 'bad' : data.warning === 'soft' ? 'warn' : undefined}
        display={`${Math.round(ratio * 100)}%`} />
      <p className="cs-muted">
        {fmtBytes(data.mediaBytes)}，上限 {fmtBytes(policy.hardLimitBytes)}
        {oldest && growth !== 0 ? `。自 ${fmtTime(oldest.createdAt)} 以来${growth > 0 ? '增加' : '减少'}了 ${fmtBytes(Math.abs(growth))}` : ''}。
      </p>
      <Facts items={[
        ...MEDIA_KINDS.map(([key, label]) => [label, fmtBytes(data.categories?.[key] ?? 0)] as [string, string]),
        ['数据库', fmtBytes(data.dataBytes)],
        ['备份', fmtBytes(data.backupBytes)],
        ['磁盘剩余', data.freeBytes == null ? '读不到' : `${fmtBytes(data.freeBytes)}${data.totalBytes ? `，共 ${fmtBytes(data.totalBytes)}` : ''}`]
      ]} />
    </>
  );
}

/* ----------------------------------------------------------------- policy */

type PolicyDraft = Record<keyof StoragePolicy, string>;

function toDraft(policy: StoragePolicy): PolicyDraft {
  return {
    softLimitBytes: String(Math.round(policy.softLimitBytes / MB)),
    hardLimitBytes: String(Math.round(policy.hardLimitBytes / MB)),
    trashRetentionDays: String(policy.trashRetentionDays),
    tempRetentionHours: String(policy.tempRetentionHours),
    backupKeep: String(policy.backupKeep)
  };
}

function PolicyForm({ policy, onSaved }: { policy: StoragePolicy; onSaved: () => void }) {
  const { markClean } = useConsole();
  const { run, busy } = useAction();
  const [draft, setDraft] = useState<PolicyDraft>(() => toDraft(policy));
  useEffect(() => setDraft(toDraft(policy)), [policy]);

  const num = (key: keyof PolicyDraft) => Number(draft[key]);
  const errors: Partial<Record<keyof PolicyDraft, string>> = {};
  for (const key of Object.keys(draft) as Array<keyof PolicyDraft>) {
    if (!/^\d+$/.test(draft[key].trim()) || num(key) <= 0) errors[key] = '请填一个大于 0 的整数';
  }
  if (!errors.softLimitBytes && !errors.hardLimitBytes && num('softLimitBytes') >= num('hardLimitBytes')) {
    errors.softLimitBytes = '提醒线要比上限低';
  }
  const invalid = Object.keys(errors).length > 0;
  const set = (key: keyof PolicyDraft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: e.target.value }));

  const save = async () => {
    const res = await run('save', () => featureApi.updateStorage({
      softLimitBytes: num('softLimitBytes') * MB,
      hardLimitBytes: num('hardLimitBytes') * MB,
      trashRetentionDays: num('trashRetentionDays'),
      tempRetentionHours: num('tempRetentionHours'),
      backupKeep: num('backupKeep')
    }), '清理规则已保存');
    if (res) { markClean(); onSaved(); }
  };

  return (
    <>
      <Fields>
        <Field label="媒体提醒线（MB）" hint="超过后这里会提醒你清理。" error={errors.softLimitBytes}>
          <Input inputMode="numeric" value={draft.softLimitBytes} onChange={set('softLimitBytes')} />
        </Field>
        <Field label="媒体上限（MB）" hint="超过后新的图片、语音可能存不进去。" error={errors.hardLimitBytes}>
          <Input inputMode="numeric" value={draft.hardLimitBytes} onChange={set('hardLimitBytes')} />
        </Field>
        <Field label="回收站保留天数" hint="删掉的媒体在回收站里放多久。" error={errors.trashRetentionDays}>
          <Input inputMode="numeric" value={draft.trashRetentionDays} onChange={set('trashRetentionDays')} />
        </Field>
        <Field label="临时文件保留小时" hint="上传或生成过程中留下的临时文件放多久。" error={errors.tempRetentionHours}>
          <Input inputMode="numeric" value={draft.tempRetentionHours} onChange={set('tempRetentionHours')} />
        </Field>
        <Field label="备份保留份数" hint="新建备份时，更早的会被自动删掉。" error={errors.backupKeep}>
          <Input inputMode="numeric" value={draft.backupKeep} onChange={set('backupKeep')} />
        </Field>
      </Fields>
      <div className="cs-actions">
        <Button busy={busy === 'save'} disabled={invalid} onClick={() => void save()}>保存清理规则</Button>
        <Button kind="text" size="sm" onClick={() => { setDraft(toDraft(policy)); markClean(); }}>还原</Button>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- cleanup */

const PAGE = 30;

function Cleanup({ busyElsewhere, onChanged }: { busyElsewhere: boolean; onChanged: () => void }) {
  const { run, busy } = useAction();
  const [preview, setPreview] = useState<CleanupResult | null>(null);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const groups = useMemo(() => {
    if (!preview) return [];
    return Object.entries(preview.report.candidates ?? {}).map(([key, items]) => ({
      key,
      label: CLEANUP[key]?.label ?? key,
      desc: CLEANUP[key]?.desc ?? '',
      items: Array.isArray(items) ? items : [],
      bytes: (Array.isArray(items) ? items : []).reduce((sum, item) => sum + Number(item.bytes ?? 0), 0)
    }));
  }, [preview]);
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  const chosenBytes = groups.filter((g) => chosen.has(g.key)).reduce((sum, g) => sum + g.bytes, 0);
  const chosenCount = groups.filter((g) => chosen.has(g.key)).reduce((sum, g) => sum + g.items.length, 0);
  const expired = preview ? Date.now() - Date.parse(preview.report.generatedAt) > 55 * 60_000 : false;

  const makePreview = async () => {
    const res = await run('preview', () => featureApi.cleanupStorage(false) as Promise<CleanupResult>);
    if (!res) return;
    setPreview(res);
    setResult(null);
    setOpen(null);
    setChosen(new Set(Object.entries(res.report.candidates ?? {}).filter(([, items]) => Array.isArray(items) && items.length > 0).map(([key]) => key)));
  };

  const apply = async () => {
    if (!preview) return;
    const res = await run('apply', () => featureApi.cleanupStorage(true, [...chosen], preview.report.reportId) as Promise<CleanupResult>);
    if (!res) return;
    setResult(res);
    setPreview(null);
    onChanged();
  };

  const toggle = (key: string) => setChosen((old) => {
    const next = new Set(old);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const downloadReport = () => {
    if (!preview) return;
    saveBlob(new Blob([JSON.stringify(preview, null, 2)], { type: 'application/json' }), `${preview.report.reportId}.json`);
  };

  return (
    <div data-no-dirty style={{ display: 'grid', gap: '1rem' }}>
      <div className="cs-actions">
        <Button kind={preview ? 'quiet' : 'primary'} busy={busy === 'preview'} disabled={!!busy || busyElsewhere} onClick={() => void makePreview()}>
          {preview ? '重新预览' : '预览可以清理的内容'}
        </Button>
        {!preview && <span className="cs-muted">预览不会删除任何东西。</span>}
      </div>

      {result && (
        <Callout tone="ok">
          清理完成，释放了 {fmtBytes(result.releasedBytes)}
          {Object.keys(result.deleted).length > 0 && `：${Object.entries(result.deleted).map(([k, n]) => `${CLEANUP[k]?.label ?? k} ${n} 项`).join('，')}`}。
          {result.skipped.length > 0 && ` 有 ${result.skipped.length} 项因为预览后发生了变化被保留（${fmtBytes(result.skippedBytes)}）。`}
        </Callout>
      )}
      {result && result.skipped.length > 0 && (
        <div className="cs-list">
          {result.skipped.slice(0, 50).map((s, i) => (
            <div className="cs-list-item" key={`${s.target}-${i}`}>
              <span style={{ overflowWrap: 'anywhere' }}>{s.target}</span>
              <span className="cs-list-side cs-muted">{SKIP_REASONS[s.reason] ?? s.reason}</span>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <>
          <p>
            预览生成于 {fmtTime(preview.report.generatedAt)}，一共 {total.toLocaleString()} 项，最多能释放 {fmtBytes(preview.report.reclaimableBytes)}。
            <Button kind="text" size="sm" onClick={downloadReport}>下载完整清单</Button>
          </p>
          {expired && <Callout tone="warn">这份预览快过期了（预览只保留一小时），清理前请重新预览。</Callout>}
          {total === 0 ? <Empty>没有需要清理的内容。</Empty> : (
            <div className="cs-list">
              {groups.filter((group) => group.items.length > 0).map((group) => {
                const isOpen = open === group.key;
                const pages = Math.max(1, Math.ceil(group.items.length / PAGE));
                const visible = group.items.slice(page * PAGE, (page + 1) * PAGE);
                return (
                  <div className="cs-list-item" key={group.key}>
                    <label className="cs-choice">
                      <input type="checkbox" checked={chosen.has(group.key)} onChange={() => toggle(group.key)} />
                      <span className="cs-list-title">{group.label}</span>
                    </label>
                    <span className="cs-list-side cs-nowrap">{group.items.length} 项，{fmtBytes(group.bytes)}</span>
                    <span className="cs-list-body">
                      {group.desc}{' '}
                      {group.items.length > 0 && (
                        <Button kind="text" size="sm" aria-expanded={isOpen} onClick={() => { setOpen(isOpen ? null : group.key); setPage(0); }}>
                          {isOpen ? '收起明细' : '看明细'}
                        </Button>
                      )}
                    </span>
                    {isOpen && (
                      <span className="cs-list-body">
                        <span className="cs-list">
                          {visible.map((item, i) => (
                            <span className="cs-list-item" key={`${itemTarget(item)}-${i}`}>
                              <span style={{ overflowWrap: 'anywhere' }}>{itemTarget(item)}</span>
                              <span className="cs-list-side cs-muted">{fmtBytes(item.bytes)}</span>
                            </span>
                          ))}
                        </span>
                        {pages > 1 && (
                          <span className="cs-actions">
                            <Button kind="text" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>上一页</Button>
                            <span className="cs-muted">{page + 1} / {pages}</span>
                            <Button kind="text" size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>下一页</Button>
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {total > 0 && groups.some((g) => g.items.length === 0) && (
            <p className="cs-muted">其余类别（{groups.filter((g) => g.items.length === 0).map((g) => g.label).join('、')}）没有需要清理的。</p>
          )}
          {total > 0 && (
            <div className="cs-actions">
              <ConfirmButton
               
                label={`清理选中的 ${chosenCount} 项`}
                question={`会永久删除约 ${fmtBytes(chosenBytes)}，删掉就找不回来。确定清理？`}
                confirmLabel="永久删除"
                busy={busy === 'apply'}
                disabled={chosen.size === 0 || chosenCount === 0 || busyElsewhere}
                onConfirm={apply}
              />
              <span className="cs-muted">只会删除预览里列出、而且现在依然可以安全删除的项目。</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- backups */

const RESTORE_CONSEQUENCES = [
  '当前数据库会整个换成这份备份：聊天记录、记忆、生活状态、设置都会回到备份那一刻，之后新增或修改的全部没有了。',
  '图片、语音等媒体文件不会跟着回退；备份之后新增的媒体，在聊天记录里会找不到引用。',
  '恢复前服务器会先校验这份备份，校验不过就不会动当前数据。',
  '服务器会把当前数据库另存一份（文件名带 pre-restore），但这里看不到它，要找回只能到服务器上手动处理。',
  '恢复期间她暂停收发消息，完成后已打开的聊天页面会自动刷新。'
];

function BackupRow({ backup, busy, onVerify, onRestore, onDelete, verifyResult, maintenance }: {
  backup: AdminBackup; busy: string | null; maintenance: boolean;
  onVerify: () => void; onRestore: () => Promise<unknown>; onDelete: () => Promise<unknown>;
  verifyResult?: { ok: boolean; detail: string };
}) {
  const [restoring, setRestoring] = useState(false);
  return (
    <div className="cs-list-item">
      <span>
        <span className="cs-list-title">{fmtTime(backup.createdAt, true)}</span>{' '}
        <span className="cs-muted">{fmtAgo(backup.createdAt)}</span>
      </span>
      <span className="cs-list-side">
        {backup.verified ? <Tag tone="ok">有校验值</Tag> : <Tag tone="warn">没有校验值</Tag>}
      </span>
      <span className="cs-list-meta" style={{ gridColumn: '1 / -1' }}>
        {backup.name}，{fmtBytes(backup.bytes)}，{backup.mediaArchived ? '含媒体文件' : '不含媒体文件'}
        {backup.sha256 ? `，校验值 ${backup.sha256.slice(0, 12)}…` : ''}
      </span>
      {verifyResult && (
        <span className="cs-list-body">
          <Status tone={verifyResult.ok ? 'ok' : 'bad'}>
            {verifyResult.ok ? '校验通过，这份备份完整可用' : `校验没通过：${verifyResult.detail === 'checksum mismatch' ? '文件内容和校验值对不上，可能已损坏' : verifyResult.detail === 'backup not found' ? '找不到这份备份文件' : verifyResult.detail}`}
          </Status>
        </span>
      )}
      <span className="cs-list-body">
        <span className="cs-actions">
          <Button kind="quiet" size="sm" busy={busy === `verify:${backup.name}`} disabled={!!busy} onClick={onVerify}>校验这份备份</Button>
          {!restoring && <Button kind="danger" size="sm" disabled={!!busy || maintenance} onClick={() => setRestoring(true)}>恢复到这份备份</Button>}
          <ConfirmButton label="删除" question="删除后无法找回，确定？" confirmLabel="删除这份备份" busy={busy === `delete:${backup.name}`} disabled={!!busy} onConfirm={onDelete} />
        </span>
      </span>
      {restoring && (
        <span className="cs-list-body">
          <Callout tone="bad">
            <strong>恢复到 {fmtTime(backup.createdAt, true)} 的备份会发生这些事：</strong>
            <ul style={{ listStyle: 'disc', paddingLeft: '1.25rem', marginBlock: '0.5rem' }}>
              {RESTORE_CONSEQUENCES.map((line) => <li key={line}>{line}</li>)}
            </ul>
            如果不确定，先点“立即备份”把现在的状态也存一份。
          </Callout>
          <span className="cs-actions" style={{ marginTop: '0.75rem' }}>
            <ConfirmButton
             
              label="我明白，用这份备份覆盖当前数据"
              question="当前数据会被覆盖，最后确认一次："
              confirmLabel="确认恢复"
              busy={busy === `restore:${backup.name}`}
              disabled={maintenance}
              onConfirm={async () => { await onRestore(); setRestoring(false); }}
            />
            <Button kind="text" size="sm" onClick={() => setRestoring(false)}>不恢复了</Button>
          </span>
        </span>
      )}
    </div>
  );
}

function Backups({ keep, maintenance, onChanged }: { keep: number; maintenance: boolean; onChanged: () => void }) {
  const list = useLoad(() => adminApi.backups());
  const { run, busy } = useAction();
  const { notify } = useConsole();
  const [verified, setVerified] = useState<Record<string, { ok: boolean; detail: string }>>({});

  const create = async () => {
    const res = await run('create', () => adminApi.createBackup());
    if (!res) return;
    notify(`备份已创建（${fmtBytes(res.backup.bytes)}）`, 'ok');
    await list.reload();
    onChanged();
  };
  const verify = async (name: string) => {
    const res = await run(`verify:${name}`, () => adminApi.verifyBackup(name));
    if (!res) return;
    const ok = res.ok === true;
    setVerified((v) => ({ ...v, [name]: { ok, detail: String(res.detail ?? '') } }));
    notify(ok ? '校验通过' : '校验没通过', ok ? 'ok' : 'bad');
  };
  const restore = async (name: string) => {
    const res = await run(`restore:${name}`, () => adminApi.restoreBackup(name), '已恢复到这份备份');
    if (res) { await list.reload(); onChanged(); }
  };
  const remove = async (name: string) => {
    const res = await run(`delete:${name}`, () => adminApi.deleteBackup(name), '备份已删除');
    if (res) { await list.reload(); onChanged(); }
  };

  return (
    <>
      <div className="cs-actions">
        <Button busy={busy === 'create'} disabled={!!busy || maintenance} onClick={() => void create()}>立即备份</Button>
        <span className="cs-muted">备份当前数据库，最多保留 {keep} 份，更早的会自动删除。</span>
      </div>
      {maintenance && <p className="cs-muted">服务器正在做别的维护，稍后再备份或恢复。</p>}
      <Loadable state={list} label="备份列表">
        {({ backups }) => backups.length === 0 ? (
          <Empty>还没有任何备份。建议现在就点“立即备份”存一份，出问题时才有地方可以回退。</Empty>
        ) : (
          <div className="cs-list">
            {[...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((backup) => (
              <BackupRow
                key={backup.name}
                backup={backup}
                busy={busy}
                maintenance={maintenance}
                verifyResult={verified[backup.name]}
                onVerify={() => void verify(backup.name)}
                onRestore={() => restore(backup.name)}
                onDelete={() => remove(backup.name)}
              />
            ))}
          </div>
        )}
      </Loadable>
    </>
  );
}

/* ----------------------------------------------------------------- export */

function FullExport() {
  const { run, busy } = useAction();
  const { notify } = useConsole();
  const [last, setLast] = useState<{ name: string; bytes: number; plainSecrets: boolean } | null>(null);

  const exportAll = async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const res = await run('export', () => downloadWithToken('/api/admin/full-backup/export', `SOOYA-server-to-IPA-${stamp}.zip`));
    if (!res) return;
    setLast(res);
    notify(`完整备份已导出（${fmtBytes(res.bytes)}）`, 'ok');
  };

  return (
    <>
      <p>
        把聊天记录，以及图片、语音、文件打包成一个 ZIP，可以在 IPA 版里用“导入完整备份”直接导入。记忆和表情包不在包里。
      </p>
      <Callout tone="warn">
        包里会带上当前模型和搜索服务的 API Key、Ombre 令牌，都是明文，没有加密。只在自己的设备之间传，别发给别人。管理令牌和服务器的整份环境变量不会导出。
      </Callout>
      <div className="cs-actions">
        <Button busy={busy === 'export'} onClick={() => void exportAll()}>下载完整备份</Button>
        {busy === 'export' && <span className="cs-muted">正在打包，媒体多的话要等一会儿…</span>}
      </div>
      {last && (
        <p className="cs-muted">
          已下载 {last.name}（{fmtBytes(last.bytes)}）{last.plainSecrets ? '，包含明文密钥，请妥善保管' : '，这次没有包含任何密钥'}。
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------- page */

export default function Storage() {
  const status = useLoad(() => featureApi.storage() as Promise<StorageStatus>);
  const maintenance = !!status.data?.maintenanceRunning;

  return (
    <div className="storage-root">
      <Page
        title="存储与备份"
        register="system"
        intro="她的聊天、记忆和媒体占了多少空间，怎么自动清理，以及备份和恢复。"
      >
        <Section title="占用" desc="媒体包括图片、语音、表情和文件，上限只针对媒体。">
          <Loadable state={status} label="存储状态">
            {(data) => <Usage data={data} reloading={status.loading} onReload={() => void status.reload()} />}
          </Loadable>
        </Section>

        <Section title="清理规则" desc="决定哪些文件算过期、备份留几份。改了之后，之前生成的清理预览会失效。">
          <Loadable state={status} label="清理规则">
            {(data) => <PolicyForm policy={data.policy} onSaved={() => void status.reload()} />}
          </Loadable>
        </Section>

        <Section title="手动清理" desc="先预览会删掉什么，勾选要清理的类别，确认后才会真正删除。">
          <Cleanup busyElsewhere={maintenance} onChanged={() => void status.reload()} />
        </Section>

        <Section title="备份" desc="备份的是数据库（聊天、记忆、设置等），媒体文件本身不在里面。">
          <Backups keep={status.data?.policy.backupKeep ?? 7} maintenance={maintenance} onChanged={() => void status.reload()} />
        </Section>

        <Section title="导出完整备份" desc="换设备或迁移到 IPA 版时用。">
          <FullExport />
        </Section>
      </Page>
    </div>
  );
}
