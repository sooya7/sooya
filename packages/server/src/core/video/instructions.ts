import type { Persona } from '../../config/schema.js';

/**
 * Prompt lines that teach the main model the video markers. Kept out of
 * context.ts (a size-ratcheted hotspot) and only injected when a video model is
 * actually configured, so an unconfigured deployment never tempts the model
 * into promising clips it cannot deliver.
 */
export function videoMarkerInstructions(persona: Persona): string[] {
  const lines = [
    '· [[video:画面意图]] 生成并发送一段几秒钟的短视频。视频要几分钟才能做好，系统会在做好后作为一条新消息单独发出；所以这条回复里要自然地告诉用户需要等一会儿，不要说"发好了""看这段"。'
  ];
  if (persona.referenceImages.length > 0) {
    lines.push('· [[video-self:画面意图]] 生成一段你自己出镜的短视频。系统会保证你的形象长相一致；写明视角（正面半身、全身、侧脸）便于选参考图。');
  }
  const proactive = persona.videoPolicy.frequency === 'never'
    ? '只在用户明确要视频时使用，不要主动发。'
    : '除用户明确要求外，只在特别值得记录的时刻偶尔主动使用。';
  lines.push(`视频成本高、耗时长：${proactive}一条回复最多一个视频标记；标记里只写画面意图（在哪里、做什么、镜头怎么动），不写生成参数。`);
  return lines;
}
