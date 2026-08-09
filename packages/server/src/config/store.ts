import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MODELS,
  DEFAULT_PERSONA,
  ModelsConfigSchema,
  PersonaSchema,
  type ModelsConfig,
  type Persona
} from './schema.js';
import { atomicWriteFileSync, ensureDirSync } from '../util/fsx.js';

export interface ConfigStoreOptions {
  configDir: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (level: 'warn' | 'info' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Persona + model configuration, persisted as JSON files under CONFIG_DIR.
 * Version-2 model files are the only runtime source. Environment variables are
 * read once when a legacy file is migrated and never override the file again.
 */
export class ConfigStore {
  readonly personaPath: string;
  readonly modelsPath: string;
  private persona: Persona;
  private models: ModelsConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onLog: ConfigStoreOptions['onLog'];

  constructor(opts: ConfigStoreOptions) {
    ensureDirSync(opts.configDir);
    this.env = opts.env ?? process.env;
    this.onLog = opts.onLog;
    this.personaPath = path.join(opts.configDir, 'persona.json');
    this.modelsPath = path.join(opts.configDir, 'models.json');
    this.persona = this.loadPersona();
    this.models = this.loadModels();
  }

  private loadPersona(): Persona {
    if (!fs.existsSync(this.personaPath)) {
      atomicWriteFileSync(this.personaPath, JSON.stringify(DEFAULT_PERSONA, null, 2));
      return DEFAULT_PERSONA;
    }
    try {
      const parsed = PersonaSchema.safeParse(JSON.parse(fs.readFileSync(this.personaPath, 'utf8')));
      if (!parsed.success) {
        this.onLog?.('warn', 'persona.json invalid, using defaults', { issues: parsed.error.issues.length });
        return DEFAULT_PERSONA;
      }
      return parsed.data;
    } catch (err) {
      this.onLog?.('error', 'failed to read persona.json, using defaults', { error: (err as Error).message });
      return DEFAULT_PERSONA;
    }
  }

  private loadModels(): ModelsConfig {
    let raw: unknown = {};
    let mustPersist = false;
    if (fs.existsSync(this.modelsPath)) {
      try {
        raw = JSON.parse(fs.readFileSync(this.modelsPath, 'utf8'));
      } catch (err) {
        this.onLog?.('error', 'failed to read models.json, using defaults', { error: (err as Error).message });
        raw = {};
      }
    } else {
      mustPersist = true;
    }

    // `stt` was a user-upload/transcription capability in older releases. It
    // is intentionally gone now, but an old models.json must not make the
    // entire configuration look invalid or leave the deprecated section in
    // backups forever.
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, 'stt')) {
      const migrated = { ...(raw as Record<string, unknown>) };
      delete migrated.stt;
      raw = migrated;
      mustPersist = true;
    }

    const versioned = isVersionTwo(raw);
    const candidate = versioned ? raw : migrateLegacyModels(raw, this.env);
    const parsed = ModelsConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      this.onLog?.('warn', 'models.json invalid, using defaults', { issues: parsed.error.issues.length });
      return DEFAULT_MODELS;
    }
    if (!versioned || mustPersist) {
      this.persistModels(parsed.data);
      this.onLog?.('info', 'migrated model configuration to the single-source format');
    }
    return parsed.data;
  }

  getPersona(): Persona {
    return this.persona;
  }

  setPersona(patch: unknown): Persona {
    const merged = PersonaSchema.parse({ ...this.persona, ...(patch as object) });
    atomicWriteFileSync(this.personaPath, JSON.stringify(merged, null, 2));
    this.persona = merged;
    return merged;
  }

  getModels(): ModelsConfig {
    return this.models;
  }

  /** Model config for a capability, falling back to the chat model. */
  chatModelFor(capability: 'chat' | 'vision' | 'summary'): ModelsConfig['chat'] {
    if (capability === 'vision') return this.models.vision ?? this.models.chat;
    if (capability === 'summary') return this.models.summary ?? this.models.chat;
    return this.models.chat;
  }

  setModels(patch: unknown): ModelsConfig {
    const incoming = JSON.parse(JSON.stringify(patch ?? {})) as Record<string, unknown>;
    const merged = ModelsConfigSchema.parse(
      deepMerge(this.models as unknown as Record<string, unknown>, incoming)
    );
    this.persistModels(merged);
    this.models = merged;
    return this.models;
  }

  private persistModels(models: ModelsConfig): void {
    atomicWriteFileSync(this.modelsPath, JSON.stringify(models, null, 2));
    try {
      fs.chmodSync(this.modelsPath, 0o600);
    } catch {
      /* best-effort on filesystems without POSIX modes */
    }
  }

  /** Redacted view suitable for API responses. */
  safeModels(): Record<string, unknown> {
    return redactApiKeys(JSON.parse(JSON.stringify(this.models))) as Record<string, unknown>;
  }

  reload(): void {
    this.persona = this.loadPersona();
    this.models = this.loadModels();
  }
}

function isVersionTwo(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw)
    && (raw as Record<string, unknown>).storageVersion === 2;
}

