import { useEffect, useState, type FormEvent } from 'react';
import { featureApi, type LifeSettings } from '../../lib/features.js';
import { contactBoundaryPayload } from '../../lib/lifeObservation.js';

interface LifeContactBoundaryFormProps {
  initial: LifeSettings;
  onNotice: (message: string) => void;
}

function visibleMode(value: LifeSettings['proactiveMode']): 'auto' | 'text' | 'image' {
  if (value === 'image') return 'image';
  if (value === 'auto' || value === undefined) return 'auto';
  return 'text';
}

export function LifeContactBoundaryForm({ initial, onNotice }: LifeContactBoundaryFormProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LifeSettings>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(initial);
  }, [dirty, initial]);

  const change = (patch: Partial<LifeSettings>) => {
    setDraft((value) => ({ ...value, ...patch }));
    setDirty(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await featureApi.updateLifeSettings(contactBoundaryPayload(draft));
      setDraft(result.settings);
      setDirty(false);
      onNotice('动态设置已保存');
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="life-disclosure life-boundaries" data-testid="life-boundaries">
      <button
        type="button"
        className="life-disclosure-toggle"
        aria-expanded={open}
        aria-controls="life-boundaries-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <span><strong>动态发布</strong><small>决定她什么时候记录和分享生活动态</small></span>
        <span aria-hidden="true">{open ? '−' : '＋'}</span>
      </button>
      {open && (
        <form id="life-boundaries-panel" className="life-boundary-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>允许发动态</span>
            <input name="reachOut" type="checkbox" checked={draft.reachOut} onChange={(event) => change({ reachOut: event.target.checked })} />
          </label>
          <label>
            <span>动态最小间隔（分钟）</span>
            <input name="quietGapMinutes" type="number" min={5} max={1440} value={draft.quietGapMinutes} onChange={(event) => change({ quietGapMinutes: Number(event.target.value) })} />
          </label>
          <label>
            <span>每日动态上限</span>
            <input name="maxReachOutsPerDay" type="number" min={0} max={20} value={draft.maxReachOutsPerDay} onChange={(event) => change({ maxReachOutsPerDay: Number(event.target.value) })} />
          </label>
          <fieldset>
            <legend>不发动态的时段</legend>
            <input aria-label="静默开始" name="silentFrom" type="number" min={0} max={23} value={draft.silentFrom} onChange={(event) => change({ silentFrom: Number(event.target.value) })} />
            <span>点至</span>
            <input aria-label="静默结束" name="silentTo" type="number" min={0} max={23} value={draft.silentTo} onChange={(event) => change({ silentTo: Number(event.target.value) })} />
            <span>点</span>
          </fieldset>
          <label>
            <span>发布方式</span>
            <select name="proactiveMode" value={visibleMode(draft.proactiveMode)} onChange={(event) => change({ proactiveMode: event.target.value as LifeSettings['proactiveMode'] })}>
              <option value="auto">自动</option>
              <option value="text">文字动态</option>
              <option value="image">图片动态</option>
            </select>
          </label>
          <p>动态不会插进聊天记录。旧的“语音 / 文字＋表情包”主动模式会自动按文字动态处理。</p>
          <button type="submit" disabled={busy || !dirty}>{busy ? '正在保存…' : '保存动态设置'}</button>
        </form>
      )}
    </section>
  );
}
