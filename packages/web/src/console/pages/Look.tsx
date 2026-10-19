import { adminApi } from '../../lib/admin.js';
import { featureApi } from '../../lib/features.js';
import { mediaThumbnailPath } from '../../lib/authenticatedMedia.js';
import { useAuthenticatedMedia } from '../../lib/useAuthenticatedMedia.js';
import { Button, Loadable, Page, Section, useAction, useLoad } from '../ui.js';
import './Look.css';

type AvatarSlot = 'assistant' | 'user';

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const AVATAR_CSS_WIDTH = 112;

/* ------------------------------------------------------------ file picker */

/** A button that opens the file chooser; the chosen file is handed over immediately. */
function FilePick({ label, name, busy, disabled, onFile }: {
  label: string; name?: string; busy?: boolean; disabled?: boolean; onFile: (file: File) => void;
}) {
  const off = disabled || busy;
  return (
    <label className="cs-btn look-pick" data-kind="quiet" data-size="sm" aria-busy={busy || undefined} aria-disabled={off || undefined}>
      <input type="file" className="cs-sr" accept={IMAGE_ACCEPT} disabled={off} aria-label={name ?? label}
        onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) onFile(file); }} />
      {busy ? '正在上传…' : label}
    </label>
  );
}

/* ---------------------------------------------------------------- avatars */

function isDefaultAvatar(url: string | undefined): boolean {
  return !url || url.startsWith('/avatars/');
}

function AvatarSlotView({ slot, title, url, busy, onUpload }: {
  slot: AvatarSlot; title: string; url: string; busy: boolean; onUpload: (slot: AvatarSlot, file: File) => void;
}) {
  const media = useAuthenticatedMedia(url ? mediaThumbnailPath(url, AVATAR_CSS_WIDTH) : null, 'admin', 'image');
  return (
    <div className="look-avatar">
      <div className="look-avatar-frame">
        {media.url ? <img src={media.url} alt={title} />
          : <span className="look-avatar-empty">{media.loading ? '读取中' : media.error ? '读不出来' : '没有头像'}</span>}
      </div>
      <div className="look-avatar-info">
        <span className="look-avatar-title">{title}</span>
        <span className="cs-muted">{isDefaultAvatar(url) ? '现在用的是默认头像' : '已换成你上传的图片'}</span>
        {media.error && (
          <span className="cs-muted">
            预览没加载出来：{media.error}
            {media.retriable && <> <Button kind="text" size="sm" onClick={media.retry}>重新加载</Button></>}
          </span>
        )}
        <FilePick label={isDefaultAvatar(url) ? '上传头像' : '换一张'} name={`上传${title}`} busy={busy} onFile={(file) => onUpload(slot, file)} />
      </div>
    </div>
  );
}

/* ================================================================== page */

export default function Look() {
  const { run, busy } = useAction();
  const persona = useLoad(() => adminApi.persona().then((r) => r.persona), []);

  const uploadAvatar = async (slot: AvatarSlot, file: File) => {
    const label = slot === 'assistant' ? '她的头像' : '你的头像';
    const result = await run(`avatar-${slot}`, () => featureApi.uploadAvatar(slot, file), `${label}已更新`);
    if (result) persona.setData((old) => old && ({ ...old, avatar: result.persona.avatar, userAvatar: result.persona.userAvatar }));
  };

  return (
    <Page title="形象" register="her" intro="聊天里你们俩的头像。">
      <Section title="头像" desc="选好图片就会立刻上传，聊天窗口马上换上新头像。旧头像如果没有别处在用，会移到回收站。">
        <Loadable state={persona} label="头像">
          {(p) => (
            <div className="look-avatars">
              <AvatarSlotView slot="assistant" title="她的头像" url={p.avatar} busy={busy === 'avatar-assistant'} onUpload={(s, f) => void uploadAvatar(s, f)} />
              <AvatarSlotView slot="user" title="你的头像" url={p.userAvatar} busy={busy === 'avatar-user'} onUpload={(s, f) => void uploadAvatar(s, f)} />
            </div>
          )}
        </Loadable>
      </Section>
    </Page>
  );
}
