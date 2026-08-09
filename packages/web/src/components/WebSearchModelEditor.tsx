import { useEffect, useState } from 'react';
import {
  adminApi,
  type AdminModels,
  type AdminWebSearchConfig,
  type AdminWebSearchProvider
} from '../lib/admin.js';

const PROVIDERS: Array<{ id: AdminWebSearchProvider; label: string }> = [
  { id: 'doubao', label: '豆包' },
  { id: 'tavily', label: 'Tavily' },
  { id: 'responses', label: 'Responses' }
];

export function WebSearchModelEditor({
  config,
  responsesAvailable,
  onSaved,
  onNotice
}: {
  config: AdminWebSearchConfig;
  responsesAvailable: boolean;
  onSaved: (models: AdminModels) => void;
  onNotice: (message: string) => void;
}) {
  const [draft, setDraft] = useState<AdminWebSearchConfig>(config);
  const [doubaoKey, setDoubaoKey] = useState('');
  const [tavilyKey, setTavilyKey] = useState('');
  const [clearDoubao, setClearDoubao] = useState(false);
  const [clearTavily, setClearTavily] = useState(false);
  const [query, setQuery] = useState('OpenAI');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<AdminWebSearchProvider | null>(null);
  const [testResult, setTestResult] = useState('');

  useEffect(() => setDraft(config), [config]);

  const update = (patch: Partial<AdminWebSearchConfig>) => setDraft((current) => ({ ...current, ...patch }));
  const toggleProvider = (provider: AdminWebSearchProvider, enabled: boolean) => {
    update({
      providers: enabled
        ? [...draft.providers, provider].filter((value, index, list) => list.indexOf(value) === index)
        : draft.providers.filter((value) => value !== provider)
    });
  };
  const moveProvider = (provider: AdminWebSearchProvider, direction: -1 | 1) => {
    const index = draft.providers.indexOf(provider);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= draft.providers.length) return;
    const providers = [...draft.providers];
    [providers[index], providers[target]] = [providers[target]!, providers[index]!];
    update({ providers });
  };

  const save = async () => {
    setBusy(true);
    try {
      const { apiKey: _doubaoApiKey, apiKeyConfigured: _doubaoConfigured, ...doubao } = draft.doubao;
      const { apiKey: _tavilyApiKey, apiKeyConfigured: _tavilyConfigured, ...tavily } = draft.tavily;
      const patch: AdminWebSearchConfig = {
        ...draft,
        doubao: {
          ...doubao,
          ...(doubaoKey.trim() ? { apiKey: doubaoKey.trim() } : clearDoubao ? { apiKey: '' } : {})
        },
        tavily: {
          ...tavily,
          ...(tavilyKey.trim() ? { apiKey: tavilyKey.trim() } : clearTavily ? { apiKey: '' } : {})
        }
      };
      const result = await adminApi.updateModels({ webSearch: patch });
      onSaved(result.models);
      setDoubaoKey('');
      setTavilyKey('');
      setClearDoubao(false);
      setClearTavily(false);
      setTestResult('');
      onNotice('联网搜索配置已保存并生效');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '保存联网搜索配置失败');
    } finally {
      setBusy(false);
    }
  };

  const test = async (provider: AdminWebSearchProvider) => {
    setTesting(provider);
    setTestResult('');
    try {
      const result = await adminApi.testWebSearch(provider, query.trim() || 'OpenAI');
      const text = `${PROVIDERS.find((item) => item.id === provider)?.label ?? provider}：连接正常，${result.resultCount} 条结果，耗时 ${result.latencyMs} ms`;
      setTestResult(text);
      onNotice(text);
    } catch (error) {
      const text = error instanceof Error ? error.message : '搜索测试失败';
      setTestResult(text);
      onNotice(text);
    } finally {
      setTesting(null);
    }
  };

  return (
    <section className="admin-web-search-editor" data-testid="admin-web-search-editor">
      <label className="admin-form-wide admin-toggle-row">
        <input aria-label="启用联网搜索" type="checkbox" checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
        启用联网搜索
      </label>

      <div className="admin-form-wide admin-search-providers">
        <strong>搜索提供方与回退顺序</strong>
        <small>只启用一个时不会隐式回退；启用多个时按这里的顺序尝试。</small>
        {PROVIDERS.map(({ id, label }) => {
          const active = draft.providers.includes(id);
          const index = draft.providers.indexOf(id);
          return (
            <div className={active ? 'admin-search-provider active' : 'admin-search-provider'} key={id}>
              <label><input type="checkbox" checked={active} onChange={(event) => toggleProvider(id, event.target.checked)} />{label}</label>
              <span>{active ? `第 ${index + 1} 个` : '未启用'}</span>
              <button type="button" aria-label={`上移 ${label}`} disabled={!active || index === 0} onClick={() => moveProvider(id, -1)}>↑</button>
              <button type="button" aria-label={`下移 ${label}`} disabled={!active || index === draft.providers.length - 1} onClick={() => moveProvider(id, 1)}>↓</button>
              <button type="button" aria-label={`测试${label}`} disabled={testing !== null || (id === 'responses' && !responsesAvailable)} onClick={() => void test(id)}>{testing === id ? '测试中…' : '测试'}</button>
            </div>
          );
        })}
        <small>{responsesAvailable ? 'Responses 将使用当前聊天模型的原生 web_search。' : 'Responses 需要聊天模型使用 openai-responses，并声明支持工具。'}</small>
      </div>

      <label>最大结果数<input type="number" min="1" max="20" value={draft.maxResults} onChange={(event) => update({ maxResults: Number(event.target.value) })} /></label>
      <label>请求超时（毫秒）<input type="number" min="1000" max="120000" value={draft.timeoutMs} onChange={(event) => update({ timeoutMs: Number(event.target.value) })} /></label>

      <label>豆包版本<select aria-label="豆包版本" value={draft.doubao.edition} onChange={(event) => update({ doubao: { ...draft.doubao, edition: event.target.value as 'custom' | 'global' } })}>
        <option value="custom">Custom</option>
        <option value="global">Global</option>
      </select></label>
      <label>
        豆包 API Key
        <input type="password" autoComplete="off" value={doubaoKey} placeholder={draft.doubao.apiKeyConfigured ? '已配置，留空则不改' : '粘贴密钥'} onChange={(event) => { setDoubaoKey(event.target.value); setClearDoubao(false); }} />
        <small>{clearDoubao ? '保存后删除当前密钥' : draft.doubao.apiKeyConfigured ? '已配置' : '未配置'}</small>
        {draft.doubao.apiKeyConfigured && <button type="button" className="admin-link-button" onClick={() => { setClearDoubao(true); setDoubaoKey(''); }}>删除密钥</button>}
      </label>
      <label>
        Tavily API Key
        <input type="password" autoComplete="off" value={tavilyKey} placeholder={draft.tavily.apiKeyConfigured ? '已配置，留空则不改' : '粘贴密钥'} onChange={(event) => { setTavilyKey(event.target.value); setClearTavily(false); }} />
        <small>{clearTavily ? '保存后删除当前密钥' : draft.tavily.apiKeyConfigured ? '已配置' : '未配置'}</small>
        {draft.tavily.apiKeyConfigured && <button type="button" className="admin-link-button" onClick={() => { setClearTavily(true); setTavilyKey(''); }}>删除密钥</button>}
      </label>

      <details className="admin-form-wide admin-search-advanced">
        <summary>高级设置</summary>
        <label>豆包接口地址<input value={draft.doubao.baseUrl} onChange={(event) => update({ doubao: { ...draft.doubao, baseUrl: event.target.value } })} /></label>
        <label>Tavily 接口地址<input value={draft.tavily.baseUrl} onChange={(event) => update({ tavily: { ...draft.tavily, baseUrl: event.target.value } })} /></label>
      </details>

      <label className="admin-form-wide">测试关键词<input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="admin-actions admin-form-wide">
        <button type="button" data-testid="save-web-search" disabled={busy || draft.providers.length === 0} onClick={() => void save()}>{busy ? '保存中…' : '保存搜索配置'}</button>
      </div>
      {testResult && <p className="admin-test-result" data-testid="web-search-test-result">{testResult}</p>}
    </section>
  );
}
