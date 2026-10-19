import type { ToolDescriptor } from '../../agent/registry.js';
import type { MediaIntentStage, StagedMediaIntent } from './stage.js';

/** A picture intent longer than this is not a picture description any more. */
export const MAX_MEDIA_INTENT_CHARS = 1200;

interface StageContext {
  batchId?: string;
  revision?: number;
}

function intentText(raw: unknown): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('画面意图不能为空，请写清楚要画什么');
  if (text.length > MAX_MEDIA_INTENT_CHARS) {
    throw new Error(`画面意图太长了（最多 ${MAX_MEDIA_INTENT_CHARS} 字），请精简成一句描述`);
  }
  return text;
}

function alreadyStaged(staged: StagedMediaIntent | null, field: 'imagePrompt' | 'videoPrompt', kind: string): void {
  if (staged?.[field]) throw new Error(`这条回复已经安排好一${kind}了，一次就够，不要再调用`);
}

const ONLY_WHEN_ASKED = '主人明确要的时候才用；他自己没提就不要主动加。';

/**
 * send_image / send_video / send_voice for the reply phase.
 *
 * All three are `risk: 'write'` with `deferredEffects`: they only record what
 * this reply should carry (see MediaIntentStage), and nothing is generated or
 * sent unless the reply publishes. They exist so the model asks in a structured
 * way the host can validate, instead of writing a marker inside prose.
 */
export interface MediaToolOptions {
  stage: MediaIntentStage;
  /** Live availability: a tool whose stack is off never reaches the model. */
  available: { image: () => boolean; video: () => boolean; voice: () => boolean };
  /** Moods the voice stack understands; anything else is dropped. */
  voiceMoods: string[];
}

export function mediaTools(opts: MediaToolOptions): ToolDescriptor[] {
  const sendImage: ToolDescriptor<{ intent: string }> = {
    name: 'media.send_image',
    modelName: 'send_image',
    description: [
      '给主人画一张图，图片会随这条回复发给他。',
      '把画面写成一句具体的话（画什么、什么样子、什么氛围）交给它；正文里自然说一句就好，不用把画面描述再讲一遍。',
      ONLY_WHEN_ASKED
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: { intent: { type: 'string', description: '画面意图：画什么、什么样子、什么氛围' } },
      required: ['intent']
    },
    source: 'local',
    risk: 'write',
    deferredEffects: true,
    maxArgumentBytes: MAX_MEDIA_INTENT_CHARS * 4 + 1024,
    phases: ['reply'],
    authorize: () => opts.available.image(),
    handler: async (input, context) => {
      const ctx = (context ?? {}) as StageContext;
      alreadyStaged(opts.stage.peek(ctx), 'imagePrompt', '张图');
      const intent = intentText(input.intent);
      opts.stage.stage(ctx, { imagePrompt: intent });
      return '图片会随这条回复发出去，正文里自然说一句就行。';
    }
  };

  const sendVideo: ToolDescriptor<{ intent: string }> = {
    name: 'media.send_video',
    modelName: 'send_video',
    description: [
      '给主人做一段短视频，视频会随这条回复发给他。',
      '把要拍的画面写成一句具体的话（画面内容、动作、氛围）交给它；正文里自然说一句就好。',
      ONLY_WHEN_ASKED
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: { intent: { type: 'string', description: '画面意图：拍什么、什么动作、什么氛围' } },
      required: ['intent']
    },
    source: 'local',
    risk: 'write',
    deferredEffects: true,
    maxArgumentBytes: MAX_MEDIA_INTENT_CHARS * 4 + 1024,
    phases: ['reply'],
    authorize: () => opts.available.video(),
    handler: async (input, context) => {
      const ctx = (context ?? {}) as StageContext;
      alreadyStaged(opts.stage.peek(ctx), 'videoPrompt', '段视频');
      const intent = intentText(input.intent);
      opts.stage.stage(ctx, { videoPrompt: intent });
      return '视频会随这条回复发出去，正文里自然说一句就行。';
    }
  };

  const sendVoice: ToolDescriptor<{ mode: 'with_text' | 'voice_only'; emotion?: string }> = {
    name: 'media.send_voice',
    modelName: 'send_voice',
    description: [
      '把这条回复用语音说出来，语音会随这条回复发给他。',
      'mode=with_text：文字照常显示，另外附一条语音；mode=voice_only：只发语音，不显示文字。',
      `emotion 可选，从这里挑一个：${opts.voiceMoods.join(' / ')}；不确定就留空，系统会按文字语气自己判断。`,
      ONLY_WHEN_ASKED
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['with_text', 'voice_only'], description: 'with_text=文字加语音；voice_only=只发语音' },
        emotion: { type: 'string', description: `可选的说话情绪：${opts.voiceMoods.join(' / ')}` }
      },
      required: ['mode']
    },
    source: 'local',
    risk: 'write',
    deferredEffects: true,
    maxArgumentBytes: 2048,
    phases: ['reply'],
    authorize: () => opts.available.voice(),
    handler: async (input, context) => {
      const ctx = (context ?? {}) as StageContext;
      const mode = input.mode === 'voice_only' ? 'voice_only' : 'with_text';
      // An unknown mood is dropped instead of being handed to the provider as a
      // word nobody wrote: the model likes to answer in Chinese here.
      const asked = String(input.emotion ?? '').trim().toLowerCase();
      const mood = asked ? opts.voiceMoods.find((candidate) => candidate.toLowerCase() === asked) : undefined;
      opts.stage.stage(ctx, {
        voice: true,
        voiceOnly: mode === 'voice_only',
        ...(mood ? { voiceEmotion: mood } : {})
      });
      return mode === 'voice_only'
        ? '这条只发语音，不显示文字；正文里就不用把这段话写出来了。'
        : '语音会随这条回复一起发出去。';
    }
  };

  return [sendImage, sendVideo, sendVoice] as ToolDescriptor[];
}
