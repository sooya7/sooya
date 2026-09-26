import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { adminApi, adminRequest } from '../../lib/admin.js';
import { featureApi } from '../../lib/features.js';
import { consolePath } from '../routes.js';
import {
  Button, Callout, Facts, Field, Fields, Input, Loadable, Page, Section, Select, Status, Switch, TextArea,
  useAction, useConsole, useLoad, CostButton as CostConfirm } from '../ui.js';
import './Persona.css';

/* ------------------------------------------------------------------ types */

type Frequency = 'never' | 'low' | 'medium' | 'high';
type ProactiveMode = 'auto' | 'text' | 'text_sticker' | 'voice' | 'image';

interface StickerPolicy { enabled: boolean; frequency: Frequency; maxPerReply: number; avoidRepeatWindow: number; learnUserMeaning: boolean }
interface ImagePolicy { enabled: boolean; frequency: Frequency; maxPerReply: number }
interface VideoPolicy { enabled: boolean; frequency: Frequency; maxPerDay: number }
interface LifePolicy {
  reachOut?: boolean; quietGapMinutes?: number; maxReachOutsPerDay?: number; proactiveMode?: ProactiveMode; silentFrom?: number; silentTo?: number;
}

/** The persona as the server returns it; lib/admin types the policies loosely. */
interface PersonaData {
  id: string;
  name: string;
  tagline: string;
  systemPrompt: string;
  language: string;
  stickerPolicy: StickerPolicy;
  imagePolicy: ImagePolicy;
  videoPolicy: VideoPolicy;
  lifePolicy?: LifePolicy;
}

/** Effective reach-out settings (persona override or deployment default), for placeholders. */
interface LifeDefaults { reachOut: boolean; quietGapMinutes: number; maxReachOutsPerDay: number; silentFrom: number; silentTo: number; proactiveMode?: ProactiveMode }

interface VoicePolicy { enabled: boolean; frequency: Frequency; maxCharsPerClip: number; alwaysAttachTranscript: boolean }
interface VoiceEmotion { label: string; instructions: string; speed: number }
interface VoiceModel {
  provider: string; model: string; voice: string; speed: number; expressive: boolean;
  instructionMode: 'on' | 'auto' | 'off'; emotionIntensity: number; referenceId?: string;
}
interface VoiceSettings {
  capability: { configured: boolean; ok: boolean; provider: string; detail?: string } | null;
  policy: VoicePolicy;
  model: VoiceModel;
  emotions: Record<string, VoiceEmotion>;
}

/* ----------------------------------------------------------------- labels */

const FREQUENCY_OPTIONS: Array<{ value: Frequency; label: string }> = [
  { value: 'never', label: '不主动' },
  { value: 'low', label: '偶尔' },
  { value: 'medium', label: '适中' },
  { value: 'high', label: '经常' }
];

const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' }
];

const MODE_LABELS: Record<ProactiveMode, string> = {
  auto: '她自己决定',
  text: '只发文字',
  text_sticker: '文字加表情',
  voice: '发语音',
  image: '发照片'
};

const PROVIDER_LABELS: Record<string, string> = {
  none: '没有配置',
  'openai-tts': 'OpenAI 语音',
  'openai-compatible': 'OpenAI 兼容接口',
  'volc-tts': '火山引擎语音',
  fish: 'Fish Audio'
};

const INSTRUCTION_OPTIONS = [
  { value: 'on', label: '总是附带' },
  { value: 'auto', label: '自动判断' },
  { value: 'off', label: '不附带' }
];

const DEFAULT_PREVIEW_TEXT = '你好呀，我刚刚想到你了。';

/* ---------------------------------------------------------------- helpers */

function inRange(value: number, min: number, max: number, integer = true): boolean {
  return Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
}

function rangeError(value: number, min: number, max: number, integer = true): string | null {
  return inRange(value, min, max, integer) ? null : `请填 ${min} 到 ${max} 之间的${integer ? '整数' : '数'}`;
}

