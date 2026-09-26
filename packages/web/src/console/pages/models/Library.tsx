import { useState } from 'react';
import { adminApi, type AdminModels } from '../../../lib/admin.js';
import {
  PROVIDER_LABELS, SLOT_PROVIDERS, emptyPreset, presetsBySlot, removePreset, suggestId, upsertPreset, validatePreset,
  type ModelPreset, type ModelSlot
} from '../../../lib/modelPresets.js';
import {
  Button, Callout, ConfirmButton, Empty, Field, Fields, Input, Section, Select, useAction, useConsole
} from '../../ui.js';
import { SLOT_NAMES, SLOT_ORDER } from './shared.js';

function keyText(preset: ModelPreset): string {
  if (preset.apiKeyConfigured) return '带着密钥，应用时一起切换';
  if (preset.apiKeyBound) return '存的时候那项能力没有密钥，应用后也不带密钥';
  return '没有绑定密钥，应用后沿用那项能力现在的密钥';
}

export function Library({ presets, setPresets, onApplied, dirtySlots, onEditSlot, settle }: {
  presets: ModelPreset[];
  setPresets: (next: ModelPreset[]) => void;
  onApplied: (models: AdminModels, slot: ModelSlot) => void;
  dirtySlots: ReadonlySet<ModelSlot>;
  onEditSlot: (slot: ModelSlot) => void;
  /** Clears the unsaved marker when nothing else on the page is pending. */
  settle: () => void;
}) {
  const { notify } = useConsole();
  const { run, busy } = useAction();
  const [draft, setDraft] = useState<ModelPreset | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const close = () => { setDraft(null); setEditingId(null); setProblem(null); settle(); };
  const commit = (next: ModelPreset[], message: string, key: string) => run(key, async () => {
    const response = await adminApi.saveModelPresets(next);
    setPresets(response.presets);
    close();
    return true;
  }, message);

  const submit = () => {
    if (!draft) return;
    const issue = validatePreset(draft, presets, editingId);
    setProblem(issue);
    if (issue) return;
    void commit(upsertPreset(presets, draft, editingId), editingId ? '预设已保存' : '预设已添加', 'save');
  };

  const edit = (patch: Partial<ModelPreset>) => setDraft((old) => {
    if (!old) return old;
    const next = { ...old, ...patch };
    if (patch.slot && !SLOT_PROVIDERS[patch.slot].includes(next.provider)) next.provider = SLOT_PROVIDERS[patch.slot][0] ?? '';
    return next;
  });

  const apply = (preset: ModelPreset) => run(`apply-${preset.id}`, async () => {
    const response = await adminApi.applyModelPreset(preset.id);
    onApplied(response.models, preset.slot);
    notify(`已把「${preset.name}」用在${SLOT_NAMES[preset.slot]}上`, 'ok');
  });

  const original = editingId ? presets.find((p) => p.id === editingId) : undefined;
  const groups = presetsBySlot(presets).sort(([a], [b]) => SLOT_ORDER.indexOf(a) - SLOT_ORDER.indexOf(b));

  const form = draft && (
    <div className="mdl-preset-form">
      <Fields>
        <Field label="名称">
          <Input value={draft.name} maxLength={80} onChange={(e) => {
            const name = e.target.value;
            edit(editingId ? { name } : { name, id: draft.id && draft.id !== suggestId(draft.name) ? draft.id : suggestId(name) });
          }} />
        </Field>
        <Field label="编号" hint={editingId ? '编号保存后不能改。' : '字母、数字、下划线和连字符。中文名称不会自动生成编号，需要手填。'}>
          <Input value={draft.id} maxLength={64} disabled={Boolean(editingId)} onChange={(e) => edit({ id: e.target.value })} />
        </Field>
        <Field label="用在哪项能力" hint={original && original.slot !== draft.slot && original.apiKeyBound ? '改了能力后，这个预设原来带的密钥会丢掉。' : undefined}>
          <Select value={draft.slot} onChange={(e) => edit({ slot: e.target.value as ModelSlot })}
            options={SLOT_ORDER.map((slot) => ({ value: slot, label: SLOT_NAMES[slot] }))} />
        </Field>
        <Field label="接口协议">
          <Select value={draft.provider} onChange={(e) => edit({ provider: e.target.value })}
            options={SLOT_PROVIDERS[draft.slot].map((p) => ({ value: p, label: PROVIDER_LABELS[p] ?? p }))} />
        </Field>
        <Field label="模型名">
          <Input value={draft.model} maxLength={200} onChange={(e) => edit({ model: e.target.value })} />
        </Field>
        <Field label="接口地址" hint="留空表示应用时不改那项能力现在的地址。">
          <Input value={draft.baseUrl} maxLength={300} onChange={(e) => edit({ baseUrl: e.target.value })} />
        </Field>
        <Field label="备注" full>
          <Input value={draft.notes} maxLength={300} onChange={(e) => edit({ notes: e.target.value })} />
        </Field>
      </Fields>
      {!editingId && <p className="cs-muted">手动添加的预设不带密钥，应用时沿用那项能力现在的密钥。想连密钥一起保存，去对应能力里点「存为预设」。</p>}
      {problem && <Callout tone="bad">{problem}</Callout>}
      <div className="cs-actions">
        <Button busy={busy === 'save'} onClick={submit}>{editingId ? '保存预设' : '添加预设'}</Button>
        <Button kind="text" onClick={close}>取消</Button>
      </div>
    </div>
  );

  return (
    <div className="mdl-editor-body">
      <header className="mdl-editor-head">
        <h2>模型库</h2>
        <p>保存下来的模型预设。应用一个预设，就把它换到对应的能力上；带密钥的预设会连密钥一起切换，密钥不会发到浏览器。最多 60 个。</p>
      </header>

      <Section wide title={`全部预设（${presets.length}）`}>
        {draft && !editingId && form}
        {!draft && (
          <div className="cs-actions">
            <Button kind="quiet" onClick={() => { setDraft(emptyPreset('chat')); setEditingId(null); setProblem(null); }}>手动添加预设</Button>
          </div>
        )}
        {presets.length === 0 ? (
          <Empty action={<Button kind="quiet" size="sm" onClick={() => onEditSlot('chat')}>去配置聊天模型</Button>}>
            还没有预设。先在某项能力里配好并保存，再点「存为预设」，以后就能在几个模型之间一键切换。
          </Empty>
        ) : groups.map(([slot, items]) => (
          <div className="mdl-group" key={slot}>
            <h3>{SLOT_NAMES[slot]}</h3>
            <div className="cs-list mdl-presets">
              {items.map((preset) => (
                <div className="cs-list-item" key={preset.id}>
                  <span>
                    <span className="cs-list-title">{preset.name}</span>
                    <span className="mdl-sub">{preset.model}，{PROVIDER_LABELS[preset.provider] ?? preset.provider}</span>
                    {preset.baseUrl && <span className="mdl-sub mdl-url">{preset.baseUrl}</span>}
                    <span className="mdl-sub">{keyText(preset)}</span>
                    {preset.notes && <span className="mdl-sub">{preset.notes}</span>}
                  </span>
                  <span className="cs-actions">
                    <ConfirmButton label="应用" confirmLabel="替换并应用" busy={busy === `apply-${preset.id}`}
                      question={dirtySlots.has(preset.slot) ? `会替换${SLOT_NAMES[preset.slot]}现在的配置，那里未保存的修改也会丢掉。` : `会替换${SLOT_NAMES[preset.slot]}现在的配置。`}
                      onConfirm={() => apply(preset)} />
                    <Button kind="quiet" size="sm" onClick={() => { setDraft({ ...preset }); setEditingId(preset.id); setProblem(null); }}>编辑</Button>
                    <ConfirmButton label="删除" question={`删除预设「${preset.name}」？`} confirmLabel="删除这个预设"
                      busy={busy === `delete-${preset.id}`}
                      onConfirm={() => commit(removePreset(presets, preset.id), '预设已删除', `delete-${preset.id}`)} />
                  </span>
                  {editingId === preset.id && <div className="cs-list-body">{form}</div>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </Section>
    </div>
  );
}
