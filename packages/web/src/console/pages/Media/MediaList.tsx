import { useState } from 'react';
import { adminApi, type AdminMedia } from '../../../lib/admin.js';
import { featureApi } from '../../../lib/features.js';
import {
  Button, Callout, ConfirmButton, Empty, Field, Input, Loading, Section, Select, Tag, errorMessage, fmtAgo, fmtBytes, fmtTime, useAction, useConsole
} from '../../ui.js';
import { MediaViewer } from './MediaViewer.js';
import { ORIGIN_LABELS, Thumb, batchSummary, explain, kindLabel, useDebounced, usePaged, useSelection } from './shared.js';

const PAGE = 40;

const KIND_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'image', label: '图片' },
  { value: 'audio', label: '语音' },
  { value: 'sticker', label: '表情包' },
  { value: 'file', label: '文件和视频' }
];
const ORIGIN_OPTIONS = [
  { value: '', label: '全部来源' },
  ...Object.entries(ORIGIN_LABELS).map(([value, label]) => ({ value, label }))
];
const SORT_OPTIONS = [
  { value: 'created', label: '最新的在前' },
  { value: 'size', label: '最占地方的在前' },
  { value: 'usage', label: '用得最多的在前' }
];

function usageText(item: AdminMedia): string {
  const refs = item.references ?? {};
  const messages = Number(refs.messageParts ?? 0);
  if (messages > 0) return `聊天里用过 ${messages} 次`;
  if (Number(refs.stickers ?? 0) > 0) return '是表情包';
  if (Number(refs.moments ?? 0) > 0) return '在她的动态里';
  if (item.avatar) return '正在当头像';
  return `被用到 ${item.usageCount ?? 0} 处`;
}

type BatchAction = 'favorite' | 'unfavorite' | 'trash' | 'restore' | 'permanent';
const BATCH_VERBS: Record<BatchAction, string> = {
  favorite: '已收藏', unfavorite: '已取消收藏', trash: '已移到回收站', restore: '已恢复', permanent: '已彻底删除'
};

/**
 * Every kind of media via /api/admin/media. `trashed` turns it into the recycle bin:
 * the same list, with restore and permanent delete instead of trash.
 */
