import { useState } from 'react';
import { adminApi, type AdminModels, type AdminWebSearchConfig, type AdminWebSearchProvider } from '../../../lib/admin.js';
import {
  Button, Callout, ConfirmButton, Field, Fields, Input, Section, Select, Status, Switch, useAction
} from '../../ui.js';
import { Group, NumberInput, WEB_SEARCH_NAMES, rec, str, webSearchStatus } from './shared.js';

export interface WebSearchDraft {
  config: AdminWebSearchConfig;
  doubaoKey: string;
  tavilyKey: string;
  clearDoubao: boolean;
  clearTavily: boolean;
}

const ALL: AdminWebSearchProvider[] = ['doubao', 'tavily', 'responses'];
const KEY_LABELS = { doubao: '豆包密钥', tavily: 'Tavily 密钥' } as const;

export function WebSearchEditor({ models, draft, setDraft, onSaved }: {
  models: AdminModels;
  draft: WebSearchDraft | undefined;
  setDraft: (next: WebSearchDraft | undefined) => void;
  onSaved: (models: AdminModels) => void;
}) {
  const { run, busy } = useAction();
  const saved = models.webSearch as AdminWebSearchConfig;
  const d: WebSearchDraft = draft ?? { config: saved, doubaoKey: '', tavilyKey: '', clearDoubao: false, clearTavily: false };
  const config = d.config;
  const dirty = draft !== undefined;
  const chat = rec(models.chat) ?? {};
  const responsesAvailable = str(chat.provider) === 'openai-responses' && chat.supportsTools === true;
  const status = webSearchStatus(saved);

  const [query, setQuery] = useState('今天的天气');
  const [results, setResults] = useState<Partial<Record<AdminWebSearchProvider, { ok: boolean; text: string }>>>({});

  const change = (patch: Partial<WebSearchDraft>) => setDraft({ ...d, ...patch });
  const update = (patch: Partial<AdminWebSearchConfig>) => change({ config: { ...config, ...patch } });

  const toggle = (provider: AdminWebSearchProvider, on: boolean) => update({
    providers: on ? [...config.providers.filter((p) => p !== provider), provider] : config.providers.filter((p) => p !== provider)
  });
  const move = (provider: AdminWebSearchProvider, delta: -1 | 1) => {
    const list = [...config.providers];
    const at = list.indexOf(provider);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= list.length) return;
    [list[at], list[to]] = [list[to]!, list[at]!];
    update({ providers: list });
  };

  const save = () => run('save', async () => {
    const { apiKey: _a, apiKeyConfigured: _b, ...doubao } = config.doubao;
    const { apiKey: _c, apiKeyConfigured: _e, ...tavily } = config.tavily;
    const patch: AdminWebSearchConfig = {
      ...config,
      doubao: { ...doubao, ...(d.doubaoKey.trim() ? { apiKey: d.doubaoKey.trim() } : d.clearDoubao ? { apiKey: '' } : {}) },
      tavily: { ...tavily, ...(d.tavilyKey.trim() ? { apiKey: d.tavilyKey.trim() } : d.clearTavily ? { apiKey: '' } : {}) }
    };
    const response = await adminApi.updateModels({ webSearch: patch });
    setDraft(undefined);
    setResults({});
    onSaved(response.models);
  }, '联网搜索设置已保存');

  const test = (provider: AdminWebSearchProvider) => run(`test-${provider}`, async () => {
    if ((provider === 'doubao' || provider === 'tavily') && !saved[provider].apiKeyConfigured) {
      setResults((old) => ({ ...old, [provider]: { ok: false, text: `还没有保存${KEY_LABELS[provider]}，填好并保存后再测。` } }));
      return;
    }
    setResults((old) => ({ ...old, [provider]: undefined }));
    try {
      const r = await adminApi.testWebSearch(provider, query.trim() || '今天的天气');
      setResults((old) => ({ ...old, [provider]: { ok: true, text: `能用：搜到 ${r.resultCount} 条结果，用时 ${r.latencyMs} 毫秒。` } }));
    } catch (e) {
      setResults((old) => ({ ...old, [provider]: { ok: false, text: e instanceof Error ? e.message : '搜索测试没有通过' } }));
    }
  });

  const keyField = (which: 'doubao' | 'tavily') => {
    const configured = saved[which].apiKeyConfigured === true;
    const cleared = which === 'doubao' ? d.clearDoubao : d.clearTavily;
    const value = which === 'doubao' ? d.doubaoKey : d.tavilyKey;
    const label = KEY_LABELS[which];
    return (
      <Group label={label} hint={cleared ? '保存后会删除现在的密钥。' : configured ? '已配置。要换就粘贴新的，留空保持不变。' : '还没有密钥。'}>
        <Input type="password" autoComplete="new-password" aria-label={label} value={value}
          placeholder={configured && !cleared ? '已配置，留空不改' : '粘贴密钥'}
          onChange={(e) => change(which === 'doubao' ? { doubaoKey: e.target.value, clearDoubao: false } : { tavilyKey: e.target.value, clearTavily: false })} />
        {configured && !cleared && (
          <span>
            <ConfirmButton label="删除密钥" question="保存后这个密钥会被删掉。" confirmLabel="标记删除"
              onConfirm={() => change(which === 'doubao' ? { clearDoubao: true, doubaoKey: '' } : { clearTavily: true, tavilyKey: '' })} />
          </span>
        )}
      </Group>
    );
  };

  return (
    <div className="mdl-editor-body">
      <header className="mdl-editor-head">
        <h2>联网搜索</h2>
        <p>聊天里需要实时信息（新闻、天气、价格）时，她会先去搜一下再回答。</p>
        <Status tone={status.tone}>{status.text}</Status>
      </header>

      <Section wide title="开关和顺序" desc="只开一个提供方时，失败了不会换别的；开了多个时按这里的顺序依次尝试。">
        <Switch checked={config.enabled} onChange={(v) => update({ enabled: v })} label="允许她联网搜索" />
        <div className="cs-list">
          {[...config.providers, ...ALL.filter((p) => !config.providers.includes(p))].map((provider) => {
            const at = config.providers.indexOf(provider);
            const on = at >= 0;
            const needsChat = provider === 'responses' && !responsesAvailable;
            const result = results[provider];
            return (
              <div className="cs-list-item" key={provider}>
                <span>
                  <Switch checked={on} onChange={(v) => toggle(provider, v)} label={<span className="cs-list-title">{WEB_SEARCH_NAMES[provider]}</span>} />
                  <span className="mdl-sub">
                    {on ? `第 ${at + 1} 个尝试` : '没有启用'}
                    {provider === 'responses' ? (responsesAvailable ? '。用聊天模型自带的搜索。' : '。需要聊天模型用 OpenAI Responses 协议，并选了“能调用工具”。') : ''}
                  </span>
                </span>
                <span className="cs-list-side">
                  <Button kind="text" size="sm" disabled={!on || at === 0} aria-label={`${WEB_SEARCH_NAMES[provider]}往前挪`} onClick={() => move(provider, -1)}>往前</Button>
                  <Button kind="text" size="sm" disabled={!on || at === config.providers.length - 1} aria-label={`${WEB_SEARCH_NAMES[provider]}往后挪`} onClick={() => move(provider, 1)}>往后</Button>
                  <Button kind="quiet" size="sm" busy={busy === `test-${provider}`} disabled={needsChat || (busy !== null && busy !== `test-${provider}`)}
                    aria-label={`测试${WEB_SEARCH_NAMES[provider]}`} onClick={() => void test(provider)}>测试</Button>
                </span>
                {result && <span className="cs-list-body"><Status tone={result.ok ? 'ok' : 'bad'}>{result.text}</Status></span>}
              </div>
            );
          })}
        </div>
        <div data-no-dirty>
          <Field label="测试时搜什么" hint={dirty ? '测试用的是已保存的设置，有修改要先保存。' : '测试用的是已保存的设置。'}>
            <Input value={query} maxLength={300} onChange={(e) => setQuery(e.target.value)} />
          </Field>
        </div>
      </Section>

      <Section wide title="提供方设置">
        <Fields>
          {keyField('doubao')}
          <Field label="豆包版本">
            <Select value={config.doubao.edition} onChange={(e) => update({ doubao: { ...config.doubao, edition: e.target.value as 'custom' | 'global' } })}
              options={[{ value: 'custom', label: 'Custom' }, { value: 'global', label: 'Global' }]} />
          </Field>
          <Field label="豆包接口地址" full>
            <Input type="url" value={config.doubao.baseUrl} onChange={(e) => update({ doubao: { ...config.doubao, baseUrl: e.target.value } })} />
          </Field>
          {keyField('tavily')}
          <Field label="Tavily 接口地址">
            <Input type="url" value={config.tavily.baseUrl} onChange={(e) => update({ tavily: { ...config.tavily, baseUrl: e.target.value } })} />
          </Field>
          <Field label="每次最多取几条结果">
            <NumberInput value={config.maxResults} min={1} max={20} onValue={(v) => update({ maxResults: v as number })} />
          </Field>
          <Field label="单次搜索超时（毫秒）">
            <NumberInput value={config.timeoutMs} min={1000} max={120000} step={1000} onValue={(v) => update({ timeoutMs: v as number })} />
          </Field>
        </Fields>
        {config.providers.length === 0 && <Callout tone="warn">至少要启用一个提供方才能保存。不想让她搜索，关掉上面的开关就行。</Callout>}
        <div className="cs-actions">
          <Button busy={busy === 'save'} disabled={!dirty || config.providers.length === 0} onClick={() => void save()}>保存联网搜索设置</Button>
          {dirty && <Button kind="text" onClick={() => setDraft(undefined)}>放弃修改</Button>}
          {!dirty && <span className="cs-muted">没有未保存的修改。</span>}
        </div>
      </Section>
    </div>
  );
}
