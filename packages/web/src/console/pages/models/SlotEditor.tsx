import { useEffect, useRef, useState, type ReactNode } from 'react';
import { adminApi, type AdminModels } from '../../../lib/admin.js';
import { featureApi } from '../../../lib/features.js';
import { interfaceOptions, PROVIDER_LABELS, presetFromConfig, type ModelPreset, type ModelSlot } from '../../../lib/modelPresets.js';
import { consolePath } from '../../routes.js';
import {
  Button, Callout, ConfirmButton, Empty, Field, Fields, Input, Section, Select, Status, Switch, TextArea, errorMessage, useAction, useConsole
} from '../../ui.js';
import {
  CHAT_LIKE, CostButton, Group, INHERITING, NumberInput, SLOT_ABOUT, SLOT_NAMES, rec, slotStatus, str, stripStatus, type Rec
} from './shared.js';

export interface SlotDraft { config: Rec; key: string }

/** Server messages are mostly Chinese already; bare English ones (e.g. "fetch failed") get context. */
function plain(error: unknown, what: string, next: string): string {
  const message = errorMessage(error);
  return /[一-鿿]/.test(message) ? message : `${what}：${message}。${next}`;
}

const EMOTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'warm', label: '温暖' },
  { value: 'happy', label: '开心' },
  { value: 'gentle', label: '温柔' },
  { value: 'sleepy', label: '困倦' },
  { value: 'playful', label: '俏皮' },
  { value: 'serious', label: '认真' },
  { value: 'shy', label: '害羞' },
  { value: 'reassuring', label: '安抚' },
  { value: 'neutral', label: '平静' }
];

