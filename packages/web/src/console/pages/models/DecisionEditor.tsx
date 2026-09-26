import { useState } from 'react';
import { adminApi, type AdminModels } from '../../../lib/admin.js';
import {
  Button, Callout, Facts, Field, Fields, Input, Section, Select, Status, Switch, TextArea, useAction
} from '../../ui.js';
import { NumberInput, decisionStatus, pct, rec, str, stripStatus, type Rec } from './shared.js';

export interface DecisionDraft { config: Rec; key: string; workspace: string }

/** Same defaults the server schema uses, so a fresh install shows real values. */
const DEFAULTS: Rec = {
  enabled: false, provider: 'aliyun-beijing', baseUrl: '', model: 'decision-model-preview', timeoutMs: 2000,
  memorySaveThreshold: 0.85, memoryReviewThreshold: 0.55, mediaThreshold: 0.85
};

const PROVIDERS = [
  { value: 'aliyun-beijing', label: '阿里百炼（北京）' },
  { value: 'aliyun-singapore', label: '阿里百炼（新加坡）' },
  { value: 'typesafe', label: 'TypeSafe Jev' },
  { value: 'custom', label: '自定义 System One 接口' }
];

const MEMORY_VERDICT: Record<string, string> = {
  save: '这轮会照常进入记忆流程（把握很大）',
  review: '这轮会照常进入记忆流程',
  skip: '这轮会跳过自动记忆'
};
const PROBABILITY_NAMES: Record<string, string> = { memory: '值得记住', image: '适合发图', video: '适合发视频', voice: '适合发语音' };

