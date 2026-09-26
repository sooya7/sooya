import { useState, type FormEvent, type ReactNode } from 'react';
import { adminApi, type AdminChatMessage } from '../../lib/admin.js';
import { ApiError } from '../../lib/api.js';
import { mediaThumbnailPath } from '../../lib/authenticatedMedia.js';
import { useAuthenticatedMedia } from '../../lib/useAuthenticatedMedia.js';
import { consolePath } from '../routes.js';
import {
  Button, Callout, ConfirmButton, Empty, Field, Input, Loadable, Page, Section, Select, Tag,
  errorMessage, fmtTime, useAction, useConsole, useLoad
} from '../ui.js';
import './Chats.css';

/* ---------------------------------------------------------------- types */

type Role = '' | 'user' | 'assistant';
type Attachment = '' | 'with' | 'without' | 'image' | 'audio' | 'sticker' | 'file';

interface Filters { q: string; from: string; to: string; role: Role; attachment: Attachment }

const NO_FILTERS: Filters = { q: '', from: '', to: '', role: '', attachment: '' };

type Part = AdminChatMessage['content'][number] & {
  duration?: number | null;
  status?: string;
  media?: (NonNullable<AdminChatMessage['content'][number]['media']> & { name?: string | null; transcript?: string | null }) | null;
};

const MEDIA_WORD: Record<string, string> = { image: '图片', audio: '语音', sticker: '表情', file: '文件' };

const ATTACHMENT_OPTIONS: Array<{ value: Attachment; label: string }> = [
  { value: '', label: '全部消息' },
  { value: 'with', label: '带图片、语音或文件的' },
  { value: 'without', label: '只有文字的' },
  { value: 'image', label: '带图片的' },
  { value: 'audio', label: '带语音的' },
  { value: 'sticker', label: '带表情的' },
  { value: 'file', label: '带文件的' }
];

const PAGE_SIZES = [20, 40, 100];

