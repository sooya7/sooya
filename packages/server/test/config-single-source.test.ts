import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config/store.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

function configDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sooya-model-source-'));
  dirs.push(dir);
  return dir;
}

describe('models.json single source', () => {
  it('migrates the effective legacy model and search environment into version 2 once', () => {
    const dir = configDir();
    const store = new ConfigStore({
      configDir: dir,
      env: {
        SOOYA_CHAT_PROVIDER: 'openai-compatible',
        SOOYA_CHAT_BASE_URL: 'https://chat.example/v1',
        SOOYA_CHAT_MODEL: 'deepseek-chat',
        SOOYA_CHAT_API_KEY: 'legacy-chat-key',
        SOOYA_WEB_SEARCH_ENABLED: 'true',
        SOOYA_WEB_SEARCH_PROVIDERS: 'tavily,doubao,responses,tavily',
        SOOYA_WEB_SEARCH_MAX_RESULTS: '3',
        SOOYA_WEB_SEARCH_TIMEOUT_MS: '12000',
        SOOYA_DOUBAO_SEARCH_EDITION: 'global',
        SOOYA_DOUBAO_SEARCH_API_KEY: 'legacy-doubao-key',
        SOOYA_TAVILY_API_KEY: 'legacy-tavily-key'
      } as NodeJS.ProcessEnv
    });

    const models = store.getModels() as any;
    expect(models.storageVersion).toBe(2);
    expect(models.chat).toMatchObject({
      provider: 'openai-compatible',
      baseUrl: 'https://chat.example/v1',
      model: 'deepseek-chat',
      apiKey: 'legacy-chat-key'
    });
    expect(models.webSearch).toMatchObject({
      enabled: true,
      providers: ['tavily', 'doubao', 'responses'],
      maxResults: 3,
      timeoutMs: 12_000,
      doubao: { edition: 'global', apiKey: 'legacy-doubao-key' },
      tavily: { apiKey: 'legacy-tavily-key' }
    });

    const onDisk = JSON.parse(fs.readFileSync(store.modelsPath, 'utf8'));
    expect(onDisk.storageVersion).toBe(2);
    expect(onDisk.chat.apiKey).toBe('legacy-chat-key');
    expect(onDisk.webSearch.doubao.apiKey).toBe('legacy-doubao-key');
    if (process.platform !== 'win32') expect(fs.statSync(store.modelsPath).mode & 0o777).toBe(0o600);
  });

  it('never lets model or search environment variables override a version 2 file', () => {
    const dir = configDir();
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
      storageVersion: 2,
      chat: { provider: 'openai-compatible', model: 'file-model', apiKey: 'file-key' },
      webSearch: {
        enabled: true,
        providers: ['doubao'],
        doubao: { edition: 'custom', apiKey: 'file-doubao-key' }
      }
    }));

    const store = new ConfigStore({
      configDir: dir,
      env: {
        SOOYA_CHAT_MODEL: 'environment-model',
        SOOYA_CHAT_API_KEY: 'environment-key',
        SOOYA_WEB_SEARCH_PROVIDERS: 'tavily',
        SOOYA_DOUBAO_SEARCH_API_KEY: 'environment-doubao-key'
      } as NodeJS.ProcessEnv
    });

    const models = store.getModels() as any;
    expect(models.chat.model).toBe('file-model');
    expect(models.chat.apiKey).toBe('file-key');
    expect(models.webSearch.providers).toEqual(['doubao']);
    expect(models.webSearch.doubao.apiKey).toBe('file-doubao-key');
  });

  it('recursively redacts web search keys without changing the stored configuration', () => {
    const dir = configDir();
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
      storageVersion: 2,
      webSearch: {
        enabled: true,
        providers: ['doubao', 'tavily'],
        doubao: { apiKey: 'doubao-secret' },
        tavily: { apiKey: 'tavily-secret' }
      }
    }));
    const store = new ConfigStore({ configDir: dir, env: {} as NodeJS.ProcessEnv });

    expect((store.safeModels() as any).webSearch).toMatchObject({
      doubao: { apiKeyConfigured: true },
      tavily: { apiKeyConfigured: true }
    });
    expect(JSON.stringify(store.safeModels())).not.toContain('doubao-secret');
    expect(JSON.stringify(store.safeModels())).not.toContain('tavily-secret');
    expect((store.getModels() as any).webSearch.doubao.apiKey).toBe('doubao-secret');
  });
});
