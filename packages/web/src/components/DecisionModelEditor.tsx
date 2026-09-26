import { useEffect, useState } from 'react';
import { adminApi, type AdminModels } from '../lib/admin.js';

const defaults = { enabled: false, provider: 'aliyun-beijing', baseUrl: '', model: 'decision-model-preview', timeoutMs: 2000, memorySaveThreshold: 0.85, memoryReviewThreshold: 0.55, mediaThreshold: 0.85 };
export function DecisionModelEditor({ config, onSaved, onNotice }: {
  config?: Record<string, unknown>; onSaved: (models: AdminModels) => void; onNotice: (message: string) => void;
}) {
  const [draft, setDraft] = useState({ ...defaults, ...config });
  const [key, setKey] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState('记住我喜欢简洁的回答，这次请用语音讲给我听。');
  const [result, setResult] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setDraft({ ...defaults, ...config }); setDirty(false); setResult(''); }, [config]);
  const update = (patch: Partial<typeof defaults>) => { setDraft((old) => ({ ...old, ...patch })); setDirty(true); setResult(''); };
  const choose = (provider: string) => {
    setKey(''); setWorkspace('');
    update({ provider, baseUrl: provider === 'typesafe' ? 'https://api.typesafe.ai/v1' : '', model: provider === 'typesafe' ? 'jev-latest' : 'decision-model-preview' });
  };
  const save = async () => {
    setBusy(true);
    try {
      const changedProvider = draft.provider !== (config?.provider ?? defaults.provider);
      const response = await adminApi.updateModels({ decision: { ...draft, ...(key.trim() ? { apiKey: key.trim() } : changedProvider ? { apiKey: '' } : {}) } });
      setKey(''); onSaved(response.models); setDirty(false); onNotice('行为决策配置已保存');
    } catch (error) { onNotice(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setResult('');
    try {
      const response = await adminApi.testBehaviorDecision(sample);
      const names: Record<string, string> = { memory: '记忆', image: '图片', video: '视频', voice: '语音' };
      const memory: Record<string, string> = { save: '照常进入记忆流程（高置信）', review: '照常进入记忆流程', skip: '跳过本轮自动记忆' };
      setResult(response.ok ? `${memory[response.result.memory]}。${Object.entries(response.result.probabilities ?? {}).map(([name, value]) => `${names[name] ?? name} ${(value * 100).toFixed(1)}%`).join(' · ')}`
        : response.result.status === 'unconfigured' ? '请先保存接口地址和密钥。' : '决策服务未返回有效结果，请检查地址、密钥和超时时间。聊天会继续使用原流程。');
    } catch (error) { setResult(error instanceof Error ? error.message : '测试失败'); }
    finally { setBusy(false); }
  };
  return <>
    <div className="admin-panel-heading"><div><h2>行为决策</h2><p>判断是否进入记忆流程，以及是否使用图片、视频和语音。明确请求优先；判断不确定或服务不可用时，由现有流程继续处理。</p></div></div>
    <label className="admin-form-wide admin-toggle-row"><input type="checkbox" checked={Boolean(draft.enabled)} onChange={(e) => update({ enabled: e.target.checked })} />启用行为决策</label>
    <label>服务提供方<select value={draft.provider} onChange={(e) => choose(e.target.value)}>
      <option value="aliyun-beijing">阿里百炼（北京）</option><option value="aliyun-singapore">阿里百炼（新加坡）</option><option value="typesafe">TypeSafe Jev</option><option value="custom">自定义 System One 接口</option>
    </select></label>
    {draft.provider.startsWith('aliyun-') && <label>Workspace ID（用于生成接口地址）<input value={workspace} onChange={(e) => {
      const value = e.target.value.trim(); setWorkspace(value);
      if (/^[a-zA-Z0-9_-]+$/.test(value)) update({ baseUrl: `https://${value}.${draft.provider === 'aliyun-beijing' ? 'cn-beijing' : 'ap-southeast-1'}.maas.aliyuncs.com/compatible-mode/v1` });
    }} /></label>}
    <label className="admin-form-wide">接口地址<input type="url" value={draft.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })} placeholder="https://api.typesafe.ai/v1" /></label>
    <label>模型名<input value={draft.model} onChange={(e) => update({ model: e.target.value })} /></label>
    <label>API Key<input type="password" autoComplete="new-password" value={key} placeholder={config?.apiKeyConfigured && draft.provider === config.provider ? '已配置，留空保持原密钥' : '填写当前提供方的密钥'} onChange={(e) => { setKey(e.target.value); setDirty(true); }} /></label>
    <p className="admin-muted">切换提供方需重新填写密钥。测试只返回判断结果，不会写入记忆或生成媒体。</p>
    <label>超时（毫秒）<input type="number" min="250" max="15000" value={draft.timeoutMs} onChange={(e) => update({ timeoutMs: Number(e.target.value) })} /></label>
    <label>记忆跳过阈值<input type="number" min="0" max={draft.memorySaveThreshold} step="0.01" value={draft.memoryReviewThreshold} onChange={(e) => update({ memoryReviewThreshold: Number(e.target.value) })} /></label>
    <label>媒体判断阈值<input type="number" min="0.51" max="1" step="0.01" value={draft.mediaThreshold} onChange={(e) => update({ mediaThreshold: Number(e.target.value) })} /></label>
    <p className="admin-muted">记忆概率低于跳过阈值时，本轮不做自动记忆提取；其余情况照常交给现有记忆流程判断和保存。媒体概率高于阈值时建议使用，低于 1 减阈值时不主动使用，中间区间由主模型决定。概率不是正确率保证。</p>
    <div className="admin-actions admin-form-wide"><button type="button" disabled={busy} onClick={() => void save()}>保存行为决策配置</button></div>
    <label className="admin-form-wide">测试消息<textarea value={sample} onChange={(e) => { setSample(e.target.value); setResult(''); }} maxLength={4000} /></label>
    <div className="admin-actions admin-form-wide"><button type="button" disabled={busy || dirty || !sample.trim()} onClick={() => void test()}>{busy ? '处理中…' : '测试已保存配置'}</button></div>
    {dirty && <p className="admin-muted">保存后即可测试。</p>}
    {result && <p role="status">{result}</p>}
  </>;
}
