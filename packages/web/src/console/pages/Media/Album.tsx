import { useState } from 'react';
import { featureApi, type FeatureMedia } from '../../../lib/features.js';
import {
  Button, Callout, ConfirmButton, Empty, Field, Input, Loading, Section, Select, Switch, Tag, errorMessage, fmtBytes, fmtTime, useAction, useConsole
} from '../../ui.js';
import { MediaViewer } from './MediaViewer.js';
import { ORIGIN_LABELS, Thumb, batchSummary, downloadMedia, explain, useDebounced, usePaged, useSelection } from './shared.js';

const PAGE = 60;

const ORIGIN_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'generated', label: ORIGIN_LABELS.generated! },
  { value: 'remote', label: ORIGIN_LABELS.remote! },
  { value: 'upload', label: ORIGIN_LABELS.upload! },
  { value: 'builtin', label: ORIGIN_LABELS.builtin! }
];

/** Images only, via /api/admin/gallery: favorites, date range and total size live here. */
export function Album({ onShowAll }: { onShowAll: () => void }) {
  const { run, busy } = useAction();
  const { notify } = useConsole();
  const [search, setSearch] = useState('');
  const [origin, setOrigin] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [favorite, setFavorite] = useState(false);
  const term = useDebounced(search.trim());
  const [viewing, setViewing] = useState<string | null>(null);

  const list = usePaged<FeatureMedia>(async (offset, limit) => {
    const result = await featureApi.gallery({
      search: term || undefined,
      origin: origin || undefined,
      favorite: favorite || undefined,
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
      limit,
      offset
    });
    return { items: result.media, total: result.stats.count, extra: { bytes: result.stats.bytes, all: result.total } };
  }, PAGE, [term, origin, favorite, from, to]);

  const pick = useSelection(list.items.map((item) => item.id));
  const filtered = Boolean(term || origin || favorite || from || to);
  const index = viewing ? list.items.findIndex((item) => item.id === viewing) : -1;

  const batch = (action: 'favorite' | 'unfavorite' | 'trash', verb: string) => run(`batch-${action}`, async () => {
    const result = await explain(featureApi.batchMedia(pick.ids, action));
    pick.clear();
    await list.refresh();
    return batchSummary(verb, result);
  }).then((text) => { if (text) notify(text, 'ok'); });

  const downloadSelected = () => run('download', async () => {
    const chosen = list.items.filter((item) => pick.selected.has(item.id));
    for (const item of chosen) {
      await downloadMedia(item);
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
  }, '已开始下载');

  const next = index >= 0 && index < list.items.length - 1
    ? () => setViewing(list.items[index + 1]!.id)
    : index >= 0 && list.hasMore ? () => { void list.loadMore(); } : undefined;

  return (
    <Section title="她的相册" desc="聊天里出现过的图片：她画的、你发给她的、你上传的。点开可以看大图、改标签、看它被用在哪里。" wide>
      <div data-no-dirty>
        <div className="media-filters">
          <Field label="搜索"><Input type="search" value={search} placeholder="文件名、标签或聊天里的文字" onChange={(e) => setSearch(e.target.value)} /></Field>
          <Field label="来源"><Select value={origin} options={ORIGIN_OPTIONS} onChange={(e) => setOrigin(e.target.value)} /></Field>
          <Field label="从哪天"><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="到哪天"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      </div>
      <div className="cs-actions media-toolbar" data-no-dirty>
        <Switch checked={favorite} onChange={setFavorite} label="只看收藏" />
        <span className="cs-muted">
          {list.loading && !list.items.length ? '正在读取…' : `${filtered ? '符合条件的' : '共'} ${list.total} 张，占 ${fmtBytes(list.extra.bytes)}`}
        </span>
        <span className="media-toolbar-end">
          {filtered && <Button kind="text" size="sm" onClick={() => { setSearch(''); setOrigin(''); setFrom(''); setTo(''); setFavorite(false); }}>清除筛选</Button>}
          <Button kind="text" size="sm" busy={list.loading} onClick={() => void list.refresh()}>刷新</Button>
        </span>
      </div>

      {list.items.length > 0 && (
        <div className="cs-actions media-batch" data-active={pick.ids.length > 0 || undefined}>
          {pick.ids.length === 0 ? (
            <>
              <span className="cs-muted">勾选图片可以一起收藏、下载或移到回收站。</span>
              <Button kind="text" size="sm" onClick={pick.all}>全选已显示的</Button>
            </>
          ) : (
            <>
              <strong>已选 {pick.ids.length} 张</strong>
              <Button kind="quiet" size="sm" busy={busy === 'batch-favorite'} onClick={() => void batch('favorite', '已收藏')}>收藏</Button>
              <Button kind="quiet" size="sm" busy={busy === 'batch-unfavorite'} onClick={() => void batch('unfavorite', '已取消收藏')}>取消收藏</Button>
              <Button kind="quiet" size="sm" busy={busy === 'download'} onClick={() => void downloadSelected()}>下载</Button>
              <ConfirmButton label="移到回收站" question={`把这 ${pick.ids.length} 张移到回收站？被用到的会自动跳过。`} busy={busy === 'batch-trash'} onConfirm={() => batch('trash', '已移到回收站')} />
              <Button kind="text" size="sm" onClick={pick.clear}>取消选择</Button>
            </>
          )}
        </div>
      )}

      {list.error !== null && (
        <Callout tone="bad">相册读取失败：{errorMessage(list.error)} <Button kind="text" size="sm" onClick={() => void list.reload()}>重试</Button></Callout>
      )}
      {list.items.length === 0 && list.loading && <Loading />}
      {list.items.length === 0 && !list.loading && list.error === null && (
        filtered
          ? <Empty action={<Button kind="quiet" size="sm" onClick={() => { setSearch(''); setOrigin(''); setFrom(''); setTo(''); setFavorite(false); }}>清除筛选</Button>}>没有符合条件的图片。</Empty>
          : <Empty action={<Button kind="quiet" size="sm" onClick={onShowAll}>去看全部媒体</Button>}>相册还是空的。她在聊天里画图、或者你发图片给她之后，会出现在这里。</Empty>
      )}

      {list.items.length > 0 && (
        <div className="cs-grid-media" data-no-dirty>
          {list.items.map((item) => (
            <div className="cs-media" key={item.id} data-selected={pick.selected.has(item.id) || undefined}>
              <div className="cs-media-frame">
                <button type="button" className="media-open" aria-label={`查看 ${item.name ?? fmtTime(item.createdAt)}`} onClick={() => setViewing(item.id)}>
                  {item.exists ? <Thumb path={item.url} kind={item.kind} mime={item.mime} alt={item.name ?? '相册图片'} /> : <span className="media-thumb-word">文件丢失</span>}
                </button>
                <input type="checkbox" className="cs-media-select" aria-label="选择这张" checked={pick.selected.has(item.id)} onChange={() => pick.toggle(item.id)} />
              </div>
              <span className="cs-media-caption">
                {fmtTime(item.createdAt)}
                {item.favorite && <> <Tag tone="ok">收藏</Tag></>}
              </span>
            </div>
          ))}
        </div>
      )}
      {list.hasMore && (
        <div className="cs-actions"><Button kind="quiet" busy={list.loading} onClick={() => void list.loadMore()}>再加载 {PAGE} 张</Button></div>
      )}

      {viewing && (
        <MediaViewer
          id={viewing}
          position={index >= 0 ? `${index + 1} / ${list.total}` : undefined}
          onClose={() => setViewing(null)}
          onPrev={index > 0 ? () => setViewing(list.items[index - 1]!.id) : undefined}
          onNext={next}
          onChanged={(removed) => {
            if (removed) {
              const after = list.items[index + 1] ?? list.items[index - 1];
              setViewing(after && after.id !== viewing ? after.id : null);
            }
            void list.refresh();
          }}
        />
      )}
    </Section>
  );
}