function migrateLegacyModels(raw: unknown, env: NodeJS.ProcessEnv): ModelsConfig {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const next = ModelsConfigSchema.parse({ ...source, storageVersion: 2 });
  const section = (name: string): Record<string, unknown> => {
    const value = source[name];
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  };
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = key ? env[key]?.trim() : '';
      if (value) return value;
    }
    return undefined;
  };
  const panelManaged = (name: string): boolean => section(name).configSource === 'panel';
  const keyFor = (name: string, ...fallbacks: string[]): string | undefined => {
    const file = section(name);
    if (panelManaged(name) && typeof file.apiKey === 'string' && file.apiKey) return undefined;
    return pick(typeof file.apiKeyEnv === 'string' ? file.apiKeyEnv : '', ...fallbacks);
  };

  const chatKey = keyFor('chat', 'SOOYA_CHAT_API_KEY', 'OPENAI_API_KEY');
  if (chatKey) next.chat.apiKey = chatKey;
  if (!panelManaged('chat')) {
    next.chat.baseUrl = pick('SOOYA_CHAT_BASE_URL', 'OPENAI_BASE_URL') ?? next.chat.baseUrl;
    next.chat.model = pick('SOOYA_CHAT_MODEL') ?? next.chat.model;
    const provider = pick('SOOYA_CHAT_PROVIDER');
    if (provider) next.chat.provider = provider as ModelsConfig['chat']['provider'];
  }

  const embeddingKey = keyFor('embedding', 'SOOYA_EMBEDDING_API_KEY', 'OPENAI_API_KEY');
  if (embeddingKey) next.embedding.apiKey = embeddingKey;
  if (!panelManaged('embedding')) {
    next.embedding.baseUrl = pick('SOOYA_EMBEDDING_BASE_URL') ?? next.embedding.baseUrl;
    const model = pick('SOOYA_EMBEDDING_MODEL');
    if (model) {
      next.embedding.model = model;
      if (next.embedding.provider === 'none') next.embedding.provider = 'openai-embeddings';
    }
  }

  const imageKey = keyFor('image', 'SOOYA_IMAGE_API_KEY', 'OPENAI_API_KEY');
  if (imageKey) next.image.apiKey = imageKey;
  if (!panelManaged('image')) {
    next.image.baseUrl = pick('SOOYA_IMAGE_BASE_URL') ?? next.image.baseUrl;
    const provider = pick('SOOYA_IMAGE_PROVIDER');
    if (provider) next.image.provider = provider as ModelsConfig['image']['provider'];
    const model = pick('SOOYA_IMAGE_MODEL');
    if (model) {
      next.image.model = model;
      if (next.image.provider === 'none') next.image.provider = 'openai-images';
    }
  }

  const ttsKey = keyFor('tts', 'SOOYA_TTS_API_KEY', 'OPENAI_API_KEY');
  if (ttsKey) next.tts.apiKey = ttsKey;
  if (!panelManaged('tts')) {
    next.tts.baseUrl = pick('SOOYA_TTS_BASE_URL') ?? next.tts.baseUrl;
    const model = pick('SOOYA_TTS_MODEL');
    if (model) {
      next.tts.model = model;
      if (next.tts.provider === 'none') next.tts.provider = 'openai-tts';
    }
    next.tts.voice = pick('SOOYA_TTS_VOICE') ?? next.tts.voice;
  }

  const rerankKey = keyFor('rerank', 'SOOYA_RERANK_API_KEY', 'OPENAI_API_KEY');
  if (rerankKey) next.rerank.apiKey = rerankKey;
  if (!panelManaged('rerank')) {
    next.rerank.baseUrl = pick('SOOYA_RERANK_BASE_URL') ?? next.rerank.baseUrl;
    const model = pick('SOOYA_RERANK_MODEL');
    if (model) {
      next.rerank.model = model;
      if (next.rerank.provider === 'none') next.rerank.provider = 'openai-rerank';
    }
  }

  const providers = (pick('SOOYA_WEB_SEARCH_PROVIDERS') ?? 'doubao,tavily,responses')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const maxResults = Number(pick('SOOYA_WEB_SEARCH_MAX_RESULTS') ?? next.webSearch.maxResults);
  const timeoutMs = Number(pick('SOOYA_WEB_SEARCH_TIMEOUT_MS') ?? next.webSearch.timeoutMs);
  next.webSearch = {
    ...next.webSearch,
    enabled: /^(1|true|yes|on)$/i.test(pick('SOOYA_WEB_SEARCH_ENABLED') ?? ''),
    providers: [...new Set(providers)] as ModelsConfig['webSearch']['providers'],
    maxResults: Number.isFinite(maxResults) ? maxResults : next.webSearch.maxResults,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : next.webSearch.timeoutMs,
    doubao: {
      edition: (pick('SOOYA_DOUBAO_SEARCH_EDITION') ?? next.webSearch.doubao.edition) as 'custom' | 'global',
      baseUrl: pick('SOOYA_DOUBAO_SEARCH_BASE_URL') ?? next.webSearch.doubao.baseUrl,
      apiKey: pick('SOOYA_DOUBAO_SEARCH_API_KEY') ?? next.webSearch.doubao.apiKey
    },
    tavily: {
      baseUrl: pick('SOOYA_TAVILY_BASE_URL') ?? next.webSearch.tavily.baseUrl,
      apiKey: pick('SOOYA_TAVILY_API_KEY') ?? next.webSearch.tavily.apiKey
    }
  };
  return ModelsConfigSchema.parse(next);
}

function redactApiKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactApiKeys);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === 'apiKey' && typeof child === 'string') {
      out.apiKeyConfigured = child.length > 0;
      continue;
    }
    out[key] = redactApiKeys(child);
  }
  return out;
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}
