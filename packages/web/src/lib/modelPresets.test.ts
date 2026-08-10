import { describe, expect, it } from 'vitest';
import {
  emptyPreset,
  interfaceOptions,
  MAX_PRESETS,
  MODEL_SLOTS,
  normalizePreset,
  presetFromConfig,
  presetsBySlot,
  PROVIDER_LABELS,
  removePreset,
  SLOT_PROVIDERS,
  suggestId,
  upsertPreset,
  validatePreset,
  type ModelPreset
} from './modelPresets.js';

const chatPreset: ModelPreset = {
  id: 'glm-4-6',
  name: 'GLM-4.6 主聊',
  slot: 'chat',
  provider: 'openai-compatible',
  model: 'glm-4.6',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  notes: '日常对话'
};

describe('model preset validation', () => {
  it('accepts a complete preset', () => {
    expect(validatePreset(chatPreset, [])).toBeNull();
  });

  it('names the missing field instead of failing generically', () => {
    expect(validatePreset({ ...chatPreset, id: '' }, [])).toBe('请填写预设 ID');
    expect(validatePreset({ ...chatPreset, name: '' }, [])).toBe('请填写预设名称');
    expect(validatePreset({ ...chatPreset, model: '' }, [])).toBe('请填写模型名');
  });

  it('rejects an id the server would reject', () => {
    expect(validatePreset({ ...chatPreset, id: 'has spaces' }, [])).toContain('只能包含');
    expect(validatePreset({ ...chatPreset, id: '主聊' }, [])).toContain('只能包含');
    expect(validatePreset({ ...chatPreset, id: 'a'.repeat(65) }, [])).toContain('64');
  });

  it('refuses a provider the slot cannot use', () => {
    expect(validatePreset({ ...chatPreset, slot: 'tts', provider: 'openai-chat' }, [])).toBe('语音合成不支持该接口协议');
    expect(validatePreset({ ...chatPreset, slot: 'tts', provider: 'openai-tts' }, [])).toBeNull();
  });

  it('blocks a duplicate id but lets the same preset be edited', () => {
    expect(validatePreset(chatPreset, [chatPreset])).toBe('预设 ID 已存在：glm-4-6');
    expect(validatePreset({ ...chatPreset, name: '改个名' }, [chatPreset], 'glm-4-6')).toBeNull();
  });

  it('stops at the library cap for new presets only', () => {
    const full = Array.from({ length: MAX_PRESETS }, (_, i) => ({ ...chatPreset, id: `p${i}` }));
    expect(validatePreset({ ...chatPreset, id: 'one-more' }, full)).toBe(`最多保存 ${MAX_PRESETS} 个预设`);
    expect(validatePreset({ ...chatPreset, id: 'p0' }, full, 'p0')).toBeNull();
  });
});

describe('model preset editing', () => {
  it('trims every field before sending', () => {
    const messy = { ...chatPreset, id: ' glm-4-6 ', name: '  主聊  ', model: ' glm-4.6 ', apiKeyEnv: ' LEGACY_KEY ' };
    expect(normalizePreset(messy as ModelPreset)).toMatchObject({ id: 'glm-4-6', name: '主聊', model: 'glm-4.6' });
    expect(normalizePreset(messy as ModelPreset)).not.toHaveProperty('apiKeyEnv');
  });

  it('appends a new preset and replaces an edited one in place', () => {
    const second = { ...chatPreset, id: 'gpt-image', slot: 'image' as const, provider: 'openai-images', model: 'gpt-image-1' };
    const list = upsertPreset(upsertPreset([], chatPreset), second);
    expect(list.map((p) => p.id)).toEqual(['glm-4-6', 'gpt-image']);

    const edited = upsertPreset(list, { ...chatPreset, name: '新名字' }, 'glm-4-6');
    expect(edited).toHaveLength(2);
    expect(edited[0]?.name).toBe('新名字');
    expect(edited.map((p) => p.id)).toEqual(['glm-4-6', 'gpt-image']);
  });

  it('removes by id and groups the rest by slot', () => {
    const list = [chatPreset, { ...chatPreset, id: 'img', slot: 'image' as const, provider: 'openai-images' }];
    expect(removePreset(list, 'glm-4-6').map((p) => p.id)).toEqual(['img']);
    expect(presetsBySlot(list).map(([slot, items]) => [slot, items.length])).toEqual([['chat', 1], ['image', 1]]);
  });

  it('suggests an id from the name and leaves non-ASCII names to the operator', () => {
    expect(suggestId('GPT Image 1')).toBe('gpt-image-1');
    expect(suggestId('  Claude 3.5 Sonnet ')).toBe('claude-3-5-sonnet');
    expect(suggestId('主聊模型')).toBe('');
  });

  it('starts a new draft on a provider the chosen slot supports', () => {
    expect(validatePreset({ ...emptyPreset('tts'), id: 'x', name: 'x', model: 'x' }, [])).toBeNull();
    expect(validatePreset({ ...emptyPreset('image'), id: 'x', name: 'x', model: 'x' }, [])).toBeNull();
    expect(interfaceOptions('image').map((option) => option.value)).toContain('anuma-input-images');
  });
});

