import { useEffect, useRef, useState } from 'react';
import { adminApi, type AdminSticker } from '../../../lib/admin.js';
import {
  Button, Callout, ConfirmButton, Empty, Facts, Field, Fields, Input, Loading, Section, Select, Switch, Tag, TextArea,
  errorMessage, fmtAgo, fmtTime, useAction, useConsole
} from '../../ui.js';
import { Layer } from './Layer.js';
import { FullMedia, PaidButton, Thumb, explain, useDebounced, usePaged, useSelection } from './shared.js';

const PAGE = 60;
const POLL_MS = 4000;
const POLL_LIMIT_MS = 3 * 60 * 1000;

export const EMOTION_LABELS: Record<string, string> = {
  neutral: '平静', happy: '开心', sad: '难过', angry: '生气', gentle: '温柔', sleepy: '困', confused: '疑惑',
  shy: '害羞', surprised: '惊讶', love: '喜欢', playful: '调皮', tired: '累'
};
export const emotionLabel = (value: string) => EMOTION_LABELS[value] ?? value;

const STATUS_LABELS: Record<string, string> = { pending: '等待分析', processing: '分析中', ready: '已分析', failed: '分析失败' };
const SOURCE_LABELS: Record<string, string> = { ai: 'AI 分析的', manual: '手动填写的', legacy: '旧数据' };
const SORT_OPTIONS = [
  { value: 'created', label: '最新添加的在前' },
  { value: 'recent', label: '最近用过的在前' },
  { value: 'usage', label: '用得最多的在前' },
  { value: 'name', label: '按名字' }
];

type Facets = { status: Record<string, number>; source: Record<string, number>; emotion: Record<string, number> };

function statusTone(status: AdminSticker['analysisStatus']): 'ok' | 'warn' | 'bad' | undefined {
  return status === 'failed' ? 'bad' : status === 'pending' || status === 'processing' ? 'warn' : undefined;
}

function withCount(label: string, count: number | undefined) {
  return count ? `${label}（${count}）` : label;
}