function toNumber(raw: string): number {
  return raw.trim() === '' ? Number.NaN : Number(raw);
}

function NumberField({ label, hint, value, min, max, step = 1, integer = true, onChange }: {
  label: string; hint?: ReactNode; value: number; min: number; max: number; step?: number; integer?: boolean; onChange: (next: number) => void;
}) {
  return (
    <Field label={label} hint={hint} error={rangeError(value, min, max, integer)}>
      <Input type="number" inputMode={integer ? 'numeric' : 'decimal'} min={min} max={max} step={step}
        value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(toNumber(e.target.value))} />
    </Field>
  );
}

/** Optional number: empty means "use the default". */
function OptionalNumberField({ label, hint, value, placeholder, min, max, onChange }: {
  label: string; hint?: ReactNode; value: number | undefined; placeholder?: string; min: number; max: number; onChange: (next: number | undefined) => void;
}) {
  const error = value === undefined ? null : rangeError(value, min, max);
  return (
    <Field label={label} hint={hint} error={error}>
      <Input type="number" inputMode="numeric" min={min} max={max} placeholder={placeholder}
        value={value === undefined || !Number.isFinite(value) ? '' : value}
        onChange={(e) => onChange(e.target.value.trim() === '' ? undefined : Number(e.target.value))} />
    </Field>
  );
}

function hourLabel(hour: number | undefined): string {
  return hour === undefined ? '—' : `${String(hour).padStart(2, '0')}:00`;
}

/*
 * Three independent save buttons live on this page. Saving one must not clear the
 * shell's "unsaved" warning while another section still holds edits.
 */
interface DirtyRegistry { report: (key: string, dirty: boolean) => void; settle: (key: string) => void }

function useDirtyReport(registry: DirtyRegistry, key: string, draft: unknown, saved: unknown) {
  const dirty = draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => { registry.report(key, dirty); }, [registry, key, dirty]);
}

/* ================================================================ persona */

function personaErrors(p: PersonaData): string[] {
  const out: string[] = [];
  if (!p.name.trim()) out.push('名字不能为空');
  if (!p.systemPrompt.trim()) out.push('人设正文不能为空');
  if (!inRange(p.stickerPolicy.maxPerReply, 0, 3)) out.push('每条回复最多几张表情');
  if (!inRange(p.stickerPolicy.avoidRepeatWindow, 0, 50)) out.push('表情不重复的范围');
  if (!inRange(p.imagePolicy.maxPerReply, 0, 4)) out.push('每条回复最多几张照片');
  if (!inRange(p.videoPolicy.maxPerDay, 0, 50)) out.push('每天最多几段视频');
  const life = p.lifePolicy ?? {};
  if (life.quietGapMinutes !== undefined && !inRange(life.quietGapMinutes, 5, 1440)) out.push('你不说话后她至少等多久');
  if (life.maxReachOutsPerDay !== undefined && !inRange(life.maxReachOutsPerDay, 0, 20)) out.push('每天最多主动找你几次');
  if (life.silentFrom !== undefined && !inRange(life.silentFrom, 0, 23)) out.push('安静时段开始');
  if (life.silentTo !== undefined && !inRange(life.silentTo, 0, 23)) out.push('安静时段结束');
  return out;
}