describe('interface options per capability', () => {
  it('offers 语音合成 only the speech interfaces', () => {
    expect(interfaceOptions('tts').map((o) => o.value)).toEqual(['none', 'openai-tts', 'volc-tts', 'fish', 'openai-compatible']);
  });

  it('never offers one capability the interface of another', () => {
    const foreign: Record<string, string[]> = {
      chat: ['openai-tts', 'openai-transcriptions', 'openai-images', 'openai-embeddings'],
      tts: ['anthropic-messages', 'openai-chat', 'openai-transcriptions'],
      embedding: ['openai-chat', 'openai-images'],
      image: ['openai-chat', 'openai-tts']
    };
    for (const [slot, banned] of Object.entries(foreign)) {
      const offered = interfaceOptions(slot as never).map((o) => o.value);
      for (const bad of banned) expect(offered, `${slot} must not offer ${bad}`).not.toContain(bad);
    }
  });

  it('labels every interface it offers, so no raw slug reaches the operator', () => {
    for (const slot of MODEL_SLOTS) {
      for (const option of interfaceOptions(slot)) {
        expect(option.label, `${slot}/${option.value} needs a label`).not.toEqual(option.value);
        expect(option.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('gives every server-accepted provider a label so the table cannot drift', () => {
    for (const slot of MODEL_SLOTS) {
      for (const provider of SLOT_PROVIDERS[slot]) {
        expect(PROVIDER_LABELS[provider], `${provider} has no label`).toBeTruthy();
      }
    }
  });

  it('keeps a saved value the capability does not allow, instead of blanking the select', () => {
    const offered = interfaceOptions('tts', 'anthropic-messages');
    expect(offered.map((o) => o.value)).toContain('anthropic-messages');
    expect(offered.at(-1)?.label).toContain('此能力不适用');
  });

  it('does not duplicate a saved value that is already legal', () => {
    const values = interfaceOptions('tts', 'openai-tts').map((o) => o.value);
    expect(values.filter((v) => v === 'openai-tts')).toHaveLength(1);
  });
});

describe('presetFromConfig（把当前配置存进模型库）', () => {
  const cfg = { provider: 'openai-compatible', model: 'deepseek-v4-flash', baseUrl: 'https://api.sooya.icu/v1', apiKeyEnv: 'SOOYA_CHAT_API_KEY' };

  it('carries the config over and derives an id and a readable name', () => {
    const preset = presetFromConfig('chat', cfg, []);
    expect(typeof preset).not.toBe('string');
    expect(preset).toMatchObject({
      id: 'chat-deepseek-v4-flash',
      slot: 'chat',
      provider: 'openai-compatible',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.sooya.icu/v1',
    });
    expect(preset).not.toHaveProperty('apiKeyEnv');
    expect((preset as ModelPreset).name).toContain('deepseek-v4-flash');
  });

  it('suffixes a colliding id instead of overwriting the existing entry', () => {
    const first = presetFromConfig('chat', cfg, []) as ModelPreset;
    const second = presetFromConfig('chat', cfg, [first]) as ModelPreset;
    const third = presetFromConfig('chat', cfg, [first, second]) as ModelPreset;
    expect(second.id).toBe('chat-deepseek-v4-flash-2');
    expect(third.id).toBe('chat-deepseek-v4-flash-3');
  });

  it('produces a preset the server-side validator accepts', () => {
    const preset = presetFromConfig('tts', { provider: 'volc-tts', model: 'seed-tts-2.0' }, []) as ModelPreset;
    expect(validatePreset(preset, [])).toBeNull();
  });

  it('refuses rather than inventing a model name', () => {
    expect(presetFromConfig('chat', { ...cfg, model: '   ' }, [])).toMatch(/模型名/);
  });

  it('refuses a slot that is switched off or mismatched, which could never be applied', () => {
    expect(presetFromConfig('chat', { ...cfg, provider: 'none' }, [])).toMatch(/接口协议/);
    expect(presetFromConfig('tts', { provider: 'openai-embeddings', model: 'x' }, [])).toMatch(/不支持/);
  });

  it('falls back to a slot-only id when the model name is entirely non-ascii', () => {
    const preset = presetFromConfig('image', { provider: 'openai-images', model: '豆包画图' }, []) as ModelPreset;
    expect(preset.id).toBe('image');
    expect(validatePreset(preset, [])).toBeNull();
  });

  it('stops at the library cap', () => {
    const full = Array.from({ length: MAX_PRESETS }, (_, i) => ({ ...(presetFromConfig('chat', cfg, []) as ModelPreset), id: `p${i}` }));
    expect(presetFromConfig('chat', cfg, full)).toMatch(/最多/);
  });
});
