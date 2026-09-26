import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, type AdminModels, type AdminWebSearchConfig } from '../../lib/admin.js';
import type { ModelPreset, ModelSlot } from '../../lib/modelPresets.js';
import { Button, Callout, Loadable, Page, Status, Tag, errorMessage, useConsole, useLoad } from '../ui.js';
import { DecisionEditor, type DecisionDraft } from './models/DecisionEditor.js';
import { Library } from './models/Library.js';
import { SlotEditor, type SlotDraft } from './models/SlotEditor.js';
import { WebSearchEditor, type WebSearchDraft } from './models/WebSearchEditor.js';
import {
  SELECTIONS, SLOT_NAMES, SLOT_ORDER, decisionStatus, rec, slotStatus, webSearchStatus, type Selection, type SlotStatus
} from './models/shared.js';
import './models.css';

interface Drafts {
  slots: Partial<Record<ModelSlot, SlotDraft>>;
  webSearch?: WebSearchDraft;
  decision?: DecisionDraft;
}

function initialSelection(): Selection {
  const hash = typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, '');
  return (SELECTIONS as string[]).includes(hash) ? hash as Selection : 'chat';
}

function pending(drafts: Drafts): boolean {
  return Object.keys(drafts.slots).length > 0 || drafts.webSearch !== undefined || drafts.decision !== undefined;
}

function CapButton({ name, status, active, dirty, onSelect }: {
  name: string; status?: SlotStatus; active: boolean; dirty?: boolean; onSelect: () => void;
}) {
  return (
    <button type="button" className="mdl-cap" aria-current={active ? 'true' : undefined} onClick={onSelect}>
      <span className="mdl-cap-name">{name}{dirty && <Tag tone="warn">未保存</Tag>}</span>
      {status && <Status tone={status.tone}><span className="mdl-cap-text">{status.text}</span></Status>}
    </button>
  );
}

export default function Models() {
  const { markClean } = useConsole();
  const models = useLoad(() => adminApi.models().then((r) => r.models));
  const presets = useLoad(() => adminApi.modelPresets().then((r) => r.presets));
  const [selected, setSelected] = useState<Selection>(initialSelection);
  const [drafts, setDraftsState] = useState<Drafts>({ slots: {} });
  const draftsRef = useRef(drafts);
  const editorRef = useRef<HTMLDivElement | null>(null);

  /** Drafts live here so switching capabilities never throws away what was typed. */
  const setDrafts = useCallback((change: (old: Drafts) => Drafts) => {
    const next = change(draftsRef.current);
    draftsRef.current = next;
    setDraftsState(next);
    if (!pending(next)) markClean();
  }, [markClean]);
  const settle = useCallback(() => { if (!pending(draftsRef.current)) markClean(); }, [markClean]);

  const setSlotDraft = (slot: ModelSlot) => (next: SlotDraft | undefined) => setDrafts((old) => {
    const slots = { ...old.slots };
    if (next) slots[slot] = next; else delete slots[slot];
    return { ...old, slots };
  });

  const select = (next: Selection) => {
    setSelected(next);
    try { window.history.replaceState(window.history.state, '', `#${next}`); } catch { /* sandboxed history */ }
    if (window.matchMedia?.('(max-width: 900px)').matches) {
      requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    }
  };

  useEffect(() => {
    const onHash = () => setSelected(initialSelection());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const onSaved = (next: AdminModels) => models.setData(next);
  const reloadPresets = () => presets.reload();
  const setPresetList = (next: ModelPreset[]) => presets.setData(next);

  return (
    <Page
      title="模型"
      register="system"
      intro="她的每项能力背后用哪个模型、连哪个服务。选一项能力，就能查看和修改它的设置。"
      actions={<Button kind="text" size="sm" busy={models.loading && models.data !== null} onClick={() => { void models.reload(); void presets.reload(); }}>重新读取</Button>}
    >
      <Loadable state={models} label="模型配置">
        {(data) => {
          const dirtySlots = new Set(Object.keys(drafts.slots) as ModelSlot[]);
          return (
            <div className="mdl-layout">
              <nav className="mdl-caps" aria-label="能力" data-no-dirty>
                <div className="mdl-cap-group">
                  {SLOT_ORDER.map((slot) => (
                    <CapButton key={slot} name={SLOT_NAMES[slot]} status={slotStatus(slot, data)} active={selected === slot}
                      dirty={dirtySlots.has(slot)} onSelect={() => select(slot)} />
                  ))}
                </div>
                <div className="mdl-cap-group">
                  <CapButton name="联网搜索" status={webSearchStatus(data.webSearch as AdminWebSearchConfig | undefined)} active={selected === 'webSearch'}
                    dirty={drafts.webSearch !== undefined} onSelect={() => select('webSearch')} />
                  <CapButton name="行为决策" status={decisionStatus(rec(data.decision))} active={selected === 'decision'}
                    dirty={drafts.decision !== undefined} onSelect={() => select('decision')} />
                </div>
                <div className="mdl-cap-group">
                  <CapButton name="模型库"
                    status={presets.data ? { tone: presets.data.length ? 'ok' : 'off', text: presets.data.length ? `${presets.data.length} 个预设` : '还没有预设' } : undefined}
                    active={selected === 'library'} onSelect={() => select('library')} />
                </div>
              </nav>

              <div className="mdl-editor" ref={editorRef}>
                {selected === 'webSearch' ? (
                  data.webSearch ? (
                    <WebSearchEditor models={data} draft={drafts.webSearch} onSaved={onSaved}
                      setDraft={(next) => setDrafts((old) => ({ ...old, webSearch: next }))} />
                  ) : <Callout tone="warn">服务器没有返回联网搜索的配置，可能是后端版本太旧。</Callout>
                ) : selected === 'decision' ? (
                  <DecisionEditor models={data} draft={drafts.decision} onSaved={onSaved}
                    setDraft={(next) => setDrafts((old) => ({ ...old, decision: next }))} />
                ) : selected === 'library' ? (
                  presets.data ? (
                    <Library presets={presets.data} setPresets={setPresetList} dirtySlots={dirtySlots} settle={settle}
                      onEditSlot={(slot) => select(slot)}
                      onApplied={(next, slot) => { onSaved(next); setSlotDraft(slot)(undefined); }} />
                  ) : presets.error ? (
                    <Callout tone="bad">
                      模型库读取失败：{errorMessage(presets.error)}{' '}
                      <Button kind="text" size="sm" onClick={() => void presets.reload()}>重试</Button>
                    </Callout>
                  ) : <p className="cs-muted">正在读取模型库…</p>
                ) : (
                  <SlotEditor key={selected} slot={selected} models={data} draft={drafts.slots[selected]}
                    setDraft={setSlotDraft(selected)} onSaved={onSaved}
                    presets={presets.data} presetsError={presets.error ? errorMessage(presets.error) : null} onPresetsChanged={reloadPresets} />
                )}
              </div>
            </div>
          );
        }}
      </Loadable>
    </Page>
  );
}
