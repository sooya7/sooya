import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImageModelSchema } from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function store(env: NodeJS.ProcessEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sooya-anuma-config-'));
  dirs.push(dir);
  return new ConfigStore({ configDir: dir, env });
}

describe('Anuma image configuration', () => {
  it('defaults upload controls and enforces their bounds', () => {
    const parsed = ImageModelSchema.parse({ provider: 'anuma-input-images' });
    expect(parsed.uploadTimeoutMs).toBe(20_000);
    expect(parsed.uploadMaxRetries).toBe(2);
    expect(() => ImageModelSchema.parse({ provider: 'anuma-input-images', uploadTimeoutMs: 999 })).toThrow();
    expect(() => ImageModelSchema.parse({ provider: 'anuma-input-images', uploadMaxRetries: 4 })).toThrow();
  });

  it('loads SOOYA_IMAGE_PROVIDER and keeps OpenAI default when only a model is supplied', () => {
    const anuma = store({ SOOYA_IMAGE_PROVIDER: 'anuma-input-images', SOOYA_IMAGE_MODEL: 'anuma-image' });
    expect(anuma.getModels().image.provider).toBe('anuma-input-images');
    expect(anuma.getModels().image.model).toBe('anuma-image');

    const openAi = store({ SOOYA_IMAGE_MODEL: 'gpt-image-1' });
    expect(openAi.getModels().image.provider).toBe('openai-images');
  });

  it('does not let environment provider override a panel-managed image section', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sooya-anuma-config-panel-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
      image: { configSource: 'panel', provider: 'openai-images', baseUrl: 'https://panel.example/v1', model: 'panel-image' }
    }));
    const config = new ConfigStore({ configDir: dir, env: {
      SOOYA_IMAGE_PROVIDER: 'anuma-input-images', SOOYA_IMAGE_BASE_URL: 'https://env.example/v1', SOOYA_IMAGE_MODEL: 'env-image'
    } });
    expect(config.getModels().image.provider).toBe('openai-images');
    expect(config.getModels().image.baseUrl).toBe('https://panel.example/v1');
    expect(config.getModels().image.model).toBe('panel-image');
  });
});
