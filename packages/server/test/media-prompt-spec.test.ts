import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatProvider } from '../src/providers/types.js';
import { DirectorClient } from '../src/core/director/client.js';
import { MediaDirector, fallbackVideoPrompt } from '../src/core/mediaDirector.js';
import {
  DEFAULT_MEDIA_PROMPT_SPEC,
  MEDIA_PROMPT_SPEC_FILE,
  MediaPromptSpecStore,
  imageSpecForDirector,
  videoSpecForDirector
} from '../src/config/media-spec.js';
import { resolveVideoSize } from '../src/providers/video.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpConfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sooya-media-spec-'));
  dirs.push(dir);
  return dir;
}

function recordingProvider(reply: string, seen: string[]): ChatProvider {
  return {
    name: 'fake',
    configured: true,
    async complete(req) {
      seen.push(JSON.stringify(req));
      return { text: reply, model: 'fake' };
    },
    async stream() { return { text: reply, model: 'fake' }; },
    async inspectHealth() { return { capability: 'chat', configured: true, ok: true, provider: 'fake', checkedAt: new Date().toISOString() }; }
  };
}

describe('media prompt spec store', () => {
  it('writes the defaults on first start and serves them', () => {
    const dir = tmpConfig();
    const store = new MediaPromptSpecStore({ configDir: dir });
    const file = path.join(dir, MEDIA_PROMPT_SPEC_FILE);
    expect(fs.existsSync(file)).toBe(true);
    expect(store.get()).toEqual(DEFAULT_MEDIA_PROMPT_SPEC);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).video.durationSec).toEqual({ min: 4, max: 10 });
  });

  it('adopts an operator edit on reload and fills omitted sections with defaults', () => {
    const dir = tmpConfig();
    const store = new MediaPromptSpecStore({ configDir: dir });
    fs.writeFileSync(path.join(dir, MEDIA_PROMPT_SPEC_FILE), JSON.stringify({
      version: 1,
      video: { style: ['grainy 8mm home video'], avoid: ['slow motion'], durationSec: { min: 6, max: 8 } }
    }));
    expect(store.reload()).toBe(true);
    expect(store.get().video.style).toEqual(['grainy 8mm home video']);
    expect(store.get().video.durationSec).toEqual({ min: 6, max: 8 });
    // Untouched sections keep working rather than becoming empty.
    expect(store.get().image.style.length).toBeGreaterThan(0);
    expect(store.get().boundaries.disallowed).toContain('nudity');
  });

  it('keeps the last good spec when an edit is invalid or unreadable', () => {
    const dir = tmpConfig();
    const store = new MediaPromptSpecStore({ configDir: dir });
    fs.writeFileSync(path.join(dir, MEDIA_PROMPT_SPEC_FILE), '{ not json');
    expect(store.reload()).toBe(false);
    expect(store.get()).toEqual(DEFAULT_MEDIA_PROMPT_SPEC);

    fs.writeFileSync(path.join(dir, MEDIA_PROMPT_SPEC_FILE), JSON.stringify({ version: 2 }));
    expect(store.reload()).toBe(false);
    expect(store.get()).toEqual(DEFAULT_MEDIA_PROMPT_SPEC);
  });

  it('hands the director only the spec slice for its own task', () => {
    const spec = DEFAULT_MEDIA_PROMPT_SPEC;
    expect(imageSpecForDirector(spec, 'selfie')).toMatchObject({ scene: { key: 'selfie' }, disallowed: spec.boundaries.disallowed });
    expect(imageSpecForDirector(spec, 'nope')).not.toHaveProperty('scene');
    expect(videoSpecForDirector(spec)).toMatchObject({ camera: spec.video.camera, durationSec: { min: 4, max: 10 } });
    expect(videoSpecForDirector(spec)).not.toHaveProperty('scenes');
  });
});

describe('spec reaches the expansions', () => {
  it('uses the edited vocabulary in the composed clip prompt', () => {
    const dir = tmpConfig();
    const store = new MediaPromptSpecStore({ configDir: dir });
    fs.writeFileSync(path.join(dir, MEDIA_PROMPT_SPEC_FILE), JSON.stringify({
      version: 1,
      video: { style: ['grainy 8mm home video'], camera: ['static tripod'], avoid: ['slow motion'] }
    }));
    store.reload();

    const result = new MediaDirector(() => store.get()).video({ scene: '海边黄昏' });
    expect(result.prompt).toContain('海边黄昏');
    expect(result.prompt).toContain('grainy 8mm home video');
    expect(result.prompt).toContain('static tripod');
    expect(result.prompt).toContain('Avoid: slow motion');
  });

  it('uses the scene suffix and the negative list in the composed image prompt', async () => {
    const prompt = new MediaDirector().image({ scene: '窗边' }, { sceneKey: 'selfie' }).prompt;
    expect(prompt).toContain('窗边');
    expect(prompt).toContain('selfie angle, close-up');
    expect(prompt).toContain('over-smoothed retouching');
  });
});

describe('aspect ratio to request size', () => {
  it('reinterprets orientation without changing the paid-for resolution', () => {
    expect(resolveVideoSize('1280x720', '9:16')).toBe('720x1280');
    expect(resolveVideoSize('720x1280', '16:9')).toBe('1280x720');
    expect(resolveVideoSize('1280x720', '1:1')).toBe('720x720');
    expect(resolveVideoSize('1920x1080', '4:5')).toBe('1080x1920');
  });

  it('keeps the configured size when the ratio or the size cannot be read', () => {
    expect(resolveVideoSize('1280x720', undefined)).toBe('1280x720');
    expect(resolveVideoSize('1280x720', 'portrait')).toBe('1280x720');
    expect(resolveVideoSize('1280x720', '0:0')).toBe('1280x720');
    expect(resolveVideoSize('auto', '9:16')).toBe('auto');
  });
});
