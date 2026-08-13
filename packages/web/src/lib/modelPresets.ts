/**
 * Model library helpers. Kept free of React so the rules that decide whether a
 * preset is acceptable can be tested directly, and so the panel and the server
 * cannot drift apart silently: everything here mirrors `ModelPresetSchema`.
 */

export const MODEL_SLOTS = ['chat', 'vision', 'summary', 'director', 'embedding', 'image', 'tts', 'rerank'] as const;
export type ModelSlot = (typeof MODEL_SLOTS)[number];

export const SLOT_LABELS: Record<ModelSlot, string> = {
  chat: '对话',
  vision: '读图',
  summary: '摘要',
  director: '媒体导演',
  embedding: '记忆向量',
  image: '生图',
  tts: '语音合成',
  rerank: '记忆重排'
};

/** Providers the server accepts, narrowed per slot so the form cannot offer a mismatch. */
export const SLOT_PROVIDERS: Record<ModelSlot, string[]> = {
  chat: ['openai-chat', 'openai-responses', 'anthropic-messages', 'openai-compatible'],
  vision: ['openai-chat', 'openai-responses', 'anthropic-messages', 'openai-compatible'],
  summary: ['openai-chat', 'openai-responses', 'anthropic-messages', 'openai-compatible'],
  director: ['openai-chat', 'openai-responses', 'anthropic-messages', 'openai-compatible'],
  embedding: ['openai-embeddings', 'openai-compatible'],
  image: ['openai-images', 'anuma-input-images', 'openai-compatible'],
  tts: ['openai-tts', 'volc-tts', 'fish', 'openai-compatible'],
  rerank: ['openai-rerank', 'openai-compatible']
};

/** Human labels for the wire protocols, so a form can name what it offers. */
export const PROVIDER_LABELS: Record<string, string> = {
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'openai-compatible': 'OpenAI Compatible',
  'openai-embeddings': 'OpenAI Embeddings',
  'openai-images': 'OpenAI Images',
  'anuma-input-images': 'Anuma input_images 图生图',
  'openai-tts': 'OpenAI TTS',
  'volc-tts': '火山引擎语音合成（官方协议）',
  'fish': 'Fish Audio（S2.x 官方协议）',
  'openai-rerank': 'Rerank（SiliconFlow/Jina 协议）'
};

export interface InterfaceOption {
  value: string;
  label: string;
}

/**
 * The interfaces one capability may actually speak, for a `<select>`.
 *
 * Offering all nine protocols under every capability invites a config that only
 * fails at request time — a 语音合成 slot set to Anthropic Messages looks saved
 * and then throws on the first reply. `current` is kept even when it is not a
 * legal choice: a value missing from the options renders the select blank, and
 * the next save would silently rewrite whatever the server actually had.
 */
export function interfaceOptions(slot: ModelSlot, current?: string | null): InterfaceOption[] {
  const options: InterfaceOption[] = [
    { value: 'none', label: '未配置' },
    ...SLOT_PROVIDERS[slot].map((value) => ({ value, label: PROVIDER_LABELS[value] ?? value }))
  ];
  const now = (current ?? '').trim();
  if (now && !options.some((o) => o.value === now)) {
    options.push({ value: now, label: `${PROVIDER_LABELS[now] ?? now}（当前值，此能力不适用）` });
  }
  return options;
}

export interface ModelPreset {
  id: string;
  name: string;
  slot: ModelSlot;
  provider: string;
  model: string;
  baseUrl: string;
  notes: string;
  /** Server-provided status only; the key itself never crosses this boundary. */
  apiKeyBound?: boolean;
  apiKeyConfigured?: boolean;
}

export const MAX_PRESETS = 60;
const ID_RE = /^[A-Za-z0-9_-]+$/;

export function emptyPreset(slot: ModelSlot = 'chat'): ModelPreset {
  return { id: '', name: '', slot, provider: SLOT_PROVIDERS[slot][0] ?? '', model: '', baseUrl: '', notes: '' };
}

/**
 * Suggests an id from the display name so the operator never has to invent one.
 * Non-ASCII names (the common case here) legitimately reduce to nothing, and the
 * caller then keeps whatever the operator typed.
 */