export function MediaList({ mode, onEmptyAction }: { mode: 'active' | 'trashed'; onEmptyAction?: () => void }) {
  const trashed = mode === 'trashed';
  const { notify } = useConsole();
  const { run, busy } = useAction();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [origin, setOrigin] = useState('');
  const [sort, setSort] = useState<'created' | 'size' | 'usage'>('created');
  const term = useDebounced(search.trim());
  const [viewing, setViewing] = useState<string | null>(null);

  const list = usePaged<AdminMedia>(async (offset, limit) => {
    const result = await adminApi.adminMedia({ q: term || undefined, kind: kind || undefined, origin: origin || undefined, state: mode, sort, limit, offset });
    return { items: result.media, total: result.total };
  }, PAGE, [term, kind, origin, sort, mode]);

  const pick = useSelection(list.items.map((item) => item.id));
  const filtered = Boolean(term || kind || origin);
  const clearFilters = () => { setSearch(''); setKind(''); setOrigin(''); };
  const index = viewing ? list.items.findIndex((item) => item.id === viewing) : -1;

  const batch = (action: BatchAction, ids = pick.ids) => run(`batch-${action}`, async () => {
    const result = await explain(featureApi.batchMedia(ids, action));
    pick.clear();
    await list.refresh();
    return batchSummary(BATCH_VERBS[action], result);
  }).then((text) => { if (text) notify(text, 'ok'); });

  // Single-row trash uses the older DELETE endpoint, which is the same reversible move.
  const trashOne = (item: AdminMedia) => run(`trash-${item.id}`, async () => {
    await explain(adminApi.deleteMedia(item.id));
    await list.refresh();
  }, '已移到回收站');
  const restoreOne = (item: AdminMedia) => run(`restore-${item.id}`, async () => {
    await explain(featureApi.restoreMedia(item.id));
    await list.refresh();
  }, '已恢复');
  const destroyOne = (item: AdminMedia) => run(`destroy-${item.id}`, async () => {
    await explain(featureApi.deleteMedia(item.id));
    await list.refresh();
  }, '已彻底删除');

  const title = trashed ? '回收站' : '全部媒体';
  const desc = trashed
    ? '移到回收站的文件还占着空间，恢复后回到原处。彻底删除会把文件从硬盘上删掉，不能找回。'
    : '图片、语音、表情包和文件都在这里。被聊天记录、表情包或头像用到的文件不能移走。';

  return (
    <Section title={title} desc={desc} wide>
      <div data-no-dirty>
        <div className="media-filters">
          <Field label="搜索"><Input type="search" value={search} placeholder="文件名、标签或聊天里的文字" onChange={(e) => setSearch(e.target.value)} /></Field>
          <Field label="类型"><Select value={kind} options={KIND_OPTIONS} onChange={(e) => setKind(e.target.value)} /></Field>
          <Field label="来源"><Select value={origin} options={ORIGIN_OPTIONS} onChange={(e) => setOrigin(e.target.value)} /></Field>
          <Field label="排序"><Select value={sort} options={SORT_OPTIONS} onChange={(e) => setSort(e.target.value as typeof sort)} /></Field>
        </div>
      </div>
      <div className="cs-actions media-toolbar" data-no-dirty>
        <span className="cs-muted">{list.loading && !list.items.length ? '正在读取…' : `${filtered ? '符合条件的' : trashed ? '回收站里有' : '共'} ${list.total} 个`}</span>
        <span className="media-toolbar-end">
          {filtered && <Button kind="text" size="sm" onClick={clearFilters}>清除筛选</Button>}
          <Button kind="text" size="sm" busy={list.loading} onClick={() => void list.refresh()}>刷新</Button>
        </span>
      </div>

      {list.items.length > 0 && (
        <div className="cs-actions media-batch" data-active={pick.ids.length > 0 || undefined}>
          {pick.ids.length === 0 ? (
            <>
              <span className="cs-muted">{trashed ? '勾选后可以一起恢复或彻底删除。' : '勾选后可以一起收藏或移到回收站。'}</span>
              <Button kind="text" size="sm" onClick={pick.all}>全选已显示的</Button>
            </>
          ) : (
            <>
              <strong>已选 {pick.ids.length} 个</strong>
              {trashed ? (
                <>
                  <ConfirmButton label="恢复" question={`把这 ${pick.ids.length} 个放回原处？`} busy={busy === 'batch-restore'} onConfirm={() => batch('restore')} />
                  <ConfirmButton label="彻底删除" question={`彻底删除这 ${pick.ids.length} 个？不能找回，被用到的会自动跳过。`} busy={busy === 'batch-permanent'} onConfirm={() => batch('permanent')} />
                </>
              ) : (
                <>
                  <Button kind="quiet" size="sm" busy={busy === 'batch-favorite'} onClick={() => void batch('favorite')}>收藏</Button>
                  <Button kind="quiet" size="sm" busy={busy === 'batch-unfavorite'} onClick={() => void batch('unfavorite')}>取消收藏</Button>
                  <ConfirmButton label="移到回收站" question={`把这 ${pick.ids.length} 个移到回收站？被用到的会自动跳过。`} busy={busy === 'batch-trash'} onConfirm={() => batch('trash')} />
                </>
              )}
              <Button kind="text" size="sm" onClick={pick.clear}>取消选择</Button>
            </>
          )}
        </div>
      )}

      {list.error !== null && (
        <Callout tone="bad">{title}读取失败：{errorMessage(list.error)} <Button kind="text" size="sm" onClick={() => void list.reload()}>重试</Button></Callout>
      )}
      {list.items.length === 0 && list.loading && <Loading />}
      {list.items.length === 0 && !list.loading && list.error === null && (
        filtered
          ? <Empty action={<Button kind="quiet" size="sm" onClick={clearFilters}>清除筛选</Button>}>没有符合条件的文件。</Empty>
          : trashed
            ? <Empty action={onEmptyAction && <Button kind="quiet" size="sm" onClick={onEmptyAction}>回到相册</Button>}>回收站是空的。</Empty>
            : <Empty>还没有任何媒体文件。她在聊天里发图、发语音，或者你上传表情包之后，这里就会有东西。</Empty>
      )}

      {list.items.length > 0 && (
        <ul className="media-rows" data-no-dirty>
          {list.items.map((item) => {
            const used = Number(item.usageCount ?? 0) > 0 || Boolean(item.avatar);
            const name = item.name || `${kindLabel(item.kind, item.mime)} ${item.id.slice(-8)}`;
            return (
              <li className="media-row" key={item.id} data-selected={pick.selected.has(item.id) || undefined}>
                <input type="checkbox" className="media-row-check" aria-label={`选择 ${name}`} checked={pick.selected.has(item.id)} onChange={() => pick.toggle(item.id)} />
                <button type="button" className="media-row-thumb" aria-label={`查看 ${name}`} onClick={() => setViewing(item.id)}>
                  {item.exists ? <Thumb path={item.url} kind={item.kind} mime={item.mime} alt={name} width={80} /> : <span className="media-thumb-word">丢失</span>}
                </button>
                <div className="media-row-text">
                  <button type="button" className="media-row-name" onClick={() => setViewing(item.id)}>{name}</button>
                  <span className="cs-list-meta">
                    {kindLabel(item.kind, item.mime)}，{ORIGIN_LABELS[item.origin] ?? item.origin}，{fmtBytes(item.bytes)}，
                    {trashed && item.deletedAt ? `${fmtAgo(item.deletedAt)}移进回收站` : fmtTime(item.createdAt)}
                  </span>
                  <span className="cs-actions media-row-tags">
                    {used && <Tag tone="warn">{usageText(item)}</Tag>}
                    {item.favorite && <Tag tone="ok">收藏</Tag>}
                    {!item.exists && <Tag tone="bad">文件丢失</Tag>}
                  </span>
                </div>
                <div className="media-row-side">
                  {trashed ? (
                    <>
                      <ConfirmButton label="恢复" question="放回原处？" busy={busy === `restore-${item.id}`} onConfirm={() => restoreOne(item)} />
                      <ConfirmButton label="彻底删除" question="不能找回，确定？" busy={busy === `destroy-${item.id}`} disabled={used} onConfirm={() => destroyOne(item)} />
                    </>
                  ) : (
                    <ConfirmButton label="移到回收站" question="移到回收站？" busy={busy === `trash-${item.id}`} disabled={used} onConfirm={() => trashOne(item)} />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {list.hasMore && <div className="cs-actions"><Button kind="quiet" busy={list.loading} onClick={() => void list.loadMore()}>再加载 {PAGE} 个</Button></div>}

      {viewing && (
        <MediaViewer
          id={viewing}
          position={index >= 0 ? `${index + 1} / ${list.total}` : undefined}
          onClose={() => setViewing(null)}
          onPrev={index > 0 ? () => setViewing(list.items[index - 1]!.id) : undefined}
          onNext={index >= 0 && index < list.items.length - 1 ? () => setViewing(list.items[index + 1]!.id) : undefined}
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
