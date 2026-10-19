import type { HarnessOptions } from './harness.js';

/**
 * Pictures, clips and voice only come from the media tools now, so a test that
 * wants the model to send one answers the reply's tool round with the calls,
 * then streams the reply text as usual.
 */
export type MediaCall = [name: 'send_image' | 'send_video' | 'send_voice', args: Record<string, unknown>];

function fakeChat(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Answers the first tool round with `calls`, every later round with no call. */
export function toolRoundOnce(calls: MediaCall[] | (() => MediaCall[])) {
  let rounds = 0;
  return ({ body }: { body: unknown }): Response | null => {
    const b = body as { stream?: boolean; tools?: unknown[] };
    if (b.stream === true || !Array.isArray(b.tools)) return null;
    rounds += 1;
    if (rounds > 1) return fakeChat({ content: '' });
    const list = typeof calls === 'function' ? calls() : calls;
    return fakeChat({
      content: '',
      tool_calls: list.map(([name, args], i) => ({
        id: `call_${name}_${i}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) }
      }))
    });
  };
}

/** Harness options for a reply whose text is `text` and whose tool round makes `calls`. */
export function withMediaTools(text: string, calls: MediaCall[], opts: HarnessOptions = {}): HarnessOptions {
  return {
    ...opts,
    chatSupportsTools: true,
    env: { MEDIA_TOOLS_ENABLED: 'true', ...opts.env },
    chat: { ...opts.chat, script: [[text]], respond: toolRoundOnce(calls) }
  };
}

export const image = (intent: string): MediaCall => ['send_image', { intent }];
export const video = (intent: string): MediaCall => ['send_video', { intent }];
export const voice = (mode: 'with_text' | 'voice_only' = 'with_text', emotion?: string): MediaCall =>
  ['send_voice', { mode, ...(emotion ? { emotion } : {}) }];