export function suggestId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** First problem with the draft, in the operator's language, or null when valid. */
export function validatePreset(
  draft: ModelPreset,
  existing: ModelPreset[],
  editingId: string | null = null
): string | null {
  const id = draft.id.trim();
  if (!id) return '请填写预设 ID';
  if (id.length > 64) return '预设 ID 最多 64 个字符';
  if (!ID_RE.test(id)) return '预设 ID 只能包含字母、数字、下划线和连字符';
  if (!draft.name.trim()) return '请填写预设名称';
  if (draft.name.trim().length > 80) return '预设名称最多 80 个字符';
  if (!MODEL_SLOTS.includes(draft.slot)) return '请选择要指派的能力';
  if (!draft.provider.trim()) return '请选择接口协议';
  if (!SLOT_PROVIDERS[draft.slot].includes(draft.provider)) {
    return `${SLOT_LABELS[draft.slot]}不支持该接口协议`;
  }
  if (!draft.model.trim()) return '请填写模型名';
  if (draft.model.trim().length > 200) return '模型名最多 200 个字符';
  if (draft.baseUrl.length > 300) return '接口地址最多 300 个字符';
  if (draft.notes.length > 300) return '备注最多 300 个字符';
  if (existing.some((item) => item.id === id && item.id !== editingId)) return `预设 ID 已存在：${id}`;
  if (!editingId && existing.length >= MAX_PRESETS) return `最多保存 ${MAX_PRESETS} 个预设`;
  return null;
}

/**
 * Turns the config currently being edited into a library entry, so "存入模型库"
 * needs no second form.
 *
 * The id is derived from slot and model name and de-duplicated with a numeric
 * suffix: reusing an existing id would silently overwrite that entry, and the
 * operator asked to *add* one. Non-ASCII model names reduce to nothing under
 * `suggestId`, hence the slot-only fallback.
 *
 * Returns a string when the config cannot become a preset yet — the caller shows
 * it as-is. Never guesses a model name; a preset without one cannot be applied.
 */
export function presetFromConfig(
  slot: ModelSlot,
  config: Record<string, unknown>,
  existing: ModelPreset[]
): ModelPreset | string {
  const model = String(config.model ?? '').trim();
  if (!model) return '先填模型名再添加到模型库';
  const provider = String(config.provider ?? '').trim();
  if (!provider || provider === 'none') return '先选择接口协议再添加到模型库';
  if (!SLOT_PROVIDERS[slot].includes(provider)) return `${SLOT_LABELS[slot]}不支持该接口协议`;
  if (existing.length >= MAX_PRESETS) return `最多保存 ${MAX_PRESETS} 个预设`;
  const stem = (suggestId(`${slot}-${model}`) || slot).slice(0, 60);
  const taken = new Set(existing.map((item) => item.id));
  let id = stem;
  for (let n = 2; taken.has(id); n += 1) id = `${stem}-${n}`;
  return {
    id,
    name: `${SLOT_LABELS[slot]} · ${model}`.slice(0, 80),
    slot,
    provider,
    model: model.slice(0, 200),
    baseUrl: String(config.baseUrl ?? '').trim().slice(0, 300),
    notes: ''
  };
}

/** Trimmed copy safe to send to the server. */
export function normalizePreset(draft: ModelPreset): ModelPreset {
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    slot: draft.slot,
    provider: draft.provider.trim(),
    model: draft.model.trim(),
    baseUrl: draft.baseUrl.trim(),
    notes: draft.notes.trim()
  };
}

/** Replaces the preset being edited in place, or appends a new one. */
export function upsertPreset(list: ModelPreset[], draft: ModelPreset, editingId: string | null = null): ModelPreset[] {
  const next = normalizePreset(draft);
  const at = editingId ? list.findIndex((item) => item.id === editingId) : -1;
  if (at < 0) return [...list, next];
  const copy = [...list];
  copy[at] = next;
  return copy;
}

export function removePreset(list: ModelPreset[], id: string): ModelPreset[] {
  return list.filter((item) => item.id !== id);
}

/** Groups the library by slot for display, dropping slots with nothing in them. */
export function presetsBySlot(list: ModelPreset[]): Array<[ModelSlot, ModelPreset[]]> {
  return MODEL_SLOTS
    .map((slot) => [slot, list.filter((item) => item.slot === slot)] as [ModelSlot, ModelPreset[]])
    .filter(([, items]) => items.length > 0);
}