export function Stickers() {
  const { notify } = useConsole();
  const { run, busy } = useAction();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [emotion, setEmotion] = useState('');
  const [enabled, setEnabled] = useState('');
  const [sort, setSort] = useState<'created' | 'name' | 'recent' | 'usage'>('created');
  const term = useDebounced(search.trim());
  const [editing, setEditing] = useState<string | null>(null);

  const list = usePaged<AdminSticker>(async (offset, limit) => {
    const result = await adminApi.adminStickers({
      q: term || undefined, status: status || undefined, source: source || undefined, emotion: emotion || undefined,
      enabled: enabled === '' ? undefined : enabled === 'on', sort, limit, offset
    });
    return { items: result.stickers, total: result.total, extra: { facets: result.facets } };
  }, PAGE, [term, status, source, emotion, enabled, sort]);
  const facets = (list.extra.facets as Facets | undefined) ?? { status: {}, source: {}, emotion: {} };

  const pick = useSelection(list.items.map((item) => item.id));
  const filtered = Boolean(term || status || source || emotion || enabled);
  const clearFilters = () => { setSearch(''); setStatus(''); setSource(''); setEmotion(''); setEnabled(''); };

  // While anything on screen is still being analyzed, keep re-reading so the result shows up by itself.
  const working = list.items.some((item) => item.analysisStatus === 'pending' || item.analysisStatus === 'processing');
  const refreshRef = useRef(list.refresh);
  refreshRef.current = list.refresh;
  // Give up after a few minutes so a stuck job queue does not poll forever.
  const [pollTimedOut, setPollTimedOut] = useState(false);
  useEffect(() => {
    setPollTimedOut(false);
    if (!working) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > POLL_LIMIT_MS) { window.clearInterval(timer); setPollTimedOut(true); return; }
      if (!document.hidden) void refreshRef.current();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [working]);

  const emotionKeys = [...new Set([...Object.keys(facets.emotion), ...(emotion ? [emotion] : [])])];
  const index = editing ? list.items.findIndex((item) => item.id === editing) : -1;
  const current = index >= 0 ? list.items[index]! : null;

  const analyzeAll = () => run('analyze-all', async () => {
    const result = await explain(adminApi.analyzeStickerBatch({ mode: 'missing_or_stale' }));
    await list.refresh();
    return result;
  }).then((result) => {
    if (!result) return;
    notify(result.queued ? `已排队分析 ${result.queued} 个表情包${result.skipped ? `，${result.skipped} 个已经分析过或是手动填写的，跳过了` : ''}` : '没有需要分析的表情包', 'ok');
  });

  const analyzeSelected = () => run('analyze-selected', async () => {
    const result = await explain(adminApi.analyzeStickerBatch({ mode: 'selected', ids: pick.ids }));
    pick.clear();
    await list.refresh();
    return result;
  }).then((result) => {
    if (!result) return;
    notify(`已排队分析 ${result.queued} 个${result.skipped ? `，${result.skipped} 个是手动填写的，没有动` : ''}`, 'ok');
  });

  const setEnabledFor = (value: boolean) => run(value ? 'enable' : 'disable', async () => {
    let failed = 0;
    for (const id of pick.ids) {
      try { await adminApi.updateSticker(id, { enabled: value }); } catch { failed += 1; }
    }
    pick.clear();
    await list.refresh();
    return failed;
  }).then((failed) => {
    if (failed === undefined) return;
    notify(failed ? `有 ${failed} 个没改成功，刷新后再试` : value ? '已启用' : '已停用', failed ? 'bad' : 'ok');
  });

  return (
    <>
      <Section title="表情包库" desc="她会按聊天的情绪从这里挑表情包。AI 看过每张图后会写下画面内容和含义，她靠这些来选。" wide>
        <div data-no-dirty>
          <div className="media-filters">
            <Field label="搜索"><Input type="search" value={search} placeholder="名字、标签或含义" onChange={(e) => setSearch(e.target.value)} /></Field>
            <Field label="情绪">
              <Select value={emotion} onChange={(e) => setEmotion(e.target.value)} options={[
                { value: '', label: '全部情绪' },
                ...emotionKeys.map((key) => ({ value: key, label: withCount(emotionLabel(key), facets.emotion[key]) }))
              ]} />
            </Field>
            <Field label="分析状态">
              <Select value={status} onChange={(e) => setStatus(e.target.value)} options={[
                { value: '', label: '全部' },
                ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label: withCount(label, facets.status[value]) }))
              ]} />
            </Field>
            <Field label="含义来自">
              <Select value={source} onChange={(e) => setSource(e.target.value)} options={[
                { value: '', label: '全部' },
                ...Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label: withCount(label, facets.source[value]) }))
              ]} />
            </Field>
            <Field label="是否启用">
              <Select value={enabled} onChange={(e) => setEnabled(e.target.value)} options={[
                { value: '', label: '全部' }, { value: 'on', label: '只看启用的' }, { value: 'off', label: '只看停用的' }
              ]} />
            </Field>
            <Field label="排序"><Select value={sort} options={SORT_OPTIONS} onChange={(e) => setSort(e.target.value as typeof sort)} /></Field>
          </div>
        </div>
        <div className="cs-actions media-toolbar" data-no-dirty>
          <span className="cs-muted">
            {list.loading && !list.items.length ? '正在读取…' : `${filtered ? '符合条件的' : '共'} ${list.total} 个`}
            {working && (pollTimedOut ? '，有表情包几分钟了还没分析完，可能是后台任务堵住了，稍后点刷新看看' : '，有表情包正在分析，结果出来会自动刷新')}
          </span>
          <span className="media-toolbar-end">
            {filtered && <Button kind="text" size="sm" onClick={clearFilters}>清除筛选</Button>}
            <Button kind="text" size="sm" busy={list.loading} onClick={() => void list.refresh()}>刷新</Button>
            <PaidButton
              label="补齐 AI 分析（消耗额度）"
              question="让看图模型分析所有还没分析、分析失败或版本过旧的表情包，会消耗额度。手动填写过的不会动。"
              confirmLabel="开始分析"
              busy={busy === 'analyze-all'}
              onConfirm={analyzeAll}
            />
          </span>
        </div>

        {list.items.length > 0 && (
          <div className="cs-actions media-batch" data-active={pick.ids.length > 0 || undefined}>
            {pick.ids.length === 0 ? (
              <>
                <span className="cs-muted">勾选后可以一起分析、启用或停用。</span>
                <Button kind="text" size="sm" onClick={pick.all}>全选已显示的</Button>
              </>
            ) : (
              <>
                <strong>已选 {pick.ids.length} 个</strong>
                <PaidButton
                  label="重新分析（消耗额度）"
                  question={`让看图模型重新分析这 ${pick.ids.length} 个，会消耗额度。手动填写过的会跳过。`}
                  confirmLabel="开始分析"
                  busy={busy === 'analyze-selected'}
                  onConfirm={analyzeSelected}
                />
                <Button kind="quiet" size="sm" busy={busy === 'enable'} onClick={() => void setEnabledFor(true)}>启用</Button>
                <Button kind="quiet" size="sm" busy={busy === 'disable'} onClick={() => void setEnabledFor(false)}>停用</Button>
                <Button kind="text" size="sm" onClick={pick.clear}>取消选择</Button>
              </>
            )}
          </div>
        )}

        {list.error !== null && (
          <Callout tone="bad">表情包读取失败：{errorMessage(list.error)} <Button kind="text" size="sm" onClick={() => void list.reload()}>重试</Button></Callout>
        )}
        {list.items.length === 0 && list.loading && <Loading />}
        {list.items.length === 0 && !list.loading && list.error === null && (
          filtered
            ? <Empty action={<Button kind="quiet" size="sm" onClick={clearFilters}>清除筛选</Button>}>没有符合条件的表情包。</Empty>
            : <Empty action={<Button kind="quiet" size="sm" onClick={() => document.getElementById('media-sticker-upload')?.scrollIntoView({ behavior: 'smooth' })}>上传第一个表情包</Button>}>表情包库还是空的，她现在没有表情包可发。</Empty>
        )}

        {list.items.length > 0 && (
          <div className="cs-grid-media" data-no-dirty>
            {list.items.map((item) => (
              <div className="cs-media" key={item.id} data-selected={pick.selected.has(item.id) || undefined} data-off={item.enabled === false || undefined}>
                <div className="cs-media-frame" data-fit="contain">
                  <button type="button" className="media-open" aria-label={`编辑 ${item.name}`} onClick={() => setEditing(item.id)}>
                    {item.available === false ? <span className="media-thumb-word">文件丢失</span> : <Thumb path={item.url} kind="sticker" alt={item.name} fit="contain" />}
                  </button>
                  <input type="checkbox" className="cs-media-select" aria-label={`选择 ${item.name}`} checked={pick.selected.has(item.id)} onChange={() => pick.toggle(item.id)} />
                </div>
                <span className="cs-media-caption media-sticker-name">{item.name}</span>
                <span className="cs-actions media-sticker-tags">
                  <Tag>{emotionLabel(item.emotion)}</Tag>
                  {statusTone(item.analysisStatus) && <Tag tone={statusTone(item.analysisStatus)}>{STATUS_LABELS[item.analysisStatus ?? 'pending']}</Tag>}
                  {item.enabled === false && <Tag>已停用</Tag>}
                </span>
              </div>
            ))}
          </div>
        )}
        {list.hasMore && <div className="cs-actions"><Button kind="quiet" busy={list.loading} onClick={() => void list.loadMore()}>再加载 {PAGE} 个</Button></div>}
      </Section>

      <StickerUpload onDone={() => void list.reload()} emotions={emotionKeys} />

      {current && (
        <StickerEditor
          key={current.id}
          sticker={current}
          position={`${index + 1} / ${list.total}`}
          onClose={() => setEditing(null)}
          onPrev={index > 0 ? () => setEditing(list.items[index - 1]!.id) : undefined}
          onNext={index < list.items.length - 1 ? () => setEditing(list.items[index + 1]!.id) : undefined}
          onChanged={(removed) => {
            if (removed) setEditing(null);
            void list.refresh();
          }}
          emotions={emotionKeys}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------ upload */

function StickerUpload({ onDone, emotions }: { onDone: () => void; emotions: string[] }) {
  const { notify } = useConsole();
  const { run, busy } = useAction();
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState('');
  const [emotion, setEmotion] = useState('neutral');
  const [tags, setTags] = useState('');
  const [failed, setFailed] = useState<Array<{ filename: string; error: string }>>([]);
  const input = useRef<HTMLInputElement | null>(null);

  const upload = () => run('upload', async () => {
    const form = new FormData();
    // Fields must come before the files: the server reads them off each file part.
    if (files.length === 1 && name.trim()) form.append('name', name.trim());
    form.append('emotion', emotion.trim() || 'neutral');
    const tagText = tags.split(/[,，、\s]+/u).map((tag) => tag.trim()).filter(Boolean).join(',');
    if (tagText) form.append('tags', tagText);
    for (const file of files) form.append('file', file, file.name);
    try {
      return await adminApi.uploadSticker(form);
    } catch (error) {
      const body = (error as { body?: { failed?: Array<{ filename: string; error: string }> } }).body;
      if (body?.failed?.length) { setFailed(body.failed); throw new Error('一个都没有上传成功，看看下面的原因。'); }
      throw explainSync(error);
    }
  }).then((result) => {
    if (!result) return;
    setFailed(result.failed);
    notify(result.failed.length ? `上传了 ${result.created.length} 个，${result.failed.length} 个失败` : '表情包已上传', result.failed.length ? 'bad' : 'ok');
    setFiles([]);
    setName('');
    setTags('');
    if (input.current) input.current.value = '';
    onDone();
  });

  return (
    <Section id="media-sticker-upload" title="添加表情包" desc="可以一次选多张。上传后会自动让看图模型分析画面，这一步会消耗额度。">
      <div data-no-dirty>
        <Fields>
          <Field label="图片" full hint={files.length ? `已选 ${files.length} 张：${files.map((file) => file.name).join('、')}` : '支持 PNG、JPG、GIF、WebP。'}>
            <input ref={input} className="cs-input" type="file" accept="image/*" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
          </Field>
          <Field label="名字" hint={files.length > 1 ? '选了多张时，名字用各自的文件名。' : '留空就用文件名。'}>
            <Input value={name} disabled={files.length > 1} maxLength={60} placeholder="例如：捂脸笑" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="情绪" hint="她在这种情绪下更可能发它。可以自己写。">
            <Input value={emotion} list="media-emotion-list" maxLength={40} onChange={(e) => setEmotion(e.target.value)} />
          </Field>
          <Field label="标签" hint="用逗号隔开；留空就用情绪当标签。">
            <Input value={tags} placeholder="例如：得意，偷笑" onChange={(e) => setTags(e.target.value)} />
          </Field>
        </Fields>
        <EmotionList emotions={emotions} />
      </div>
      <div className="cs-actions">
        <PaidButton
          kind="primary"
          size="md"
          label={files.length > 1 ? `上传这 ${files.length} 张并分析（消耗额度）` : '上传并分析（消耗额度）'}
          question="上传后看图模型会自动分析每一张，会消耗额度。"
          confirmLabel="上传"
          disabled={files.length === 0}
          busy={busy === 'upload'}
          onConfirm={upload}
        />
      </div>
      {failed.length > 0 && (
        <Callout tone="bad">
          这些没有上传成功：
          <ul className="media-usage">{failed.map((item, at) => <li key={`${item.filename}-${at}`}>{item.filename}：{item.error}</li>)}</ul>
        </Callout>
      )}
    </Section>
  );
}

function explainSync(error: unknown): unknown {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

function EmotionList({ emotions }: { emotions: string[] }) {
  const all = [...new Set([...Object.keys(EMOTION_LABELS), ...emotions])];
  return <datalist id="media-emotion-list">{all.map((key) => <option key={key} value={key}>{emotionLabel(key)}</option>)}</datalist>;
}

/* ------------------------------------------------------------ editor */

interface Draft {
  name: string;
  emotion: string;
  tags: string;
  description: string;
  imageText: string;
  userMeaning: string;
  enabled: boolean;
}

function draftOf(sticker: AdminSticker): Draft {
  return {
    name: sticker.name,
    emotion: sticker.emotion,
    tags: sticker.tags.join('，'),
    description: sticker.description ?? '',
    imageText: sticker.imageText ?? '',
    userMeaning: sticker.userMeaning ?? '',
    enabled: sticker.enabled !== false
  };
}

const splitTags = (text: string) => [...new Set(text.split(/[,，、\s]+/u).map((tag) => tag.trim()).filter(Boolean))];

function StickerEditor({ sticker, position, onClose, onPrev, onNext, onChanged, emotions }: {
  sticker: AdminSticker;
  position: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onChanged: (removed?: boolean) => void;
  emotions: string[];
}) {
  const { markClean } = useConsole();
  const { run, busy } = useAction();
  const base = draftOf(sticker);
  const [draft, setDraft] = useState<Draft>(base);
  const [saved, setSaved] = useState<Draft>(base);
  const [leaving, setLeaving] = useState<null | (() => void)>(null);
  // A background refresh (analysis finished) updates fields the user has not touched.
  const baseKey = JSON.stringify(base);
  useEffect(() => {
    setDraft((old) => {
      const next = { ...old };
      for (const key of Object.keys(base) as Array<keyof Draft>) {
        if (JSON.stringify(old[key]) === JSON.stringify(saved[key])) (next as Record<string, unknown>)[key] = base[key];
      }
      return next;
    });
    setSaved(base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((old) => ({ ...old, [key]: value }));
  const changed = (Object.keys(draft) as Array<keyof Draft>).filter((key) =>
    key === 'tags' ? splitTags(draft.tags).join(',') !== splitTags(saved.tags).join(',') : draft[key] !== saved[key]);
  const semanticEdit = changed.some((key) => key === 'description' || key === 'imageText' || key === 'tags');
  const guard = (go: () => void) => () => { if (changed.length) setLeaving(() => go); else { markClean(); go(); } };

  const save = () => run('save', async () => {
    if (!draft.name.trim()) throw new Error('名字不能为空。');
    const patch: Parameters<typeof adminApi.updateSticker>[1] = {};
    if (changed.includes('name')) patch.name = draft.name.trim();
    if (changed.includes('emotion')) patch.emotion = draft.emotion.trim() || 'neutral';
    if (changed.includes('tags')) patch.tags = splitTags(draft.tags);
    if (changed.includes('description')) patch.description = draft.description.trim();
    if (changed.includes('imageText')) patch.imageText = draft.imageText.trim();
    if (changed.includes('userMeaning')) { patch.userMeaning = draft.userMeaning.trim(); patch.userMeaningSource = draft.userMeaning.trim() ? 'manual' : 'none'; }
    if (changed.includes('enabled')) patch.enabled = draft.enabled;
    await explain(adminApi.updateSticker(sticker.id, patch));
    markClean();
    onChanged();
    return true;
  }, '表情包已保存');

  const analyze = (force: boolean) => run('analyze', async () => {
    await explain(adminApi.analyzeSticker(sticker.id, force));
    onChanged();
  }, '已排队分析，结果出来会自动刷新');

  const remove = () => run('delete', async () => {
    await explain(adminApi.deleteSticker(sticker.id));
    markClean();
    onChanged(true);
  }, '表情包已删除');

  const manual = sticker.analysisSource === 'manual';
  const working = sticker.analysisStatus === 'pending' || sticker.analysisStatus === 'processing';

  return (
    <Layer
      title={sticker.name}
      position={position}
      onClose={guard(onClose)}
      onPrev={onPrev ? guard(onPrev) : undefined}
      onNext={onNext ? guard(onNext) : undefined}
      media={sticker.available === false ? <div className="media-full-word">图片文件丢失了，只剩记录。可以删掉重新上传。</div> : <FullMedia path={sticker.url} kind="sticker" mime={sticker.mime} alt={sticker.name} />}
    >
      {leaving && (
        <Callout tone="warn">
          改动还没保存。{' '}
          <span className="cs-actions" style={{ display: 'inline-flex' }}>
            <Button size="sm" busy={busy === 'save'} onClick={() => void save().then((ok) => { if (!ok) return; const go = leaving; setLeaving(null); go(); })}>保存表情包</Button>
            <Button kind="text" size="sm" onClick={() => { markClean(); const go = leaving; setLeaving(null); go(); }}>不保存</Button>
            <Button kind="text" size="sm" onClick={() => setLeaving(null)}>继续编辑</Button>
          </span>
        </Callout>
      )}
      {sticker.analysisStatus === 'failed' && (
        <Callout tone="bad">AI 分析失败{sticker.analysisError ? `：${sticker.analysisError}` : '。'}检查看图模型配置后可以重新分析，或者直接手动填写下面的含义。</Callout>
      )}
      {working && <Callout tone="warn">{sticker.analysisStatus === 'processing' ? 'AI 正在看这张图' : '排队等 AI 分析'}，完成后下面的内容会自动更新。</Callout>}

      <Facts items={[
        ['分析状态', STATUS_LABELS[sticker.analysisStatus ?? 'pending'] ?? '—'],
        ['含义来自', SOURCE_LABELS[sticker.analysisSource ?? 'legacy'] ?? '—'],
        ['她发过', `${sticker.assistantUseCount ?? sticker.useCount ?? 0} 次`],
        ['你发过', `${sticker.userUseCount ?? 0} 次`],
        ['她上次发', sticker.assistantLastUsedAt ? fmtAgo(sticker.assistantLastUsedAt) : '还没发过'],
        ['添加于', fmtTime(sticker.createdAt)]
      ]} />
      {!sticker.hasEmbedding && sticker.analysisStatus === 'ready' && <p className="cs-muted">还没有建好检索向量，她暂时只能靠名字和标签找到它。</p>}

      <Fields>
        <Field label="名字"><Input value={draft.name} maxLength={60} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="情绪"><Input value={draft.emotion} maxLength={40} list="media-emotion-list" onChange={(e) => set('emotion', e.target.value)} /></Field>
        <Field label="标签" full hint="用逗号隔开。"><Input value={draft.tags} onChange={(e) => set('tags', e.target.value)} /></Field>
        <Field label="画面内容" full hint={`她靠这段描述理解这张图。${draft.description.length}/500`}>
          <TextArea value={draft.description} maxLength={500} rows={3} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Field label="图里的字" full><Input value={draft.imageText} maxLength={300} placeholder="图上没有字就留空" onChange={(e) => set('imageText', e.target.value)} /></Field>
        <Field label="你们之间的用法" full hint={`比如“你发这个的时候一般是在撒娇”。${draft.userMeaning.length}/120`}>
          <TextArea voice="her" value={draft.userMeaning} maxLength={120} rows={2} onChange={(e) => set('userMeaning', e.target.value)} />
        </Field>
      </Fields>
      <EmotionList emotions={emotions} />
      <Switch checked={draft.enabled} onChange={(value) => set('enabled', value)} label={draft.enabled ? '启用，她可以发这个表情包' : '停用，她不会再发它'} />
      {semanticEdit && <p className="cs-muted">改了画面内容、图里的字或标签后，这些会记为手动填写，以后的批量 AI 分析不会覆盖。</p>}

      <div className="cs-actions">
        <Button busy={busy === 'save'} disabled={changed.length === 0} onClick={() => void save()}>保存表情包</Button>
        {changed.length > 0 && <Button kind="text" size="sm" onClick={() => { setDraft(saved); markClean(); }}>撤销改动</Button>}
      </div>
      <div className="cs-actions">
        <PaidButton
          label={manual ? '让 AI 重新分析（覆盖手动填写，消耗额度）' : 'AI 重新分析（消耗额度）'}
          question={manual ? '会用 AI 的结果覆盖你手动填写的画面内容和标签，并消耗看图模型额度。确定？' : '会调用看图模型分析这张图，消耗额度。'}
          confirmLabel="开始分析"
          busy={busy === 'analyze'}
          disabled={sticker.analysisStatus === 'processing'}
          onConfirm={() => analyze(manual)}
        />
        <ConfirmButton label="删除这个表情包" question="图片文件也会一起删掉。确定？" confirmLabel="删除" busy={busy === 'delete'} onConfirm={remove} />
      </div>
      <p className="cs-muted">在聊天里发过的表情包不能删，删了那些消息会变成裂图；不想让她再用，停用就好。</p>
    </Layer>
  );
}
