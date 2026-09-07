import { useEffect, useState } from 'react';
import { adminApi, type AdminModels } from '../../lib/admin.js';
import {
  MODEL_SLOTS,
  presetsBySlot,
  removePreset,
  SLOT_LABELS,
  SLOT_PROVIDERS,
  suggestId,
  upsertPreset,
  validatePreset,
  type ModelPreset,
  type ModelSlot
} from '../../lib/modelPresets.js';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

/**
 * The saved model library. The capability slots are fixed, so this is the only
 * way to "add a model"; applying a preset is what actually assigns it to its
 * slot on the server. Collapsed while empty so the configuration form, which
 * is what a new operator needs first, sits right under the heading.
 */
export function ModelLibrary({ onNotice, onApplied, reloadKey = 0 }: { onNotice: (v: string) => void; onApplied: (models: AdminModels) => void; reloadKey?: number }) {
  const [presets, setPresets] = useState<ModelPreset[] | null>(null);
  const [draft, setDraft] = useState<ModelPreset | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** null = follow the content: open when there is something to show. */
  const [expanded, setExpanded] = useState<boolean | null>(null);

  // reloadKey changes when the config form adds an entry, so this list never
  // keeps a stale copy it would later write back over the new one.
  useEffect(() => {
    void adminApi.modelPresets().then((r) => setPresets(r.presets)).catch((e) => onNotice(errorText(e)));
  }, [onNotice, reloadKey]);

  const commit = async (next: ModelPreset[], message: string) => {
    setBusy(true);
    try {
      const saved = await adminApi.saveModelPresets(next);
      setPresets(saved.presets);
      setDraft(null);
      setEditingId(null);
      onNotice(message);
    } catch (e) {
      onNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (!draft || !presets) return;
    const problem = validatePreset(draft, presets, editingId);
    if (problem) {
      onNotice(problem);
      return;
    }
    void commit(upsertPreset(presets, draft, editingId), editingId ? '预设已更新' : '预设已添加');
  };

  const apply = async (preset: ModelPreset) => {
    setBusy(true);
    try {
      const result = await adminApi.applyModelPreset(preset.id);
      onApplied(result.models);
      onNotice(`已把「${preset.name}」指派给${SLOT_LABELS[preset.slot]}`);
    } catch (e) {
      onNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const update = (patch: Partial<ModelPreset>) => setDraft((prev) => {
    if (!prev) return prev;
    const next = { ...prev, ...patch };
    // A slot change can strand the provider on something that slot rejects.
    if (patch.slot && !SLOT_PROVIDERS[patch.slot].includes(next.provider)) {
      next.provider = SLOT_PROVIDERS[patch.slot][0] ?? '';
    }
    return next;
  });

  if (!presets) return <p className="admin-muted">正在读取模型库…</p>;
  const groups = presetsBySlot(presets);
  const open = expanded ?? (presets.length > 0 || draft !== null);

  return (
    <section className="admin-model-library" data-testid="admin-model-library" data-open={open || undefined}>
      <div className="admin-model-library-head">
        <div>
          <h3>模型库</h3>
          <small>{presets.length
            ? `${presets.length} 个预设。指派时连同服务器端密钥一起切换，密钥不会返回浏览器。`
            : '还没有预设。填好下面的配置后点「存入模型库」，之后就能在不同模型之间一键切换。'}</small>
        </div>
        <button type="button" aria-expanded={open} data-testid="admin-model-library-toggle" onClick={() => setExpanded(!open)}>{open ? '收起' : '展开'}</button>
      </div>
      {open && groups.map(([slot, items]) => (
        <div className="admin-preset-group" key={slot}>
          <h3>{SLOT_LABELS[slot]}</h3>
          {items.map((preset) => (
            <div className={editingId === preset.id ? 'admin-preset-row active' : 'admin-preset-row'} key={preset.id} data-testid={`admin-preset-${preset.id}`}>
              <div className="admin-preset-copy">
                <strong>{preset.name}</strong>
                <small>{preset.model} · {preset.provider}{preset.baseUrl ? ` · ${preset.baseUrl}` : ''}</small>
                <small>{preset.apiKeyConfigured
                  ? '密钥已绑定'
                  : preset.apiKeyBound
                    ? '已绑定（无需密钥）'
                    : '未绑定密钥（旧预设）'}</small>
                {preset.notes && <small>{preset.notes}</small>}
              </div>
              <div className="admin-preset-actions">
                <button type="button" className="primary" disabled={busy} onClick={() => void apply(preset)}>指派</button>
                <button type="button" disabled={busy} onClick={() => { setDraft(preset); setEditingId(preset.id); }}>编辑</button>
                <button type="button" className="admin-danger" disabled={busy} onClick={() => void commit(removePreset(presets, preset.id), '预设已删除')}>删除</button>
              </div>
            </div>
          ))}
        </div>
      ))}

      {open && draft ? (
        <div className="admin-preset-form" data-testid="admin-preset-form">
          <label>预设名称<input value={draft.name} onChange={(e) => {
            const name = e.target.value;
            update(editingId ? { name } : { name, id: draft.id || suggestId(name) });
          }} /></label>
          <label>预设 ID<input value={draft.id} disabled={Boolean(editingId)} onChange={(e) => update({ id: e.target.value })} /></label>
          <label>指派能力<select value={draft.slot} onChange={(e) => update({ slot: e.target.value as ModelSlot })}>
            {MODEL_SLOTS.map((slot) => <option key={slot} value={slot}>{SLOT_LABELS[slot]}</option>)}
          </select></label>
          <label>接口协议<select value={draft.provider} onChange={(e) => update({ provider: e.target.value })}>
            {SLOT_PROVIDERS[draft.slot].map((provider) => <option key={provider} value={provider}>{provider}</option>)}
          </select></label>
          <label>模型名<input value={draft.model} onChange={(e) => update({ model: e.target.value })} /></label>
          <label>接口地址<input value={draft.baseUrl} placeholder="留空则用默认地址" onChange={(e) => update({ baseUrl: e.target.value })} /></label>
          <label>备注<input value={draft.notes} onChange={(e) => update({ notes: e.target.value })} /></label>
          <div className="admin-preset-form-actions">
            <button type="button" className="admin-primary" disabled={busy} onClick={submit}>{editingId ? '保存修改' : '添加到模型库'}</button>
            <button type="button" disabled={busy} onClick={() => { setDraft(null); setEditingId(null); }}>取消</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