function cleanLifePolicy(life: LifePolicy | undefined): LifePolicy {
  const out: LifePolicy = {};
  for (const [key, value] of Object.entries(life ?? {})) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function PersonaEditor({ persona, lifeDefaults, onSaved, registry }: {
  persona: PersonaData; lifeDefaults: LifeDefaults | null; onSaved: (next: PersonaData) => void; registry: DirtyRegistry;
}) {
  const { run, busy } = useAction();
  const [draft, setDraft] = useState<PersonaData>(persona);
  useDirtyReport(registry, 'persona', draft, persona);
  // lifePolicy is also written from the life page; only send it when edited here.
  const [lifeTouched, setLifeTouched] = useState(false);
  useEffect(() => { setDraft(persona); setLifeTouched(false); }, [persona]);

  const set = <K extends keyof PersonaData>(key: K, value: PersonaData[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setSticker = (patch: Partial<StickerPolicy>) => setDraft((d) => ({ ...d, stickerPolicy: { ...d.stickerPolicy, ...patch } }));
  const setImage = (patch: Partial<ImagePolicy>) => setDraft((d) => ({ ...d, imagePolicy: { ...d.imagePolicy, ...patch } }));
  const setVideo = (patch: Partial<VideoPolicy>) => setDraft((d) => ({ ...d, videoPolicy: { ...d.videoPolicy, ...patch } }));
  const setLife = (patch: Partial<LifePolicy>) => {
    setLifeTouched(true);
    setDraft((d) => ({ ...d, lifePolicy: { ...(d.lifePolicy ?? {}), ...patch } }));
  };

  const errors = personaErrors(draft);
  const life = draft.lifePolicy ?? {};
  const languageOptions = LANGUAGE_OPTIONS.some((o) => o.value === draft.language)
    ? LANGUAGE_OPTIONS
    : [...LANGUAGE_OPTIONS, { value: draft.language, label: draft.language }];
  const promptLength = draft.systemPrompt.length;

  const save = async () => {
    const body: Record<string, unknown> = {
      name: draft.name.trim(),
      tagline: draft.tagline,
      systemPrompt: draft.systemPrompt,
      language: draft.language,
      stickerPolicy: draft.stickerPolicy,
      imagePolicy: draft.imagePolicy,
      videoPolicy: draft.videoPolicy
    };
    if (lifeTouched) body.lifePolicy = cleanLifePolicy(draft.lifePolicy);
    const result = await run('persona', () => adminRequest<{ persona: PersonaData }>('/api/admin/persona', { method: 'PUT', body }), '人设已保存');
    if (result) { registry.settle('persona'); onSaved(result.persona); }
  };

  const reachOutValue = life.reachOut === undefined ? '' : life.reachOut ? 'on' : 'off';
  const defaultHint = (text: string | number | undefined) => (text === undefined || text === '' ? '留空就用默认值' : `留空就用默认值：${text}`);
  const silentSame = (life.silentFrom ?? lifeDefaults?.silentFrom) === (life.silentTo ?? lifeDefaults?.silentTo);

  return (
    <>
      <Section title="她是谁" desc="名字和状态文字会出现在聊天里。">
        <Fields>
          <Field label="名字" error={draft.name.trim() ? null : '名字不能为空'}>
            <Input value={draft.name} maxLength={60} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="状态文字" hint="显示在她名字下面，比如“在线”“在写手账”。">
            <Input value={draft.tagline} maxLength={60} onChange={(e) => set('tagline', e.target.value)} />
          </Field>
          <Field label="她用什么语言说话">
            <Select value={draft.language} options={languageOptions} onChange={(e) => set('language', e.target.value)} />
          </Field>
        </Fields>
      </Section>

      <Section title="设定和说话方式" desc="她的身份、性格、习惯、你们的关系、说话的语气，以及不能做的事。每次回复都会带上这一段，改完保存后下一条消息就生效。">
        <Field label="人设正文" full hint={`${promptLength.toLocaleString()} 字。写得越长，每次回复消耗的上下文越多。`}
          error={draft.systemPrompt.trim() ? null : '人设正文不能为空，她需要知道自己是谁。'}>
          <TextArea voice="her" className="persona-prompt" value={draft.systemPrompt} spellCheck={false}
            onChange={(e) => set('systemPrompt', e.target.value)} />
        </Field>
      </Section>

      <Section title="发表情" desc="日常聊天里配表情包的习惯。">
        <Switch checked={draft.stickerPolicy.enabled} onChange={(v) => setSticker({ enabled: v })} label="允许她发表情" />
        <Fields>
          <Field label="发表情的频率">
            <Select value={draft.stickerPolicy.frequency} options={FREQUENCY_OPTIONS} disabled={!draft.stickerPolicy.enabled}
              onChange={(e) => setSticker({ frequency: e.target.value as Frequency })} />
          </Field>
          <NumberField label="每条回复最多几张" min={0} max={3} value={draft.stickerPolicy.maxPerReply} onChange={(v) => setSticker({ maxPerReply: v })} />
          <NumberField label="最近几次内不发同一张" hint="0 表示不限制重复。" min={0} max={50}
            value={draft.stickerPolicy.avoidRepeatWindow} onChange={(v) => setSticker({ avoidRepeatWindow: v })} />
        </Fields>
        <Switch checked={draft.stickerPolicy.learnUserMeaning} onChange={(v) => setSticker({ learnUserMeaning: v })}
          label="记住你发的表情是什么意思，之后她也会这样用" />
      </Section>

      <Section title="发照片" desc="她给你发自己照片或画面的习惯。每张照片都会调用生图服务。">
        <Switch checked={draft.imagePolicy.enabled} onChange={(v) => setImage({ enabled: v })} label="允许她发照片" />
        <Fields>
          <Field label="主动发照片的频率" hint="选“不主动”时，你开口要她还是会发。">
            <Select value={draft.imagePolicy.frequency} options={FREQUENCY_OPTIONS} disabled={!draft.imagePolicy.enabled}
              onChange={(e) => setImage({ frequency: e.target.value as Frequency })} />
          </Field>
          <NumberField label="每条回复最多几张" min={0} max={4} value={draft.imagePolicy.maxPerReply} onChange={(v) => setImage({ maxPerReply: v })} />
        </Fields>
      </Section>

      <Section title="发视频" desc="短视频要几分钟才能做好，而且按条计费，所以默认只在你要的时候才做。">
        <Switch checked={draft.videoPolicy.enabled} onChange={(v) => setVideo({ enabled: v })} label="允许她发视频" />
        <Fields>
          <Field label="主动发视频的频率" hint="选“不主动”时，你开口要她还是会做。">
            <Select value={draft.videoPolicy.frequency} options={FREQUENCY_OPTIONS} disabled={!draft.videoPolicy.enabled}
              onChange={(e) => setVideo({ frequency: e.target.value as Frequency })} />
          </Field>
          <NumberField label="24 小时内最多几段" hint="在管理后台手动生成的不算在内。" min={0} max={50}
            value={draft.videoPolicy.maxPerDay} onChange={(v) => setVideo({ maxPerDay: v })} />
        </Fields>
      </Section>

      <Section title="她主动找你" desc="她会不会在你没说话时来找你、多久一次、用什么方式。留空的项跟随默认设置；生活页面里改的也是这几项。">
        <Fields>
          <Field label="会不会主动找你" hint={lifeDefaults ? `默认：${lifeDefaults.reachOut ? '会' : '不会'}` : undefined}>
            <Select value={reachOutValue} options={[{ value: '', label: '跟随默认' }, { value: 'on', label: '会' }, { value: 'off', label: '不会' }]}
              onChange={(e) => setLife({ reachOut: e.target.value === '' ? undefined : e.target.value === 'on' })} />
          </Field>
          <Field label="主动找你时用什么方式" hint={lifeDefaults?.proactiveMode ? `默认：${MODE_LABELS[lifeDefaults.proactiveMode]}` : undefined}>
            <Select value={life.proactiveMode ?? ''}
              options={[{ value: '', label: '跟随默认' }, ...(Object.keys(MODE_LABELS) as ProactiveMode[]).map((value) => ({ value, label: MODE_LABELS[value] }))]}
              onChange={(e) => setLife({ proactiveMode: e.target.value === '' ? undefined : e.target.value as ProactiveMode })} />
          </Field>
          <OptionalNumberField label="你不说话后，她至少等几分钟" min={5} max={1440} value={life.quietGapMinutes}
            placeholder={lifeDefaults ? String(lifeDefaults.quietGapMinutes) : undefined}
            hint={defaultHint(lifeDefaults ? `${lifeDefaults.quietGapMinutes} 分钟` : undefined)} onChange={(v) => setLife({ quietGapMinutes: v })} />
          <OptionalNumberField label="每天最多主动找你几次" min={0} max={20} value={life.maxReachOutsPerDay}
            placeholder={lifeDefaults ? String(lifeDefaults.maxReachOutsPerDay) : undefined}
            hint={defaultHint(lifeDefaults?.maxReachOutsPerDay)} onChange={(v) => setLife({ maxReachOutsPerDay: v })} />
          <OptionalNumberField label="安静时段从几点开始" min={0} max={23} value={life.silentFrom}
            placeholder={lifeDefaults ? String(lifeDefaults.silentFrom) : undefined}
            hint={defaultHint(lifeDefaults ? hourLabel(lifeDefaults.silentFrom) : undefined)} onChange={(v) => setLife({ silentFrom: v })} />
          <OptionalNumberField label="到几点结束" min={0} max={23} value={life.silentTo}
            placeholder={lifeDefaults ? String(lifeDefaults.silentTo) : undefined}
            hint={defaultHint(lifeDefaults ? hourLabel(lifeDefaults.silentTo) : undefined)} onChange={(v) => setLife({ silentTo: v })} />
        </Fields>
        <p className="cs-muted">
          {silentSame ? '开始和结束是同一个钟点，等于没有安静时段。' : '安静时段按她所在地的时间算，这段时间里她不会主动发消息。'}
        </p>
      </Section>

      <div className="persona-save">
        {errors.length > 0 && <Callout tone="warn">还有几项需要改一下才能保存：{errors.join('、')}。</Callout>}
        <div className="cs-actions">
          <Button busy={busy === 'persona'} disabled={errors.length > 0} onClick={() => void save()}>保存人设</Button>
          <Button kind="text" onClick={() => { setDraft(persona); setLifeTouched(false); registry.settle('persona'); }}>撤销没保存的修改</Button>
        </div>
      </div>
    </>
  );
}

/* ========================================================= voice behavior */

function VoiceBehaviorSection({ registry }: { registry: DirtyRegistry }) {
  const { run, busy } = useAction();
  const state = useLoad(() => adminApi.voiceBehavior(), []);
  const [draft, setDraft] = useState<{ enabled: boolean; maxVoiceSeconds: number } | null>(null);
  useDirtyReport(registry, 'behavior', draft, state.data);
  useEffect(() => { if (state.data) setDraft(state.data); }, [state.data]);

  const save = async () => {
    if (!draft) return;
    const result = await run('behavior', () => adminApi.updateVoiceBehavior({ enabled: draft.enabled, maxVoiceSeconds: draft.maxVoiceSeconds }), '语音习惯已保存');
    if (result) { state.setData(result); registry.settle('behavior'); }
  };

  return (
    <Section title="她什么时候发语音" desc="发不发、什么时候发由她根据聊天内容和你的习惯判断，这里只管总开关和长度。">
      <Loadable state={state} label="语音习惯">
        {() => draft && (
          <>
            <Switch checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label="允许她发语音" />
            <Fields>
              <NumberField label="一条语音最长几秒" min={5} max={120} value={draft.maxVoiceSeconds}
                hint="超出的部分会改成文字发。" onChange={(v) => setDraft({ ...draft, maxVoiceSeconds: v })} />
            </Fields>
            <div className="cs-actions">
              <Button busy={busy === 'behavior'} disabled={!inRange(draft.maxVoiceSeconds, 5, 120)} onClick={() => void save()}>保存语音习惯</Button>
            </div>
          </>
        )}
      </Loadable>
    </Section>
  );
}

/* ============================================================ voice model */

function voiceErrors(v: VoiceSettings, fish: boolean): string[] {
  const out: string[] = [];
  if (!fish && !v.model.voice.trim()) out.push('音色');
  if (!inRange(v.model.speed, 0.25, 4, false)) out.push('语速');
  if (!inRange(v.policy.maxCharsPerClip, 20, 2000)) out.push('一条语音最多多少字');
  for (const [key, emotion] of Object.entries(v.emotions)) {
    if (!inRange(emotion.speed, 0.25, 4, false) || emotion.label.length > 40 || emotion.instructions.length > 500) out.push(`“${emotion.label || key}”的说法`);
  }
  return out;
}

/** A spend-money action: the first click explains the cost, the second one runs it. */
function VoiceSection({ registry }: { registry: DirtyRegistry }) {
  const { navigate } = useConsole();
  const { run, busy } = useAction();
  const state = useLoad(() => featureApi.voice() as Promise<VoiceSettings>, []);
  const [draft, setDraft] = useState<VoiceSettings | null>(null);
  useDirtyReport(registry, 'voice', draft, state.data);
  useEffect(() => { if (state.data) setDraft(state.data); }, [state.data]);

  const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT);
  const [previewEmotion, setPreviewEmotion] = useState('neutral');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<string | null>(null);
  useEffect(() => () => { if (audioRef.current) URL.revokeObjectURL(audioRef.current); }, []);

  const emotionOptions = useMemo(
    () => Object.entries(draft?.emotions ?? {}).map(([value, e]) => ({ value, label: e.label || value })),
    [draft?.emotions]
  );

  const setModel = (patch: Partial<VoiceModel>) => setDraft((d) => d && ({ ...d, model: { ...d.model, ...patch } }));
  const setPolicy = (patch: Partial<VoicePolicy>) => setDraft((d) => d && ({ ...d, policy: { ...d.policy, ...patch } }));
  const setEmotion = (key: string, patch: Partial<VoiceEmotion>) =>
    setDraft((d) => d && ({ ...d, emotions: { ...d.emotions, [key]: { ...d.emotions[key]!, ...patch } } }));

  const preview = async () => {
    const text = previewText.trim() || DEFAULT_PREVIEW_TEXT;
    const blob = await run('preview', () => featureApi.previewVoice(text, previewEmotion));
    if (!blob) return;
    if (audioRef.current) URL.revokeObjectURL(audioRef.current);
    const url = URL.createObjectURL(blob);
    audioRef.current = url;
    setAudioUrl(url);
  };

  return (
    <Loadable state={state} label="声音设置">
      {() => {
        if (!draft) return null;
        const fish = draft.model.provider === 'fish';
        const configured = Boolean(draft.capability?.configured);
        const errors = voiceErrors(draft, fish);
        const save = async () => {
          const model: Record<string, unknown> = {
            speed: draft.model.speed,
            expressive: draft.model.expressive,
            instructionMode: draft.model.instructionMode,
            emotionIntensity: draft.model.emotionIntensity
          };
          if (!fish) model.voice = draft.model.voice.trim();
          const result = await run('voice', () => adminRequest<Pick<VoiceSettings, 'policy' | 'model' | 'emotions'>>('/api/admin/voice', {
            method: 'PUT',
            body: {
              policy: { maxCharsPerClip: draft.policy.maxCharsPerClip, alwaysAttachTranscript: draft.policy.alwaysAttachTranscript },
              model,
              emotions: draft.emotions
            }
          }), '声音设置已保存');
          if (result) { state.setData((old) => old && ({ ...old, ...result })); registry.settle('voice'); }
        };
        const capabilityTone = !configured ? 'off' : draft.capability?.ok ? 'ok' : 'warn';
        return (
          <>
            <Section title="她的声音" desc="语音服务本身（接口、密钥、Fish 声线）在模型页面配置，这里调的是她说话的样子。">
              <div className="cs-actions persona-voice-head">
                <Status tone={capabilityTone}>
                  {!configured ? '还没有配置语音服务，她现在发不了语音' : draft.capability?.ok ? '语音服务可用' : `语音服务有问题：${draft.capability?.detail ?? '检查没通过'}`}
                </Status>
                <Button kind="text" size="sm" onClick={() => navigate(consolePath('models'))}>去模型页面配置语音服务</Button>
              </div>
              <Facts items={[
                ['语音服务', PROVIDER_LABELS[draft.model.provider] ?? draft.model.provider],
                ['模型', draft.model.model || '—'],
                ...(fish ? [['Fish 声线', draft.model.referenceId || '默认声线'] as [string, string]] : [])
              ]} />
              <Fields>
                {!fish && (
                  <Field label="音色" hint="语音服务里的音色名，比如 alloy，或火山的音色 ID。" error={draft.model.voice.trim() ? null : '音色不能为空'}>
                    <Input value={draft.model.voice} maxLength={80} onChange={(e) => setModel({ voice: e.target.value })} />
                  </Field>
                )}
                <NumberField label="语速" hint="1 是正常速度，0.25 到 4。" min={0.25} max={4} step={0.05} integer={false}
                  value={draft.model.speed} onChange={(v) => setModel({ speed: v })} />
                <Field label="说话指令" hint="有些兼容接口不认这个字段，报错时选“不附带”。">
                  <Select value={draft.model.instructionMode} options={INSTRUCTION_OPTIONS}
                    onChange={(e) => setModel({ instructionMode: e.target.value as VoiceModel['instructionMode'] })} />
                </Field>
                <NumberField label="一条语音最多多少字" hint="更长的内容会拆开或改发文字。" min={20} max={2000}
                  value={draft.policy.maxCharsPerClip} onChange={(v) => setPolicy({ maxCharsPerClip: v })} />
              </Fields>
              <Field label={`情绪起伏：${Math.round(draft.model.emotionIntensity * 100)}%`} hint="越高，开心、难过时语速和语气的变化越明显。">
                <Input type="range" min={0} max={1} step={0.05} value={draft.model.emotionIntensity}
                  onChange={(e) => setModel({ emotionIntensity: Number(e.target.value) })} />
              </Field>
              <Switch checked={draft.model.expressive} onChange={(v) => setModel({ expressive: v })} label="按说话内容自动调整情绪和节奏" />
              <Switch checked={draft.policy.alwaysAttachTranscript} onChange={(v) => setPolicy({ alwaysAttachTranscript: v })} label="发语音时同时附上文字" />
            </Section>

            <Section title="不同心情怎么说" desc={fish
              ? 'Fish 会按心情自动加语气提示，下面这些主要给 OpenAI、火山等接口用。'
              : '她判断出当前心情后，会按对应的说法去念。'}>
              <div className="persona-emotions" role="table" aria-label="不同心情的说法">
                <div className="persona-emotion persona-emotion-head" role="row">
                  <span role="columnheader">心情</span>
                  <span role="columnheader">怎么念</span>
                  <span role="columnheader">语速</span>
                </div>
                {Object.entries(draft.emotions).map(([key, emotion]) => {
                  const name = emotion.label || key;
                  const speedBad = !inRange(emotion.speed, 0.25, 4, false);
                  return (
                    <div className="persona-emotion" role="row" key={key}>
                      <Input aria-label={`${name}：心情名称`} value={emotion.label} maxLength={40}
                        onChange={(e) => setEmotion(key, { label: e.target.value })} />
                      <TextArea voice="her" rows={1} aria-label={`${name}：怎么念`} className="persona-emotion-text" maxLength={500}
                        value={emotion.instructions} onChange={(e) => setEmotion(key, { instructions: e.target.value })} />
                      <Input aria-label={`${name}：语速`} aria-invalid={speedBad || undefined} type="number" inputMode="decimal"
                        min={0.25} max={4} step={0.01} value={Number.isFinite(emotion.speed) ? emotion.speed : ''}
                        onChange={(e) => setEmotion(key, { speed: toNumber(e.target.value) })} />
                    </div>
                  );
                })}
              </div>
              <p className="cs-muted">每种心情的语速里 1 是正常速度，可以填 0.25 到 4。</p>
              {errors.length > 0 && <Callout tone="warn">还有几项需要改一下才能保存：{errors.join('、')}。</Callout>}
              <div className="cs-actions">
                <Button busy={busy === 'voice'} disabled={errors.length > 0} onClick={() => void save()}>保存声音设置</Button>
                <Button kind="text" onClick={() => { setDraft(state.data); registry.settle('voice'); }}>撤销没保存的修改</Button>
              </div>
            </Section>

            <Section title="试听" desc="用上面已保存的设置念一句话。每次试听都会真实调用语音服务，消耗语音额度。">
              {!configured ? (
                <Callout tone="warn">
                  还没有配置语音服务，没法试听。先去模型页面填好语音合成的接口。{' '}
                  <Button kind="text" size="sm" onClick={() => navigate(consolePath('models'))}>去模型页面</Button>
                </Callout>
              ) : (
                <div data-no-dirty className="persona-preview">
                  <Field label="让她念什么" full>
                    <TextArea voice="her" rows={2} maxLength={1000} value={previewText} onChange={(e) => setPreviewText(e.target.value)} />
                  </Field>
                  <Fields>
                    <Field label="用什么心情">
                      <Select value={previewEmotion} options={emotionOptions.length ? emotionOptions : [{ value: 'neutral', label: '中性' }]}
                        onChange={(e) => setPreviewEmotion(e.target.value)} />
                    </Field>
                  </Fields>
                  <div className="cs-actions">
                    <CostConfirm label="试听这句（消耗语音额度）" question="会调用语音服务，消耗一次语音额度。"
                      confirmLabel="确认试听" busy={busy === 'preview'} onConfirm={preview} />
                  </div>
                  {audioUrl && <audio className="persona-audio" src={audioUrl} controls autoPlay />}
                </div>
              )}
            </Section>
          </>
        );
      }}
    </Loadable>
  );
}

/* ================================================================== page */

export default function Persona() {
  const { markClean } = useConsole();
  const dirtyKeys = useRef(new Set<string>());
  const registry = useMemo<DirtyRegistry>(() => ({
    report: (key, dirty) => { if (dirty) dirtyKeys.current.add(key); else dirtyKeys.current.delete(key); },
    settle: (key) => { dirtyKeys.current.delete(key); if (dirtyKeys.current.size === 0) markClean(); }
  }), [markClean]);
  const persona = useLoad(async () => {
    const [p, life] = await Promise.all([
      adminApi.persona().then((r) => r.persona as unknown as PersonaData),
      // Only used for "default" hints; the life feature can be off, so a failure is fine.
      adminRequest<{ settings?: LifeDefaults }>('/api/admin/life').then((r) => r.settings ?? null).catch(() => null)
    ]);
    return { persona: p, lifeDefaults: life };
  }, []);

  return (
    <Page title="人设与声音" register="her" intro="她是谁、怎么说话、多久主动表达一次，以及她的声音。">
      <div className="persona">
      <Loadable state={persona} label="人设">
        {({ persona: p, lifeDefaults }) => (
          <PersonaEditor persona={p} lifeDefaults={lifeDefaults}
            registry={registry} onSaved={(next) => persona.setData((old) => old && ({ ...old, persona: next }))} />
        )}
      </Loadable>
      <VoiceBehaviorSection registry={registry} />
      <VoiceSection registry={registry} />
      </div>
    </Page>
  );
}
