import { useEffect, useState, type FormEvent } from 'react';
import { featureApi, type LifeSettings } from '../../lib/features.js';
import { contactBoundaryPayload } from '../../lib/lifeObservation.js';

interface LifeContactBoundaryFormProps {
  initial: LifeSettings;
  onNotice: (message: string) => void;
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
      onNotice('联系边界已保存');
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
        <span><strong>联系边界</strong><small>只决定她什么时候、以什么方式联系你</small></span>
        <span aria-hidden="true">{open ? '−' : '＋'}</span>
      </button>
      {open && (
        <form id="life-boundaries-panel" className="life-boundary-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>允许主动联系</span>
            <input
              name="reachOut"
              type="checkbox"
              checked={draft.reachOut}
              onChange={(event) => change({ reachOut: event.target.checked })}
            />
          </label>
          <label>
            <span>安静间隔（分钟）</span>
            <input
              name="quietGapMinutes"
              type="number"
              min={5}
              max={1440}
              value={draft.quietGapMinutes}
              onChange={(event) => change({ quietGapMinutes: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>每日主动联系上限</span>
            <input
              name="maxReachOutsPerDay"
              type="number"
              min={0}
              max={20}
              value={draft.maxReachOutsPerDay}
              onChange={(event) => change({ maxReachOutsPerDay: Number(event.target.value) })}
            />
          </label>
          <fieldset>
            <legend>静默时段</legend>
            <input
              aria-label="静默开始"
              name="silentFrom"
              type="number"
              min={0}
              max={23}
              value={draft.silentFrom}
              onChange={(event) => change({ silentFrom: Number(event.target.value) })}
            />
            <span>点至</span>
            <input
              aria-label="静默结束"
              name="silentTo"
              type="number"
              min={0}
              max={23}
              value={draft.silentTo}
              onChange={(event) => change({ silentTo: Number(event.target.value) })}
            />
            <span>点</span>
          </fieldset>
          <label>
            <span>主动分享方式</span>
            <select
              name="proactiveMode"
              value={draft.proactiveMode ?? 'auto'}
              onChange={(event) => change({ proactiveMode: event.target.value as LifeSettings['proactiveMode'] })}
            >
              <option value="auto">自动</option>
              <option value="text">文字</option>
              <option value="text_sticker">文字＋表情包</option>
              <option value="voice">语音</option>
              <option value="image">图片</option>
            </select>
          </label>
          <p>这些设置不会改变她的心情、计划、地点或事件。</p>
          <button type="submit" disabled={busy || !dirty}>
            {busy ? '正在保存…' : '保存联系边界'}
          </button>
        </form>
      )}
    </section>
  );
}