export function DecisionEditor({ models, draft, setDraft, onSaved }: {
  models: AdminModels;
  draft: DecisionDraft | undefined;
  setDraft: (next: DecisionDraft | undefined) => void;
  onSaved: (models: AdminModels) => void;
}) {
  const { run, busy } = useAction();
  const saved: Rec = { ...DEFAULTS, ...(rec(models.decision) ?? {}) };
  const d: DecisionDraft = draft ?? { config: saved, key: '', workspace: '' };
  const config = d.config;
  const dirty = draft !== undefined;
  const provider = str(config.provider);
  const providerChanged = provider !== str(saved.provider);
  const saveThreshold = Number(saved.memorySaveThreshold ?? 0.85);
  const status = decisionStatus(rec(models.decision));

  const [sample, setSample] = useState('记住我喜欢简洁的回答，这次请用语音讲给我听。');
  const [result, setResult] = useState<{ ok: boolean; text: string; probabilities?: Record<string, number> } | null>(null);

  const change = (patch: Partial<DecisionDraft>) => { setDraft({ ...d, ...patch }); setResult(null); };
  const update = (patch: Rec) => change({ config: { ...config, ...patch } });

  /** A key belongs to one provider, so switching provider starts from an empty key. */
  const choose = (next: string) => change({
    key: '',
    workspace: '',
    config: {
      ...config,
      provider: next,
      baseUrl: next === 'typesafe' ? 'https://api.typesafe.ai/v1' : '',
      model: next === 'typesafe' ? 'jev-latest' : 'decision-model-preview'
    }
  });

  const setWorkspace = (raw: string) => {
    const value = raw.trim();
    const patch: Partial<DecisionDraft> = { workspace: value };
    if (/^[a-zA-Z0-9_-]+$/.test(value)) {
      const region = provider === 'aliyun-beijing' ? 'cn-beijing' : 'ap-southeast-1';
      patch.config = { ...config, baseUrl: `https://${value}.${region}.maas.aliyuncs.com/compatible-mode/v1` };
    }
    change(patch);
  };

  const save = () => run('save', async () => {
    const typed = d.key.trim();
    const response = await adminApi.updateModels({
      decision: { ...stripStatus(config), ...(typed ? { apiKey: typed } : providerChanged ? { apiKey: '' } : {}) }
    });
    setDraft(undefined);
    onSaved(response.models);
  }, '行为决策设置已保存');

  const test = () => run('test', async () => {
    setResult(null);
    const response = await adminApi.testBehaviorDecision(sample.trim());
    if (response.ok) {
      setResult({ ok: true, text: `${MEMORY_VERDICT[response.result.memory] ?? response.result.memory}。`, probabilities: response.result.probabilities });
    } else if (response.result.status === 'unconfigured') {
      setResult({ ok: false, text: '还没有可用的接口地址和密钥。填好并保存后再测。' });
    } else {
      setResult({ ok: false, text: '决策服务没有返回有效结果。检查接口地址、密钥和超时时间；在它恢复之前，聊天会照原来的流程走。' });
    }
  });

  const keyConfigured = saved.apiKeyConfigured === true && !providerChanged;

  return (
    <div className="mdl-editor-body">
      <header className="mdl-editor-head">
        <h2>行为决策</h2>
        <p>每轮聊天前先快速判断一次：这轮值不值得记下来，适不适合发图、发视频、发语音。你明确要求的优先；判断拿不准或服务不可用时，照原来的流程走。</p>
        <Status tone={status.tone}>{status.text}</Status>
      </header>

      <Section wide title="服务" desc="切换提供方后需要重新填写密钥。">
        <Switch checked={config.enabled === true} onChange={(v) => update({ enabled: v })} label="启用行为决策" />
        <Fields>
          <Field label="服务提供方">
            <Select value={provider} onChange={(e) => choose(e.target.value)} options={PROVIDERS} />
          </Field>
          {provider.startsWith('aliyun-') && (
            <Field label="Workspace ID" hint="填了会自动生成下面的接口地址。">
              <Input value={d.workspace} onChange={(e) => setWorkspace(e.target.value)} />
            </Field>
          )}
          <Field label="接口地址" full>
            <Input type="url" value={str(config.baseUrl)} placeholder="https://api.typesafe.ai/v1" onChange={(e) => update({ baseUrl: e.target.value })} />
          </Field>
          <Field label="模型名">
            <Input value={str(config.model)} onChange={(e) => update({ model: e.target.value })} />
          </Field>
          <Field label="API 密钥" hint={providerChanged ? '换了提供方，原来的密钥不会沿用，保存时会清空。' : keyConfigured ? '已配置。要换就粘贴新的，留空保持不变。' : '还没有密钥。'}>
            <Input type="password" autoComplete="new-password" value={d.key}
              placeholder={keyConfigured ? '已配置，留空不改' : '填写这个提供方的密钥'}
              onChange={(e) => setDraft({ ...d, key: e.target.value })} />
          </Field>
          <Field label="超时（毫秒）" hint="判断要快，超时就照原流程走。">
            <NumberInput value={config.timeoutMs} min={250} max={15000} step={250} onValue={(v) => update({ timeoutMs: v })} />
          </Field>
        </Fields>
      </Section>

      <Section wide title="阈值" desc="概率只是模型的判断，不代表一定正确。">
        <Fields>
          <Field label="记忆跳过阈值" hint={`“值得记住”的概率低于它时，这轮不做自动记忆；其余情况照常交给记忆流程。最大 ${saveThreshold}。`}>
            <NumberInput value={config.memoryReviewThreshold} min={0} max={saveThreshold} step={0.01} onValue={(v) => update({ memoryReviewThreshold: v })} />
          </Field>
          <Field label="媒体判断阈值" hint="发图、视频、语音的概率高于它时建议用；低于 1 减去它时不主动用；中间交给主模型决定。范围 0.51 到 1。">
            <NumberInput value={config.mediaThreshold} min={0.51} max={1} step={0.01} onValue={(v) => update({ mediaThreshold: v })} />
          </Field>
        </Fields>
        <div className="cs-actions">
          <Button busy={busy === 'save'} disabled={!dirty} onClick={() => void save()}>保存行为决策设置</Button>
          {dirty && <Button kind="text" onClick={() => setDraft(undefined)}>放弃修改</Button>}
          {!dirty && <span className="cs-muted">没有未保存的修改。</span>}
        </div>
      </Section>

      <Section wide title="试一句话" desc="只返回判断结果，不会写入记忆，也不会生成图片或语音。">
        <div data-no-dirty>
          <Field label="测试消息" full>
            <TextArea rows={3} value={sample} maxLength={4000} onChange={(e) => { setSample(e.target.value); setResult(null); }} />
          </Field>
        </div>
        <div className="cs-actions">
          <Button kind="quiet" busy={busy === 'test'} disabled={dirty || !sample.trim()} onClick={() => void test()}>测试已保存配置</Button>
          {dirty && <span className="cs-muted">有未保存的修改，保存后才能测试。</span>}
        </div>
        {result && (
          <Callout tone={result.ok ? 'ok' : 'warn'}>
            {result.text}
            {result.probabilities && Object.keys(result.probabilities).length > 0 && (
              <div className="mdl-facts">
                <Facts items={Object.entries(result.probabilities).map(([k, v]) => [PROBABILITY_NAMES[k] ?? k, pct(v)])} />
              </div>
            )}
          </Callout>
        )}
      </Section>
    </div>
  );
}