export function SlotEditor({ slot, models, draft, setDraft, onSaved, presets, presetsError, onPresetsChanged }: {
  slot: ModelSlot;
  models: AdminModels;
  draft: SlotDraft | undefined;
  setDraft: (next: SlotDraft | undefined) => void;
  onSaved: (models: AdminModels) => void;
  presets: ModelPreset[] | null;
  presetsError?: string | null;
  onPresetsChanged: () => Promise<void>;
}) {
  const { notify, navigate } = useConsole();
  const { run, busy } = useAction();
  const own = rec(models[slot]);
  const saved = own ?? {};
  const config = draft?.config ?? saved;
  const key = draft?.key ?? '';
  const dirty = draft !== undefined;
  const name = SLOT_NAMES[slot];
  const status = slotStatus(slot, models);
  const provider = str(config.provider) || 'none';
  const savedProvider = str(saved.provider) || 'none';
  const inheriting = INHERITING.has(slot) && !own;
  const legacySticker = slot === 'director' && !own ? rec(models.sticker) : undefined;
  const chat = rec(models.chat) ?? {};

  const [available, setAvailable] = useState<string[] | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setAvailable(null); setResult(null); }, [slot]);

  const update = (patch: Rec) => { setDraft({ config: { ...config, ...patch }, key }); setResult(null); };
  const setKey = (value: string) => setDraft({ config, key: value });

  const save = () => run('save', async () => {
    const typed = key.trim();
    const response = await adminApi.updateModels({ [slot]: { ...stripStatus(config), ...(typed ? { apiKey: typed } : {}) } });
    setDraft(undefined);
    setResult(null);
    onSaved(response.models);
  }, `${name}模型设置已保存`);

  const discover = () => {
    if (key.trim() || provider !== savedProvider) {
      notify(`拉取用的是已保存的接口协议和密钥。先点「保存${name}设置」，再拉取。`, 'bad');
      return;
    }
    if (savedProvider === 'none') {
      notify('先选好接口协议并保存，再拉取可用模型。', 'bad');
      return;
    }
    return run('discover', async () => {
      const response = await adminApi.discoverModels(slot, str(config.baseUrl).trim() || undefined)
        .catch((e: unknown) => { throw new Error(plain(e, '拉取模型列表失败', '检查接口地址能不能从服务器访问。')); });
      setAvailable(response.models);
      notify(`拉取到 ${response.models.length} 个模型，点模型名输入框就能选`, 'ok');
    });
  };

  const test = () => {
    setResult(null);
    return run('test', async () => {
      try {
        const r = await adminApi.testModel(slot, slot === 'image');
        setResult({ ok: true, text: `连接正常：${r.provider}${r.model ? `，模型 ${r.model}` : ''}。${r.detail}，用时 ${r.latencyMs} 毫秒。` });
      } catch (e) {
        setResult({ ok: false, text: plain(e, '连接测试没有通过', '检查接口地址、密钥和模型名。') });
      }
    });
  };

  const saveAsPreset = () => run('preset', async () => {
    const current = await adminApi.modelPresets();
    const next = presetFromConfig(slot, saved, current.presets);
    if (typeof next === 'string') throw new Error(next);
    const preset = { ...next, name: `${name}：${str(saved.model).trim()}`.slice(0, 80) };
    await adminApi.addModelPreset(preset);
    await onPresetsChanged();
    notify(`已存为预设：${preset.name}`, 'ok');
  });

  const apply = (preset: ModelPreset) => run(`apply-${preset.id}`, async () => {
    const response = await adminApi.applyModelPreset(preset.id);
    setDraft(undefined);
    onSaved(response.models);
  }, `已把「${preset.name}」用在${SLOT_NAMES[preset.slot]}上`);

  const slotPresets = (presets ?? []).filter((p) => p.slot === slot);
  const isImageApi = slot === 'image' && (provider === 'openai-compatible' || provider === 'openai-images');
  const isFish = slot === 'tts' && provider === 'fish';
  const n = (field: string, label: string, props: { min?: number; max?: number; step?: number; hint?: ReactNode; placeholder?: string } = {}) => (
    <Field label={label} hint={props.hint}>
      <NumberInput value={config[field]} min={props.min} max={props.max} step={props.step} placeholder={props.placeholder}
        onValue={(value) => update({ [field]: value })} />
    </Field>
  );

  return (
    <div className="mdl-editor-body">
      <header className="mdl-editor-head">
        <h2>{name}</h2>
        <p>{SLOT_ABOUT[slot]}</p>
        <Status tone={status.tone}>{status.text}</Status>
      </header>

      {legacySticker ? (
        <Callout>
          现在用的是旧版的表情模型设置（{str(legacySticker.model) || '未填模型名'}）。在这里保存一次，就会改用新的媒体导演设置。
        </Callout>
      ) : inheriting ? (
        <Callout>
          现在跟随聊天模型{str(chat.model) ? `（${str(chat.model)}）` : '，但聊天模型还没配好'}。
          {slot === 'vision' && chat.supportsVision !== true ? '聊天模型没有声明能读图，所以她现在看不了图片。' : ''}
          在下面填好并保存后，{name}会改用单独的模型，之后不再跟随聊天模型。
        </Callout>
      ) : null}

      <Section wide title="服务" desc="接口地址填到 /v1 这一级即可。密钥只保存在服务器上，这里不会显示。">
        <Fields>
          <Field label="接口协议">
            <Select value={provider} onChange={(e) => update({ provider: e.target.value })}
              options={interfaceOptions(slot, config.provider == null ? null : str(config.provider))} />
          </Field>
          <Field label="接口地址" hint={isImageApi ? 'NewAPI 填到 /v1，不要填 /images/generations。' : slot === 'video' ? '填到 /v1，不要填 /videos。' : undefined}>
            <Input value={str(config.baseUrl)} placeholder={isImageApi ? 'https://你的 NewAPI 地址/v1' : 'https://…/v1'}
              onChange={(e) => update({ baseUrl: e.target.value })} />
          </Field>
          <Field label="API 密钥" hint={saved.apiKeyConfigured ? '已配置。要换就粘贴新的，留空保持不变。' : '还没有密钥，粘贴后保存。'}>
            <Input type="password" autoComplete="new-password" value={key}
              placeholder={saved.apiKeyConfigured ? '已配置，留空不改' : '粘贴密钥'}
              onChange={(e) => setKey(e.target.value)} />
          </Field>
          {(slot === 'tts' || slot === 'video') && (
            <Field label="从环境变量读取密钥（可选）" hint={isFish ? '例如 FISH_API_KEY。填了之后密钥不写进配置文件。' : '填变量名后，密钥从服务器环境变量读取，不写进配置文件。'}>
              <Input value={str(config.apiKeyEnv)} placeholder={isFish ? 'FISH_API_KEY' : '不用就留空'} onChange={(e) => update({ apiKeyEnv: e.target.value })} />
            </Field>
          )}
          {isImageApi && (
            <Field label="New-Api-User（可选）" hint="只有 NewAPI 拉取模型列表要求用户 ID 时才填，不清楚就留空。">
              <Input value={str(config.newApiUserId)} placeholder="NewAPI 用户 ID" onChange={(e) => update({ newApiUserId: e.target.value })} />
            </Field>
          )}
          <Field label="模型名" full hint={available
            ? `拉取到 ${available.length} 个模型，点输入框可以直接选；列表不一定全，也可以手填。`
            : '可以手填，也可以从接口拉取这个服务提供的模型。'}>
            <span className="mdl-inline">
              <Input list={`mdl-models-${slot}`} value={str(config.model)} onChange={(e) => update({ model: e.target.value })} />
              <Button kind="quiet" busy={busy === 'discover'} onClick={() => void discover()}>拉取可用模型</Button>
            </span>
            <datalist id={`mdl-models-${slot}`}>
              {(available ?? []).map((m) => <option key={m} value={m} />)}
            </datalist>
          </Field>
        </Fields>
      </Section>

      <Section wide title="参数" desc="不清楚的保持默认就好。">
        <Fields>
          {n('timeoutMs', '单次请求超时（毫秒）', { min: 1000, step: 1000 })}
          {slot !== 'tts' && n('maxRetries', '失败后重试次数', { min: 0, max: 5 })}
          {CHAT_LIKE.has(slot) && <>
            {n('maxTokens', '单次最多输出多少 token', { min: 16 })}
            {n('temperature', '随机程度（temperature）', { min: 0, max: 2, step: 0.1, hint: '越高越发散，越低越稳定。' })}
            {n('contextWindow', '上下文窗口（token）', { min: 1000 })}
          </>}
          {(slot === 'chat' || slot === 'vision') && (
            <Field label="这个模型能不能读图" full hint="真能读图才选“能”。谎报会让带图的回复整条失败，而不是退回纯文字。">
              <Select value={config.supportsVision === true ? 'yes' : 'no'} onChange={(e) => update({ supportsVision: e.target.value === 'yes' })}
                options={[{ value: 'no', label: '不能，发来的图片不交给它' }, { value: 'yes', label: '能读图' }]} />
            </Field>
          )}
          {slot === 'chat' && <>
            <Field label="这个模型能不能调用工具" hint="联网搜索的 Responses 方式和工具调用都需要选“能”。">
              <Select value={config.supportsTools === true ? 'yes' : 'no'} onChange={(e) => update({ supportsTools: e.target.value === 'yes' })}
                options={[{ value: 'no', label: '不能' }, { value: 'yes', label: '能调用工具' }]} />
            </Field>
            <Group label="流式输出">
              <Switch checked={config.supportsStreaming !== false} onChange={(v) => update({ supportsStreaming: v })} label="边生成边返回" />
            </Group>
          </>}
          {slot === 'embedding' && n('dimensions', '向量维度', { min: 8, max: 8192, hint: '留空用模型默认值。改了维度，旧记忆需要重建向量。' })}
          {slot === 'rerank' && n('candidateLimit', '每次送去重排的候选数', { min: 2, max: 50, hint: '先用向量找出前 N 条，再交给重排模型。' })}
          {slot === 'image' && (
            <Field label="图片尺寸">
              <Input value={str(config.size)} placeholder="1024x1024" onChange={(e) => update({ size: e.target.value })} />
            </Field>
          )}
          {slot === 'video' && <>
            <Field label="请求格式" hint="Agnes 的接口和 OpenAI 的格式不一样，选错会每次都被拒。">
              <Select value={str(config.dialect) || 'openai'} onChange={(e) => update({ dialect: e.target.value })}
                options={[{ value: 'openai', label: 'OpenAI Videos（含 NewAPI 等兼容网关）' }, { value: 'agnes', label: 'Agnes AI' }]} />
            </Field>
            <Field label="视频尺寸" hint={str(config.dialect) === 'agnes' ? 'Agnes 填 720P 这样的档位。' : '例如 1280x720 或 720x1280。'}>
              <Input value={str(config.size)} placeholder="1280x720" onChange={(e) => update({ size: e.target.value })} />
            </Field>
            {n('durationSec', '默认时长（秒）', { min: 1, max: 60 })}
            {n('pollIntervalMs', '查询进度的间隔（毫秒）', { min: 1000, max: 60000, step: 500 })}
            {n('maxWaitMs', '最长等多久（毫秒）', { min: 30000, max: 3600000, step: 60000 })}
            {n('maxActiveTasks', '同时进行的任务上限', { min: 1, max: 20 })}
          </>}
          {slot === 'tts' && <>
            {!isFish && (
              <Field label="音色">
                <Input value={str(config.voice)} onChange={(e) => update({ voice: e.target.value })} />
              </Field>
            )}
            {n('speed', '语速', { min: 0.25, max: 4, step: 0.1 })}
            <Field label="音频格式">
              <Select value={str(config.format) || 'mp3'} onChange={(e) => update({ format: e.target.value })}
                options={['mp3', 'wav', 'opus', 'aac', 'flac'].map((f) => ({ value: f, label: f }))} />
            </Field>
            {n('maxRetries', '失败后重试次数', { min: 0, max: 5 })}
            {provider === 'volc-tts' && (
              <Field label="Resource-Id" hint="火山用它决定模型版本和计费商品，必须在这里指定。">
                <Input value={str(config.resourceId)} placeholder="seed-tts-2.0" onChange={(e) => update({ resourceId: e.target.value })} />
              </Field>
            )}
            {!isFish && <>
              <Group label="带情绪地说">
                <Switch checked={config.expressive !== false} onChange={(v) => update({ expressive: v })} label="按内容自动调整语气和节奏" />
              </Group>
              <Field label="情绪怎么传给语音服务" full hint="自动模式看音色 ID 里有没有 _emo_：有就用情绪枚举，没有就用一句语气指令。换音色会自动跟着变。">
                <Select value={str(config.emotionMode) || 'auto'} onChange={(e) => update({ emotionMode: e.target.value })} options={[
                  { value: 'auto', label: '自动判断（推荐）' },
                  { value: 'instruction', label: '语气指令（豆包 2.0 指令遵循音色）' },
                  { value: 'enum', label: '情绪枚举（多情感音色，ID 带 _emo_）' },
                  { value: 'off', label: '不传情绪' }
                ]} />
              </Field>
              <Field label="语气指令" hint="有些兼容网关不认识额外字段，报错时改成关闭。">
                <Select value={str(config.instructionMode) || 'on'} onChange={(e) => update({ instructionMode: e.target.value })} options={[
                  { value: 'on', label: '发送' }, { value: 'auto', label: '自动' }, { value: 'off', label: '不发送' }
                ]} />
              </Field>
              {n('emotionIntensity', '情绪强度（0 到 1）', { min: 0, max: 1, step: 0.05 })}
              {n('emotionScale', '情绪枚举的强度（1 到 5）', { min: 1, max: 5, step: 1 })}
            </>}
            {isFish && <>
              <Field label="Fish 声线 ID（reference_id）" full hint="她固定的声音。留空就用 Fish 的默认音色。">
                <Input value={str(config.referenceId)} placeholder="例如 f729a143b9a34005bdae0b21697fa41a" onChange={(e) => update({ referenceId: e.target.value })} />
              </Field>
              {n('temperature', '采样温度', { min: 0, max: 2, step: 0.05, hint: '0.55 到 0.75 之间人设更稳。' })}
              {n('topP', 'Top-P', { min: 0, max: 1, step: 0.05 })}
              {n('chunkLength', '分块长度（字）', { min: 50, max: 500, step: 10 })}
              <Field label="延迟模式">
                <Select value={str(config.latency) || 'balanced'} onChange={(e) => update({ latency: e.target.value })} options={[
                  { value: 'balanced', label: '均衡（默认）' }, { value: 'normal', label: '标准（音质优先）' }, { value: 'low', label: '最低延迟' }
                ]} />
              </Field>
              {n('repetitionPenalty', '重复惩罚', { min: 0, max: 2, step: 0.1 })}
              {n('prosodyVolume', '音量增益', { min: -20, max: 20, step: 1, hint: '0 表示不增益。' })}
              <Group label="朗读处理" full>
                <span className="mdl-switches">
                  <Switch checked={config.normalize !== false} onChange={(v) => update({ normalize: v })} label="数字和单位读得更准" />
                  <Switch checked={config.normalizeLoudness !== false} onChange={(v) => update({ normalizeLoudness: v })} label="每段音量保持一致" />
                  <Switch checked={config.conditionOnPreviousChunks !== false} onChange={(v) => update({ conditionOnPreviousChunks: v })} label="长文本前后音色一致" />
                </span>
              </Group>
            </>}
          </>}
        </Fields>
        <div className="cs-actions">
          <Button busy={busy === 'save'} disabled={!dirty} onClick={() => void save()}>保存{name}设置</Button>
          {dirty && <Button kind="text" onClick={() => setDraft(undefined)}>放弃修改</Button>}
          {!dirty && <span className="cs-muted">没有未保存的修改。</span>}
        </div>
      </Section>

      <Section wide title="连接测试" desc="用已保存的配置真实请求一次，确认地址、密钥和模型名都对。">
        {slot === 'video' ? (
          <Empty action={<Button kind="quiet" size="sm" onClick={() => navigate(consolePath('video'))}>去视频生成页提交一次</Button>}>
            视频生成按次计费、要等好几分钟，这里不做连接测试。先用「拉取可用模型」确认地址和密钥能通，再去视频生成页真实生成一次。
          </Empty>
        ) : (
          <>
            {dirty && <p className="cs-muted">有未保存的修改。测试只用已保存的配置，先保存再测。</p>}
            <div className="cs-actions">
              {slot === 'image' ? (
                <CostButton label="测试出图（会消耗一次额度）" question="会真实生成一张图，扣一次生图额度。" confirmLabel="确认出图"
                  busy={busy === 'test'} disabled={dirty} onConfirm={test} />
              ) : (
                <Button kind="quiet" busy={busy === 'test'} disabled={dirty} onClick={() => void test()}>测试连接</Button>
              )}
            </div>
            {result && <Callout tone={result.ok ? 'ok' : 'bad'}>{result.text}</Callout>}
          </>
        )}
      </Section>

      {slot === 'tts' && <VoicePreview dirty={dirty} />}

      <Section wide title="预设" desc="把现在已保存的配置存成预设，以后可以一键切回来。密钥会跟着预设保存在服务器上。">
        {presets === null ? (presetsError
          ? <Callout tone="bad">模型库读取失败：{presetsError}<Button kind="text" size="sm" onClick={() => void onPresetsChanged()}>重试</Button></Callout>
          : <p className="cs-muted">正在读取模型库…</p>) : slotPresets.length === 0 ? (
          <Empty>{name}还没有预设。配好并保存后，点「存为预设」。</Empty>
        ) : (
          <div className="cs-list mdl-presets">
            {slotPresets.map((preset) => (
              <div className="cs-list-item" key={preset.id}>
                <span>
                  <span className="cs-list-title">{preset.name}</span>
                  <span className="mdl-sub">{preset.model}，{PROVIDER_LABELS[preset.provider] ?? preset.provider}</span>
                </span>
                <span className="cs-actions">
                  <ConfirmButton label="应用" confirmLabel="替换并应用" busy={busy === `apply-${preset.id}`}
                    question={dirty ? `会替换${name}现在的配置，未保存的修改也会丢掉。` : `会替换${name}现在的配置。`}
                    onConfirm={() => apply(preset)} />
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="cs-actions">
          <Button kind="quiet" busy={busy === 'preset'} disabled={dirty || inheriting} onClick={() => void saveAsPreset()}>存为预设</Button>
          {(dirty || inheriting) && <span className="cs-muted">{inheriting ? `${name}还没有单独的配置，先保存一次。` : '先保存修改，再存为预设。'}</span>}
        </div>
      </Section>
    </div>
  );
}

function VoicePreview({ dirty }: { dirty: boolean }) {
  const { run, busy } = useAction();
  const [text, setText] = useState('你好呀，我刚刚想到你了。');
  const [emotion, setEmotion] = useState('auto');
  const [url, setUrl] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const play = () => run('preview', async () => {
    const blob = await featureApi.previewVoice(text.trim() || '你好呀，我刚刚想到你了。', emotion === 'auto' ? 'neutral' : emotion);
    const next = URL.createObjectURL(blob);
    setUrl(next);
    if (audio.current) {
      audio.current.src = next;
      await audio.current.play().catch(() => undefined);
    }
  });

  return (
    <Section wide title="试听" desc="用已保存的语音设置念一句话。">
      <div data-no-dirty>
        <Fields>
          <Field label="念什么" full>
            <TextArea voice="her" rows={2} value={text} maxLength={300} onChange={(e) => setText(e.target.value)} />
          </Field>
          <Field label="情绪">
            <Select value={emotion} onChange={(e) => setEmotion(e.target.value)} options={EMOTIONS} />
          </Field>
        </Fields>
      </div>
      {dirty && <p className="cs-muted">有未保存的修改，试听的仍是已保存的设置。</p>}
      <div className="cs-actions">
        <CostButton label="试听（会消耗语音额度）" question="会真实合成一段语音，按字数计费。" confirmLabel="确认试听"
          busy={busy === 'preview'} onConfirm={play} />
      </div>
      <audio ref={audio} controls hidden={!url} className="mdl-audio" />
    </Section>
  );
}
