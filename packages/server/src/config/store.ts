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

type ModelSection = 'chat' | 'vision' | 'summary' | 'embedding' | 'image' | 'tts' | 'stt';
const MODEL_SECTIONS: ModelSection[] = ['chat', 'vision', 'summary', 'embedding', 'image', 'tts', 'stt'];

/**
 * Persona + model configuration, persisted as JSON files under CONFIG_DIR.
 * API keys can come from the file or from environment variables; they are
 * never returned to any client by these getters marked `Safe`.
 */
export class ConfigStore {
  readonly personaPath: string;
  readonly modelsPath: string;
  private persona: Persona;
  /** Resolved config actually used at runtime (may contain env-injected keys). */
  private models: ModelsConfig;
  /**
   * The config exactly as it exists on disk, before environment overrides.
   * Writes are always derived from this, so a key supplied only through the
   * environment is never persisted into models.json (and therefore never ends
   * up inside a backup archive).
   */
  private fileModels: ModelsConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onLog: ConfigStoreOptions['onLog'];

  constructor(opts: ConfigStoreOptions) {
    ensureDirSync(opts.configDir);
    this.env = opts.env ?? process.env;
    this.onLog = opts.onLog;
    this.personaPath = path.join(opts.configDir, 'persona.json');
    this.modelsPath = path.join(opts.configDir, 'models.json');
    this.persona = this.loadPersona();
    this.fileModels = DEFAULT_MODELS;
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
    if (fs.existsSync(this.modelsPath)) {
      try {
        raw = JSON.parse(fs.readFileSync(this.modelsPath, 'utf8'));
      } catch (err) {
        this.onLog?.('error', 'failed to read models.json, using defaults', { error: (err as Error).message });
        raw = {};
      }
    } else {
      atomicWriteFileSync(this.modelsPath, JSON.stringify(DEFAULT_MODELS, null, 2));
    }
    const parsed = ModelsConfigSchema.safeParse(raw);
    if (!parsed.success) {
      this.onLog?.('warn', 'models.json invalid, using defaults', { issues: parsed.error.issues.length });
      this.fileModels = DEFAULT_MODELS;
      return DEFAULT_MODELS;
    }
    this.fileModels = parsed.data;
    return this.applyEnvOverrides(parsed.data);
  }

