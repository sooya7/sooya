import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';
import { MediaIntentStage, mergeStagedMediaIntent } from '../src/core/media-tools/stage.js';
import { mediaTools } from '../src/core/media-tools/tools.js';
import { parseVoiceIntent } from '../src/core/voice/intent.js';
import { ToolRegistry, type ToolDescriptor } from '../src/agent/registry.js';
import { ToolPolicy } from '../src/agent/tool-policy.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const MOODS = ['neutral', 'warm', 'happy'];
const replyCtx = (revision = 1) => ({ phase: 'reply' as const, batchId: 'b1', revision });

function rig(available: Partial<{ image: boolean; video: boolean; voice: boolean }> = {}) {
  const stage = new MediaIntentStage();
  const tools = Object.fromEntries(
    mediaTools({
      stage,
      available: {
        image: () => available.image !== false,
        video: () => available.video !== false,
        voice: () => available.voice !== false
      },
      voiceMoods: MOODS
    }).map((tool) => [tool.modelName!, tool])
  ) as Record<string, ToolDescriptor<Record<string, unknown>>>;
  return { stage, tools };
}

function fakeChat(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function toolCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    content: '',
    tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
  };
}

/** Answers the reply's tool round with one call, then streams the scripted reply. */
function toolRoundOnce(call: () => Record<string, unknown>) {
  let rounds = 0;
  return ({ body }: { body: unknown }): Response | null => {
    const b = body as { stream?: boolean; tools?: unknown[] };
    if (b.stream === true || !Array.isArray(b.tools)) return null;
    rounds += 1;
    return fakeChat(rounds === 1 ? call() : { content: '' });
  };
}

