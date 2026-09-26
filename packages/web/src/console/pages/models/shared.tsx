import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import type { AdminModels, AdminWebSearchConfig } from '../../../lib/admin.js';
import { MODEL_SLOTS, type ModelSlot } from '../../../lib/modelPresets.js';
import { Input, type Tone } from '../../ui.js';

export type Rec = Record<string, unknown>;
export type Selection = ModelSlot | 'webSearch' | 'decision' | 'library';

export const SELECTIONS: Selection[] = [...MODEL_SLOTS, 'webSearch', 'decision', 'library'];

/** Names used everywhere on this page, so the list, the editor and the library agree. */
export const SLOT_NAMES: Record<ModelSlot, string> = {
  chat: '聊天',
  vision: '看图',
  summary: '对话总结',
  director: '媒体导演',
  embedding: '记忆向量',
  rerank: '记忆重排',
  image: '生图',
  video: '视频',
  tts: '语音合成'
};

export const SLOT_ORDER: ModelSlot[] = ['chat', 'vision', 'summary', 'director', 'embedding', 'rerank', 'image', 'video', 'tts'];

export const SLOT_ABOUT: Record<ModelSlot, string> = {
  chat: '她回你消息时用的主模型。看图、对话总结、媒体导演没有单独配置时，也用它。',
  vision: '你发图片给她时，用这个模型看懂图片。没有单独配置时用聊天模型，前提是聊天模型能读图。',
  summary: '把较早的聊天压缩成摘要，让她记得住很长的对话。没有单独配置时用聊天模型。',
  director: '替她挑表情包、把要念出来的回复改成口语、扩写生图提示词。只处理短文本，不负责看图。没有单独配置时用聊天模型。',
  embedding: '把记忆转成向量，按意思找回相关的记忆。换了模型或维度，旧记忆的向量需要重建才找得回来。',
  rerank: '对找回来的记忆再排一次序，把最相关的放前面。不配也能用，只是找回的顺序粗一些。',
  image: '她发自拍、画图时用。',
  video: '文生视频和图生视频。视频是异步任务：提交后排队生成，完成后下载保存。',
  tts: '她发语音时用的声音。'
};

/** Slots that fall back to the chat model while they have no section of their own. */
export const INHERITING: ReadonlySet<ModelSlot> = new Set(['vision', 'summary', 'director']);
export const CHAT_LIKE: ReadonlySet<ModelSlot> = new Set(['chat', 'vision', 'summary', 'director']);

export const WEB_SEARCH_NAMES: Record<string, string> = { doubao: '豆包', tavily: 'Tavily', responses: 'Responses 原生搜索' };

export function rec(value: unknown): Rec | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : undefined;
}

export function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export interface SlotStatus { tone: Tone; text: string }

function ownStatus(slot: ModelSlot, config: Rec): SlotStatus {
  const provider = str(config.provider) || 'none';
  const model = str(config.model).trim();
  if (provider === 'none' || !model) return { tone: 'off', text: '未配置' };
  if (config.apiKeyConfigured !== true) {
    return { tone: 'warn', text: str(config.apiKeyEnv).trim() ? `${model}，环境变量里没读到密钥` : `${model}，缺少密钥` };
  }
  if (slot === 'vision' && config.supportsVision !== true) return { tone: 'warn', text: `${model}，没有声明能读图` };
  return { tone: 'ok', text: model };
}

/** What the capability list shows for one slot, read from the redacted config. */
export function slotStatus(slot: ModelSlot, models: AdminModels): SlotStatus {
  const own = rec(models[slot]);
  if (INHERITING.has(slot) && !own) {
    const legacy = slot === 'director' ? rec(models.sticker) : undefined;
    if (legacy) {
      const status = ownStatus(slot, legacy);
      return { ...status, text: `沿用旧的表情模型：${status.text}` };
    }
    const chat = ownStatus('chat', rec(models.chat) ?? {});
    if (chat.tone !== 'ok') return { tone: 'off', text: '跟随聊天模型，聊天还没配好' };
    if (slot === 'vision' && rec(models.chat)?.supportsVision !== true) return { tone: 'warn', text: '跟随聊天模型，但它不能读图' };
    return { tone: 'ok', text: '跟随聊天模型' };
  }
  return ownStatus(slot, own ?? {});
}

export function webSearchStatus(config: AdminWebSearchConfig | undefined): SlotStatus {
  if (!config?.enabled) return { tone: 'off', text: '已关闭' };
  if (!config.providers.length) return { tone: 'warn', text: '没有启用任何提供方' };
  const missing = config.providers.filter((p) => (p === 'doubao' && !config.doubao.apiKeyConfigured) || (p === 'tavily' && !config.tavily.apiKeyConfigured));
  const names = config.providers.map((p) => WEB_SEARCH_NAMES[p] ?? p).join('、');
  if (missing.length === config.providers.length) return { tone: 'warn', text: `${names}，都缺少密钥` };
  return { tone: missing.length ? 'warn' : 'ok', text: missing.length ? `${names}，部分缺少密钥` : names };
}

export function decisionStatus(config: Rec | undefined): SlotStatus {
  if (!config?.enabled) return { tone: 'off', text: '已关闭' };
  if (config.apiKeyConfigured !== true) return { tone: 'warn', text: '已开启，缺少密钥' };
  return { tone: 'ok', text: str(config.model) || '已开启' };
}

/** Drops server-only status fields before a config goes back to the server. */
export function stripStatus(config: Rec): Rec {
  const { apiKeyConfigured: _configured, ...rest } = config;
  return rest;
}

/**
 * A number box that keeps what the operator is typing (e.g. "0.") instead of
 * reformatting on every keystroke. An empty box reports undefined, which the
 * server's merge treats as "leave the saved value alone".
 */
export function NumberInput({ value, onValue, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: unknown; onValue: (next: number | undefined) => void;
}) {
  const shown = typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  const [text, setText] = useState(shown);
  useEffect(() => {
    if (text === '' ? shown !== '' : Number(text) !== value) setText(shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  return (
    <Input
      {...props}
      type="number"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = e.target.value === '' ? undefined : Number(e.target.value);
        onValue(n === undefined || Number.isFinite(n) ? n : undefined);
      }}
    />
  );
}

/**
 * Two-step button for actions that spend money at an outside service. It is
 * not a danger action, so it stays in the action colour and asks in amber.
 */
export { CostButton } from '../../ui.js';

export function pct(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
}

/** Field-shaped wrapper for controls that carry their own <label> (switches), so labels never nest. */
export function Group({ label, hint, full, children }: { label: string; hint?: ReactNode; full?: boolean; children: ReactNode }) {
  return (
    <div className="cs-field" data-span={full ? 'full' : undefined} role="group" aria-label={label}>
      <span className="cs-field-label">{label}</span>
      {children}
      {hint ? <span className="cs-field-hint">{hint}</span> : null}
    </div>
  );
}