/** yyyy-mm-dd from a date input → ISO bound in the viewer's own timezone. */
function dayBound(day: string, end: boolean): string | undefined {
  if (!day) return undefined;
  const date = new Date(`${day}T${end ? '23:59:59.999' : '00:00:00'}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function hasFilters(f: Filters): boolean {
  return Boolean(f.q || f.from || f.to || f.role || f.attachment);
}

/* ------------------------------------------------------------- pieces */

function Highlight({ text, term }: { text: string; term: string }) {
  const needle = term.trim();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const out: ReactNode[] = [];
  let at = 0;
  let hit = lower.indexOf(target);
  while (hit !== -1 && out.length < 40) {
    if (hit > at) out.push(text.slice(at, hit));
    out.push(<mark key={hit}>{text.slice(hit, hit + needle.length)}</mark>);
    at = hit + needle.length;
    hit = lower.indexOf(target, at);
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

function ChatImage({ url, alt }: { url: string; alt: string }) {
  const { url: src, error, retriable, retry } = useAuthenticatedMedia(mediaThumbnailPath(url, 112), 'admin', 'image');
  return (
    <span className="chat-thumb">
      {src ? <img src={src} alt={alt} loading="lazy" />
        : error ? <span className="chat-thumb-note">图片没加载出来{retriable && <Button kind="text" size="sm" onClick={retry}>重新加载</Button>}</span>
          : null}
    </span>
  );
}

function ChatAudio({ url }: { url: string }) {
  const { url: src, error } = useAuthenticatedMedia(url, 'admin', 'audio');
  if (error) return <span className="cs-muted">语音不可用：{error}</span>;
  if (!src) return <span className="cs-muted">正在读取语音…</span>;
  return <audio className="chat-audio" src={src} controls />;
}

function AudioPart({ part }: { part: Part }) {
  const [playing, setPlaying] = useState(false);
  const transcript = part.transcript ?? part.media?.transcript;
  return (
    <span className="chat-part-media">
      <span className="chat-part-row">
        <Tag>语音{part.duration ? ` ${Math.round(part.duration)} 秒` : ''}</Tag>
        {part.media?.url && !playing && <Button kind="text" size="sm" onClick={() => setPlaying(true)}>播放语音</Button>}
      </span>
      {playing && part.media?.url && <ChatAudio url={part.media.url} />}
      {transcript && <span className="chat-transcript">「{transcript}」</span>}
    </span>
  );
}

function MessageBody({ message, term }: { message: AdminChatMessage; term: string }) {
  const parts = (message.content as Part[]).filter((part) => part.type !== 'system');
  if (parts.length === 0) return <p className="chat-text cs-muted">（空消息）</p>;
  return (
    <div className="chat-body">
      {parts.map((part) => {
        if (part.type === 'text') {
          return part.text ? <p key={part.id} className="chat-text"><Highlight text={part.text} term={term} /></p> : null;
        }
        if (part.type === 'audio') return <AudioPart key={part.id} part={part} />;
        const kind = part.media?.kind ?? part.type;
        if ((kind === 'image' || kind === 'sticker') && part.media?.url) {
          return (
            <span key={part.id} className="chat-part-media">
              <ChatImage url={part.media.url} alt={MEDIA_WORD[kind] ?? '图片'} />
              {kind === 'sticker' && <Tag>表情</Tag>}
            </span>
          );
        }
        return (
          <span key={part.id} className="chat-part-row">
            <Tag>{MEDIA_WORD[kind] ?? kind}</Tag>
            {part.media?.name && <span className="cs-muted">{part.media.name}</span>}
            {!part.media && <span className="cs-muted">文件已经不在了</span>}
          </span>
        );
      })}
    </div>
  );
}

function MessageHead({ message }: { message: AdminChatMessage }) {
  return (
    <span className="chat-head">
      <span className="chat-who">{message.role === 'user' ? '你' : '她'}</span>
      <span className="cs-list-meta" title={fmtTime(message.createdAt, true)}>{fmtTime(message.createdAt)}</span>
      {message.status === 'failed' && <Tag tone="bad">没有发出去</Tag>}
      {(message.status === 'pending' || message.status === 'sending') && <Tag tone="warn">还在发送</Tag>}
    </span>
  );
}

/* ================================================================ page */

export default function Chats() {
  const { navigate } = useConsole();
  const { run, busy } = useAction();
  const [draftQ, setDraftQ] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(40);
  const [open, setOpen] = useState<string | null>(null);

  const rangeError = filters.from && filters.to && filters.from > filters.to ? '开始日期晚于结束日期，这两个条件先不生效。' : null;

  const history = useLoad(() => adminApi.chatHistory({
    q: filters.q || undefined,
    from: rangeError ? undefined : dayBound(filters.from, false),
    to: rangeError ? undefined : dayBound(filters.to, true),
    role: filters.role || undefined,
    hasMedia: filters.attachment === 'with' ? true : filters.attachment === 'without' ? false : undefined,
    mediaKind: ['image', 'audio', 'sticker', 'file'].includes(filters.attachment) ? filters.attachment : undefined,
    limit,
    offset
  }), [filters.q, filters.from, filters.to, filters.role, filters.attachment, rangeError, limit, offset]);

  const update = (patch: Partial<Filters>) => {
    setFilters((old) => ({ ...old, ...patch }));
    setOffset(0);
    setOpen(null);
  };
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    update({ q: draftQ.trim() });
  };
  const resetFilters = () => {
    setDraftQ('');
    setFilters(NO_FILTERS);
    setOffset(0);
    setOpen(null);
  };
  const goPage = (next: number) => {
    setOffset(next);
    setOpen(null);
    document.getElementById('chat-list')?.scrollIntoView({ block: 'start' });
  };

  const clear = async () => {
    const done = await run('clear', () => adminApi.clearChat(), '聊天记录已清空');
    if (done === undefined) return;
    resetFilters();
    await history.reload();
  };

  const filtered = hasFilters(filters);

  return (
    <Page title="聊天记录" register="her" intro="你和她在 QQ 上的全部对话。可以按内容、日期和谁说的来找，点开一条看前后聊了什么。">
      <Section title="找一段对话" desc="关键词也会搜语音转出的文字和图片里认出的字。">
        <form className="chat-filters" onSubmit={submitSearch} data-no-dirty>
          <div className="chat-search">
            <Field label="关键词">
              <Input type="search" value={draftQ} maxLength={200} placeholder="比如：生日" onChange={(e) => setDraftQ(e.target.value)} />
            </Field>
            <Button type="submit" busy={history.loading && Boolean(filters.q)}>搜索</Button>
          </div>
          <div className="chat-filter-row">
            <Field label="从哪天">
              <Input type="date" value={filters.from} onChange={(e) => update({ from: e.target.value })} />
            </Field>
            <Field label="到哪天" error={rangeError}>
              <Input type="date" value={filters.to} onChange={(e) => update({ to: e.target.value })} />
            </Field>
            <Field label="谁说的">
              <Select
                value={filters.role}
                onChange={(e) => update({ role: e.target.value as Role })}
                options={[{ value: '', label: '你和她' }, { value: 'user', label: '只看你说的' }, { value: 'assistant', label: '只看她说的' }]}
              />
            </Field>
            <Field label="附件">
              <Select value={filters.attachment} onChange={(e) => update({ attachment: e.target.value as Attachment })} options={ATTACHMENT_OPTIONS} />
            </Field>
          </div>
          {(filtered || draftQ) && (
            <div className="cs-actions">
              <Button kind="text" size="sm" onClick={resetFilters}>清除筛选</Button>
            </div>
          )}
        </form>
      </Section>

      <Section title="对话" desc="最新的在最上面。" wide id="chat-list">
        <Loadable state={history} label="聊天记录">
          {({ messages, total }) => (
            <>
              <div className="cs-actions chat-summary" data-no-dirty>
                <span className="cs-muted">
                  {total === 0 ? '' : filtered ? `找到 ${total.toLocaleString()} 条` : `一共 ${total.toLocaleString()} 条`}
                  {total > 0 && messages.length > 0 && `，这是第 ${(offset + 1).toLocaleString()}–${(offset + messages.length).toLocaleString()} 条`}
                </span>
                <Button kind="text" size="sm" busy={history.loading} onClick={() => void history.reload()}>刷新</Button>
              </div>
              {messages.length === 0 ? (
                offset > 0
                  ? <Empty action={<Button kind="quiet" size="sm" onClick={() => goPage(0)}>回到第一页</Button>}>这一页没有消息了。</Empty>
                  : filtered
                    ? <Empty action={<Button kind="quiet" size="sm" onClick={resetFilters}>清除筛选</Button>}>没有符合条件的消息，换个关键词或放宽日期试试。</Empty>
                    : <Empty>还没有聊天记录。她在 QQ 上和你聊过之后，这里就会出现。</Empty>
              ) : (
                <ol className="cs-list chat-list">
                  {messages.map((message) => (
                    <li key={message.id} className="cs-list-item chat-item" data-role={message.role} data-open={open === message.id || undefined}>
                      <MessageHead message={message} />
                      <span className="cs-list-side">
                        <Button kind="text" size="sm" aria-expanded={open === message.id} onClick={() => setOpen(open === message.id ? null : message.id)}>
                          {open === message.id ? '收起前后文' : '看前后文'}
                        </Button>
                      </span>
                      <MessageBody message={message} term={filters.q} />
                      {open === message.id && <ChatContext id={message.id} term={filters.q} onClose={() => setOpen(null)} />}
                    </li>
                  ))}
                </ol>
              )}
              <Pager offset={offset} limit={limit} count={messages.length} total={total} onPage={goPage} onLimit={(n) => { setLimit(n); setOffset(0); setOpen(null); }} />
            </>
          )}
        </Loadable>
      </Section>

      <Section title="清空聊天记录" desc="删掉你们之间的全部消息。她记住的事（记忆）不会被删，但她会不记得最近聊到了哪里。删了不能恢复，建议先备份。">
        <div className="cs-actions">
          <ConfirmButton
            label="清空聊天记录"
            question={history.data && !filtered ? `确定清空全部 ${history.data.total.toLocaleString()} 条聊天记录？删了不能恢复。` : '确定清空全部聊天记录？删了不能恢复。'}
            confirmLabel="确定清空"
            busy={busy === 'clear'}
            onConfirm={clear}
          />
          <Button kind="text" size="sm" onClick={() => navigate(consolePath('storage'))}>先去备份</Button>
        </div>
      </Section>
    </Page>
  );
}

function Pager({ offset, limit, count, total, onPage, onLimit }: {
  offset: number; limit: number; count: number; total: number; onPage: (offset: number) => void; onLimit: (limit: number) => void;
}) {
  if (total === 0) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="chat-pager" data-no-dirty>
      <div className="cs-actions">
        <Button kind="quiet" size="sm" disabled={offset === 0} onClick={() => onPage(0)}>最新</Button>
        <Button kind="quiet" size="sm" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>更新的</Button>
        <span className="cs-muted cs-nowrap">第 {page} / {pages} 页</span>
        <Button kind="quiet" size="sm" disabled={offset + count >= total} onClick={() => onPage(offset + limit)}>更早的</Button>
        <Button kind="quiet" size="sm" disabled={offset + count >= total} onClick={() => onPage((pages - 1) * limit)}>最早</Button>
      </div>
      <label className="chat-page-size">
        <span className="cs-muted">每页</span>
        <Select value={String(limit)} onChange={(e) => onLimit(Number(e.target.value))} options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} 条` }))} />
      </label>
    </div>
  );
}