  /**
   * Environment variables configure untouched sections and always remain a
   * safe source for API keys. Once a section has been saved through the admin
   * panel (`configSource: panel`), its provider, URL, model and tuning values
   * come from models.json instead of being silently replaced by old env vars.
   */
  private applyEnvOverrides(models: ModelsConfig): ModelsConfig {
    const e = this.env;
    const next: ModelsConfig = JSON.parse(JSON.stringify(models)) as ModelsConfig;
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = e[k];
        if (v && v.trim()) return v.trim();
      }
      return undefined;
    };
    const panelManaged = (section: ModelSection): boolean => next[section]?.configSource === 'panel';

    // The environment fills a key in; it no longer overrides one. A key typed
    // into the panel is stored in models.json (0600) and must win, otherwise
    // saving it would appear to work and change nothing whenever a generic
    // variable like OPENAI_API_KEY happens to exist.
    const chatKey = pick(next.chat.apiKeyEnv ?? '', 'SOOYA_CHAT_API_KEY', 'OPENAI_API_KEY');
    if (chatKey && !next.chat.apiKey) next.chat.apiKey = chatKey;
    if (!panelManaged('chat')) {
      const chatBase = pick('SOOYA_CHAT_BASE_URL', 'OPENAI_BASE_URL');
      if (chatBase) next.chat.baseUrl = chatBase;
      const chatModel = pick('SOOYA_CHAT_MODEL');
      if (chatModel) next.chat.model = chatModel;
      const chatProvider = pick('SOOYA_CHAT_PROVIDER');
      if (chatProvider) next.chat.provider = chatProvider as ModelsConfig['chat']['provider'];
    }

    const embKey = pick(next.embedding.apiKeyEnv ?? '', 'SOOYA_EMBEDDING_API_KEY', 'OPENAI_API_KEY');
    if (embKey && !next.embedding.apiKey) next.embedding.apiKey = embKey;
    if (!panelManaged('embedding')) {
      const embBase = pick('SOOYA_EMBEDDING_BASE_URL');
      if (embBase) next.embedding.baseUrl = embBase;
      const embModel = pick('SOOYA_EMBEDDING_MODEL');
      if (embModel) {
        next.embedding.model = embModel;
        if (next.embedding.provider === 'none') next.embedding.provider = 'openai-embeddings';
      }
    }

    const imgKey = pick(next.image.apiKeyEnv ?? '', 'SOOYA_IMAGE_API_KEY', 'OPENAI_API_KEY');
    if (imgKey && !next.image.apiKey) next.image.apiKey = imgKey;
    if (!panelManaged('image')) {
      const imgBase = pick('SOOYA_IMAGE_BASE_URL');
      if (imgBase) next.image.baseUrl = imgBase;
      const imgModel = pick('SOOYA_IMAGE_MODEL');
      if (imgModel) {
        next.image.model = imgModel;
        if (next.image.provider === 'none') next.image.provider = 'openai-images';
      }
    }

    const ttsKey = pick(next.tts.apiKeyEnv ?? '', 'SOOYA_TTS_API_KEY', 'OPENAI_API_KEY');
    if (ttsKey && !next.tts.apiKey) next.tts.apiKey = ttsKey;
    if (!panelManaged('tts')) {
      const ttsBase = pick('SOOYA_TTS_BASE_URL');
      if (ttsBase) next.tts.baseUrl = ttsBase;
      const ttsModel = pick('SOOYA_TTS_MODEL');
      if (ttsModel) {
        next.tts.model = ttsModel;
        if (next.tts.provider === 'none') next.tts.provider = 'openai-tts';
      }
      const ttsVoice = pick('SOOYA_TTS_VOICE');
      if (ttsVoice) next.tts.voice = ttsVoice;
    }

    const sttKey = pick(next.stt.apiKeyEnv ?? '', 'SOOYA_STT_API_KEY', 'OPENAI_API_KEY');
    if (sttKey && !next.stt.apiKey) next.stt.apiKey = sttKey;
    if (!panelManaged('stt')) {
      const sttBase = pick('SOOYA_STT_BASE_URL');
      if (sttBase) next.stt.baseUrl = sttBase;
      const sttModel = pick('SOOYA_STT_MODEL');
      if (sttModel) {
        next.stt.model = sttModel;
        if (next.stt.provider === 'none') next.stt.provider = 'openai-transcriptions';
      }
    }
    return next;
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

    // Saving a section through the management API means the user explicitly
    // chose these values. Mark the whole edited section as panel-managed so an
    // old deployment environment variable cannot silently undo the save.
    for (const section of MODEL_SECTIONS) {
      const value = incoming[section];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        incoming[section] = { ...(value as Record<string, unknown>), configSource: 'panel' };
      }
    }

    // Merge onto the on-disk baseline, never onto the env-resolved config:
    // using the resolved config as the base would copy environment secrets
    // into the file on the next unrelated edit.
    const mergedFile = ModelsConfigSchema.parse(
      deepMerge(this.fileModels as unknown as Record<string, unknown>, incoming)
    );
    // A caller may legitimately set a key explicitly; only drop values that are
    // simply the environment's secret echoed back.
    const toPersist = this.stripEnvInjectedKeys(mergedFile, incoming);

    atomicWriteFileSync(this.modelsPath, JSON.stringify(toPersist, null, 2));
    try {
      fs.chmodSync(this.modelsPath, 0o600);
    } catch {
      /* best-effort */
    }
    this.fileModels = toPersist;
    this.models = this.applyEnvOverrides(toPersist);
    return this.models;
  }

  /**
   * Remove API keys that came from the environment rather than from the file
   * or from this very request, so secrets stay out of models.json.
   */
  private stripEnvInjectedKeys(next: ModelsConfig, incoming: Record<string, unknown>): ModelsConfig {
    const out = JSON.parse(JSON.stringify(next)) as Record<string, Record<string, unknown> | undefined>;
    const envResolved = this.applyEnvOverrides(
      JSON.parse(JSON.stringify(next)) as ModelsConfig
    ) as unknown as Record<string, Record<string, unknown> | undefined>;
    const fileBase = this.fileModels as unknown as Record<string, Record<string, unknown> | undefined>;

    for (const section of Object.keys(out)) {
      const target = out[section];
      if (!target || typeof target.apiKey !== 'string') continue;

      // An explicit key in this request is always honoured.
      const patchSection = incoming[section] as Record<string, unknown> | undefined;
      if (patchSection && typeof patchSection.apiKey === 'string') continue;

      const envValue = envResolved[section]?.apiKey;
      const fileValue = fileBase[section]?.apiKey ?? '';
      // Persist the file's own key; blank anything that only matches the env.
      if (typeof envValue === 'string' && envValue.length > 0 && target.apiKey === envValue && fileValue !== envValue) {
        target.apiKey = fileValue;
      }
    }
    return out as unknown as ModelsConfig;
  }

  /** Redacted view suitable for API responses. */
  safeModels(): Record<string, unknown> {
    const clone = JSON.parse(JSON.stringify(this.models)) as Record<string, Record<string, unknown> | undefined>;
    for (const section of Object.values(clone)) {
      if (!section) continue;
      if (typeof section.apiKey === 'string') {
        section.apiKeyConfigured = section.apiKey.length > 0;
        delete section.apiKey;
      }
    }
    return clone;
  }

  reload(): void {
    this.persona = this.loadPersona();
    this.models = this.loadModels();
  }
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