const partTypes = (reply: { content: Array<{ type: string }> }) => reply.content.map((part) => part.type);
const requestToolNames = (body: unknown): string[] =>
  (((body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools ?? []).map(
    (tool) => tool.function?.name ?? ''
  ));

describe('media tools: staging a reply’s media', () => {
  it('records an image intent for this reply only', async () => {
    const { stage, tools } = rig();
    const out = await tools.send_image!.handler({ intent: '一只橘猫蜷在窗台上睡觉' }, replyCtx());
    expect(String(out)).toContain('图片');
    expect(stage.peek(replyCtx())?.imagePrompt).toBe('一只橘猫蜷在窗台上睡觉');
    expect(stage.peek(replyCtx(2))).toBeNull();
    expect(stage.take(replyCtx())?.imagePrompt).toBe('一只橘猫蜷在窗台上睡觉');
    expect(stage.peek(replyCtx())).toBeNull();
  });

  it('refuses a second picture in the same reply, and a blank intent', async () => {
    const { tools } = rig();
    await tools.send_image!.handler({ intent: '一只猫' }, replyCtx());
    await expect(tools.send_image!.handler({ intent: '一只狗' }, replyCtx())).rejects.toThrow(/已经安排/);
    await expect(tools.send_image!.handler({ intent: '   ' }, replyCtx(2))).rejects.toThrow(/不能为空/);
  });

  it('takes a mood only from the moods the voice stack knows', async () => {
    const { stage, tools } = rig();
    await tools.send_voice!.handler({ mode: 'with_text', emotion: '温柔' }, replyCtx());
    expect(stage.peek(replyCtx())).toEqual({ voice: true, voiceOnly: false });
    await tools.send_voice!.handler({ mode: 'voice_only', emotion: 'WARM' }, replyCtx());
    expect(stage.peek(replyCtx())).toEqual({ voice: true, voiceOnly: true, voiceEmotion: 'warm' });
  });

  it('forgets a stage nobody published after an hour', () => {
    let now = 1_000;
    const stage = new MediaIntentStage(() => now);
    stage.stage({ batchId: 'b1', revision: 1 }, { imagePrompt: '旧的一版' });
    now += 61 * 60 * 1000;
    stage.stage({ batchId: 'b2', revision: 1 }, { voice: true });
    expect(stage.peek({ batchId: 'b1', revision: 1 })).toBeNull();
    expect(stage.peek({ batchId: 'b2', revision: 1 })).toEqual({ voice: true });
  });

  it('lets the tool intent win over a marker the model also wrote', () => {
    const merged = mergeStagedMediaIntent(
      { imagePrompt: '标签写的', voice: true },
      { imagePrompt: '工具写的', voiceOnly: true, voiceEmotion: 'warm' }
    );
    expect(merged).toMatchObject({ imagePrompt: '工具写的', voice: true, voiceOnly: true, voiceEmotion: 'warm' });
  });

  it('never offers a tool whose stack is off', () => {
    const { tools } = rig({ image: false, voice: false });
    const registry = new ToolRegistry();
    for (const tool of Object.values(tools)) registry.register(tool);
    const policy = new ToolPolicy(registry, {});
    expect(policy.definitions('reply').map((definition) => definition.name)).toEqual(['send_video']);
  });
});

describe('media tools in the real reply pipeline', () => {
  it('sends the picture the tool asked for', async () => {
    h = await createHarness({
      chatSupportsTools: true,
      image: 'ok',
      env: { MEDIA_TOOLS_ENABLED: 'true' },
      chat: {
        script: [['画好啦～']],
        respond: toolRoundOnce(() => toolCall('send_image', { intent: '一只橘猫蜷在窗台上睡觉' }))
      }
    });
    // The user only hints at the picture; the tool supplies what is actually drawn.
    const { body } = await sendText(h.app, '给我看看窗台吧');
    expect(h.state.imageCalls).toBe(1);
    expect(partTypes(body.reply)).toContain('image');
    expect(JSON.stringify(h.state.imageRequests[0]?.body)).toContain('橘猫');
  });

  it('lets a voice_only call replace the text even when the wording did not ask for it', async () => {
    expect(parseVoiceIntent('跟我说晚安')).toBe('none');
    h = await createHarness({
      chatSupportsTools: true,
      tts: 'ok',
      env: { MEDIA_TOOLS_ENABLED: 'true' },
      chat: {
        script: [['晚安，早点睡～']],
        respond: toolRoundOnce(() => toolCall('send_voice', { mode: 'voice_only', emotion: 'warm' }))
      }
    });
    const { body } = await sendText(h.app, '跟我说晚安');
    expect(h.state.ttsCalls).toBe(1);
    expect(partTypes(body.reply)).toEqual(['audio']);
    expect(body.reply.content[0]!.transcript).toContain('晚安');
  });

  it('keeps the text when the tool only asks for voice', async () => {
    expect(parseVoiceIntent('在干嘛呀')).toBe('none');
    h = await createHarness({
      chatSupportsTools: true,
      tts: 'ok',
      env: { MEDIA_TOOLS_ENABLED: 'true' },
      chat: {
        script: [['在的呀～']],
        respond: toolRoundOnce(() => toolCall('send_voice', { mode: 'with_text' }))
      }
    });
    const { body } = await sendText(h.app, '在干嘛呀');
    expect(partTypes(body.reply)).toEqual(['text', 'audio']);
  });

  it('never executes a call the gateway flattened into text, and records it', async () => {
    h = await createHarness({
      chatSupportsTools: true,
      image: 'ok',
      env: { MEDIA_TOOLS_ENABLED: 'true' },
      chat: {
        script: [['嗯嗯，我在～']],
        respond: toolRoundOnce(() => ({
          content: '<tool_call><function=media.send_image><parameter=prompt>一只猫</parameter></function></tool_call>'
        }))
      }
    });
    const { body } = await sendText(h.app, '你在干嘛呀');
    expect(h.state.imageCalls).toBe(0);
    expect(partTypes(body.reply)).toContain('text');
    expect(body.reply.content.some((part: { text?: string }) => String(part.text ?? '').includes('tool_call'))).toBe(false);
    const logged = h.app.repos.errors.list(20).find((entry) => entry.message === 'flattened_tool_call');
    expect(logged).toBeTruthy();
    expect(logged!.scope).toBe('reply.tool_round');
  });

  it('still honors a legacy [[image:...]] marker while the tools are live', async () => {
    h = await createHarness({
      chatSupportsTools: true,
      image: 'ok',
      env: { MEDIA_TOOLS_ENABLED: 'true' },
      chat: { script: [['好呀。[[image:一只小猫]]']] }
    });
    const { body } = await sendText(h.app, '画一张小猫');
    expect(h.state.imageCalls).toBe(1);
    expect(partTypes(body.reply)).toContain('image');
  });

  it('leaves the media tools out of the request unless MEDIA_TOOLS_ENABLED is on', async () => {
    h = await createHarness({
      chatSupportsTools: true,
      env: { FILE_TOOLS_ENABLED: 'true' },
      chat: { script: [['在的～']] }
    });
    await sendText(h.app, '在吗');
    const names = requestToolNames(h.state.chatCalls[0]?.body);
    expect(names).toContain('file_write');
    expect(names).not.toContain('send_image');
    expect(names).not.toContain('send_voice');
  });
});
