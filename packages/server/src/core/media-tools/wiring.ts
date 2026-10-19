/**
 * Wires the media tools (send_image / send_video / send_voice) into the app.
 *
 * Kept out of app.ts on purpose: app.ts has a size budget, so every live check
 * (persona switches, capability registry, V2 switch) is resolved here.
 */
import type { FlattenedToolCallReport } from '../../agent/tool-runtime.js';
import type { ToolRegistry } from '../../agent/registry.js';
import type { ToolPolicy } from '../../agent/tool-policy.js';
import type { ConfigStore } from '../../config/store.js';
import type { ErrorLogRepo } from '../../db/repos/misc.repo.js';
import type { CapabilityRegistry } from '../capabilities.js';
import type { VideoGenerationService } from '../video/service.js';
import { VOICE_MOOD_LIST } from '../voice.js';
import type { VoiceService } from '../voice/service.js';
import { MediaIntentStage } from './stage.js';
import { mediaTools } from './tools.js';

export interface MediaToolsWiringInput {
  tools: ToolRegistry;
  policy: ToolPolicy;
  /** MEDIA_TOOLS_ENABLED gates the tools; VOICE_V2_ENABLED gates the voice one. */
  env: { MEDIA_TOOLS_ENABLED: boolean; VOICE_V2_ENABLED: boolean };
  config: ConfigStore;
  capabilities: CapabilityRegistry;
  /** Null when that stack is not built at all; the tool is then never offered. */
  video: VideoGenerationService | null;
  voice: VoiceService | null;
}

export interface MediaToolsWiring {
  /** Null when the media tools are off. */
  stage: MediaIntentStage | null;
}

export function setupMediaTools(input: MediaToolsWiringInput): MediaToolsWiring {
  if (!input.env.MEDIA_TOOLS_ENABLED) return { stage: null };
  const persona = () => input.config.getPersona();
  const stage = new MediaIntentStage();
  const available = {
    image: () => input.capabilities.has('image') && persona().imagePolicy.enabled,
    video: () => input.capabilities.has('video') && persona().videoPolicy.enabled && input.video != null,
    voice: () => input.capabilities.has('tts') && persona().voicePolicy.enabled && input.voice != null && input.env.VOICE_V2_ENABLED
  };
  for (const tool of mediaTools({ stage, available, voiceMoods: VOICE_MOOD_LIST })) {
    input.tools.register(tool);
  }
  return { stage };
}

/**
 * A tool round that came back with tool-call markup instead of a structured call
 * is a silent failure (the call is not executed, so the media just never
 * arrives). Recording it is what makes that visible in the console.
 */
export function flattenedToolCallReporter(errors: ErrorLogRepo): (report: FlattenedToolCallReport) => void {
  return (report) => {
    errors.add('reply.tool_round', 'flattened_tool_call', {
      phase: report.phase,
      names: report.names.join(','),
      dsml: report.sawDsmlMarkup,
      sample: report.sample
    });
  };
}

/** One import for app.ts, which has a size budget. */
export const mediaWiring = { setup: setupMediaTools, flattenedReport: flattenedToolCallReporter };

export { MediaIntentStage, mergeStagedMediaIntent, type StagedMediaIntent } from './stage.js';