/* ------------------------------------------------------------- context */

const CONTEXT_STEP = 10;
const CONTEXT_MAX = 50;

function ChatContext({ id, term, onClose }: { id: string; term: string; onClose: () => void }) {
  const [before, setBefore] = useState(5);
  const [after, setAfter] = useState(5);
  const context = useLoad(() => adminApi.chatContext(id, before, after), [id, before, after]);

  if (context.error && context.error instanceof ApiError && context.error.status === 404) {
    return (
      <div className="chat-context">
        <Empty action={<Button kind="text" size="sm" onClick={onClose}>收起</Button>}>这条消息已经不在了，可能聊天记录刚被清空过。刷新一下列表。</Empty>
      </div>
    );
  }

  return (
    <div className="chat-context" data-no-dirty>
      <Loadable state={context} label="前后文">
        {({ messages, hasOlder, hasNewer }) => {
          const ordered = [...messages].sort((a, b) => a.seq - b.seq);
          return (
            <>
              {hasOlder && (before < CONTEXT_MAX
                ? <Button kind="text" size="sm" busy={context.loading} onClick={() => setBefore((n) => Math.min(CONTEXT_MAX, n + CONTEXT_STEP))}>往前多看 {Math.min(CONTEXT_STEP, CONTEXT_MAX - before)} 条</Button>
                : <p className="cs-muted">最多往前看 {CONTEXT_MAX} 条。想看更早的，用上面的日期筛选。</p>)}
              {!hasOlder && <p className="cs-muted">前面没有更早的消息了。</p>}
              <ol className="chat-context-list">
                {ordered.map((message) => (
                  <li key={message.id} className="chat-context-item" data-role={message.role} data-target={message.id === id || undefined}>
                    <MessageHead message={message} />
                    <MessageBody message={message} term={message.id === id ? term : ''} />
                  </li>
                ))}
              </ol>
              {hasNewer && (after < CONTEXT_MAX
                ? <Button kind="text" size="sm" busy={context.loading} onClick={() => setAfter((n) => Math.min(CONTEXT_MAX, n + CONTEXT_STEP))}>往后多看 {Math.min(CONTEXT_STEP, CONTEXT_MAX - after)} 条</Button>
                : <p className="cs-muted">最多往后看 {CONTEXT_MAX} 条。</p>)}
              {!hasNewer && <p className="cs-muted">这是最新的一条了。</p>}
              {context.error !== null && context.data && <Callout tone="bad">没有读到更多：{errorMessage(context.error)}</Callout>}
            </>
          );
        }}
      </Loadable>
    </div>
  );
}
