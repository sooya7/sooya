import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync, ensureDirSync } from '../util/fsx.js';

/**
 * Operator-editable prompt-expansion spec for the Media Director.
 *
 * The director's hard rules (what it may and may not do, and its JSON contract)
 * stay in `core/director/prompts.ts`, where they cannot be edited into
 * something unsafe. What lives here is the part a deployment legitimately wants
 * to tune without a code change: preferred style vocabulary, the negative
 * list, scene suffixes and clip length.
 *
 * Deliberately absent: SOOYA's appearance. Identity comes from her reference
 * images (a first frame for video), and the director is told not to redesign
 * her face — a text description here would compete with that and is the reason
 * the old, never-read `config/image-persona.json` was removed.
 */

const StringList = (max: number, itemMax = 200) => z.array(z.string().trim().min(1).max(itemMax)).max(max);

export const MediaSceneSchema = z.object({
  /** Appended to the expanded prompt for this scene kind. */
  suffix: z.string().trim().max(300).default(''),
  camera: z.string().trim().max(300).default('')
});

export const MediaPromptSpecSchema = z.object({
  version: z.literal(1).default(1),
  image: z.object({
    style: StringList(24).default([
      'realistic smartphone photography',
      'candid daily-life moment',
      'soft natural lighting, warm tones',
      'natural phone photography composition'
    ]),
    avoid: StringList(24).default([
      'plastic skin',
      'over-smoothed retouching',
      'HDR look',
      'studio posing',
      'AI-looking symmetrical composition'
    ]),
    scenes: z.record(MediaSceneSchema).default({
      selfie: { suffix: 'selfie angle, close-up, looking at camera, natural pose', camera: 'selfie perspective, slightly above eye level' },
      daily_life: { suffix: 'candid photo, natural daily life scene, relaxed atmosphere', camera: 'natural perspective, eye level' },
      outfit: { suffix: 'full body shot, showing outfit details', camera: 'full body, slightly low angle' },
      activity: { suffix: 'engaged in activity, dynamic pose, natural environment', camera: 'action perspective, capturing the moment' },
      environment: { suffix: 'environmental shot, atmospheric, showing surroundings', camera: 'wide angle, environmental perspective' }
    })
  }).default({}),
  video: z.object({
    style: StringList(24).default([
      'realistic smartphone video',
      'candid daily-life moment',
      'single continuous shot',
      'physically plausible motion and lighting'
    ]),
    /** Camera vocabulary the clip may use; anything more elaborate reads as stock footage. */
    camera: StringList(16).default([
      'gentle handheld drift',
      'slow push in',
      'locked-off tripod shot'
    ]),
    avoid: StringList(24).default([
      'fast cuts',
      'transitions',
      'captions or subtitles',
      'text watermarks',
      'multi-shot storytelling',
      'exaggerated AI-looking motion'
    ]),
    /** Advisory clip length handed to the director; the provider still clamps to what it supports. */
    durationSec: z.object({
      min: z.number().int().min(1).max(60).default(4),
      max: z.number().int().min(1).max(60).default(10)
    }).default({})
  }).default({}),
  /** Applies to both image and video expansion. */
  boundaries: z.object({
    disallowed: StringList(40).default([
      'minor-coded appearance',
      'nudity',
      'explicit sexual content',
      'self-harm imagery',
      'real-person face swap',
      'illegal activity'
    ])
  }).default({})
});

export type MediaPromptSpec = z.infer<typeof MediaPromptSpecSchema>;
export type MediaScene = z.infer<typeof MediaSceneSchema>;

export const DEFAULT_MEDIA_PROMPT_SPEC: MediaPromptSpec = MediaPromptSpecSchema.parse({});
export const MEDIA_PROMPT_SPEC_FILE = 'media-prompt-spec.json';

export interface MediaPromptSpecStoreOptions {
  configDir: string;
  onLog?: (level: 'warn' | 'info' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Loads the spec from CONFIG_DIR, writing the defaults on first start so the
 * file is discoverable, and reloading it when an operator edits it — the same
 * contract `models.json` has. An invalid edit keeps the last good spec rather
 * than degrading every expansion until someone notices.
 */
export class MediaPromptSpecStore {
  readonly specPath: string;
  private spec: MediaPromptSpec;

  constructor(private readonly opts: MediaPromptSpecStoreOptions) {
    ensureDirSync(opts.configDir);
    this.specPath = path.join(opts.configDir, MEDIA_PROMPT_SPEC_FILE);
    this.spec = this.load(true);
  }

  get(): MediaPromptSpec {
    return this.spec;
  }

  private load(writeDefaults: boolean): MediaPromptSpec {
    if (!fs.existsSync(this.specPath)) {
      if (writeDefaults) {
        try {
          atomicWriteFileSync(this.specPath, `${JSON.stringify(DEFAULT_MEDIA_PROMPT_SPEC, null, 2)}\n`);
          this.opts.onLog?.('info', 'wrote the default media prompt spec', { path: this.specPath });
        } catch (error) {
          this.opts.onLog?.('warn', 'could not write the default media prompt spec', { error: (error as Error).message });
        }
      }
      return DEFAULT_MEDIA_PROMPT_SPEC;
    }
    try {
      const parsed = MediaPromptSpecSchema.safeParse(JSON.parse(fs.readFileSync(this.specPath, 'utf8')));
      if (!parsed.success) {
        this.opts.onLog?.('warn', 'media-prompt-spec.json is invalid; keeping the previous spec', { issues: parsed.error.issues.length });
        return this.spec ?? DEFAULT_MEDIA_PROMPT_SPEC;
      }
      return parsed.data;
    } catch (error) {
      this.opts.onLog?.('error', 'failed to read media-prompt-spec.json; keeping the previous spec', { error: (error as Error).message });
      return this.spec ?? DEFAULT_MEDIA_PROMPT_SPEC;
    }
  }

  /** Re-reads the file. Returns true when a new valid spec was adopted. */
  reload(): boolean {
    const next = this.load(false);
    if (next === this.spec) return false;
    this.spec = next;
    return true;
  }

  /** Watches the containing directory so atomic replacement is observed. */
  watch(onChange?: () => void): () => void {
    const expected = path.basename(this.specPath);
    let timer: NodeJS.Timeout | null = null;
    let closed = false;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(path.dirname(this.specPath), (_event, filename) => {
        if (closed || (filename && filename.toString() !== expected)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (!closed && this.reload()) {
            this.opts.onLog?.('info', 'media-prompt-spec.json reloaded');
            onChange?.();
          }
        }, 100);
      });
    } catch (error) {
      this.opts.onLog?.('warn', 'could not watch media-prompt-spec.json', { error: (error as Error).message });
      return () => undefined;
    }
    watcher.on('error', (error) => this.opts.onLog?.('error', 'media prompt spec watcher failed', { error: error.message }));
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  }
}

/** The spec slice the image director is given, as plain data. */
export function imageSpecForDirector(spec: MediaPromptSpec, sceneKey?: string | null) {
  const scene = sceneKey ? spec.image.scenes[sceneKey] : undefined;
  return {
    style: spec.image.style,
    avoid: spec.image.avoid,
    disallowed: spec.boundaries.disallowed,
    ...(scene ? { scene: { key: sceneKey, ...scene } } : {})
  };
}

/** The spec slice the video director is given, as plain data. */
export function videoSpecForDirector(spec: MediaPromptSpec) {
  return {
    style: spec.video.style,
    camera: spec.video.camera,
    avoid: spec.video.avoid,
    durationSec: spec.video.durationSec,
    disallowed: spec.boundaries.disallowed
  };
}
