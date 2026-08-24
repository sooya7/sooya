import fsp from 'node:fs/promises';
import os from 'node:os';
import { z } from 'zod';
import { STICKER_ANALYSIS_VERSION } from '../core/stickers/constants.js';
import { JOB_PRIORITY } from '../core/job-priority.js';
import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';
import { MODEL_SLOTS, ModelPresetSchema, ModelPresetsSchema, PersonaSchema, type ModelPreset, type ModelSlot } from '../config/schema.js';
import { assertSafeUrl, HttpTimeoutError, SsrfError } from '../util/http.js';
import { ProviderNotConfiguredError, ProviderRequestError } from '../providers/types.js';
import { mediaMeta, toMediaRef } from '../db/repos/media.repo.js';
import { redactDiagnostic } from '../core/public-error.js';
import { DEFAULT_SPEECH_STYLE } from '../core/voice/style.js';
import { extractJsonObject } from '../util/json-extract.js';
import { OmbreCatalogUnavailableError } from '../core/ombre-admin.js';
import { AdminMessageRepo, type AdminHistoryOptions } from '../db/repos/message-admin.js';

function modelRows(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const body = payload as { data?: unknown; models?: unknown };
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.models)) return body.models;

  // NewAPI's documented /api/models response groups model names by channel:
  // { data: { "1": ["gpt-4o"], "2": ["gpt-image-1"] } }.
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    return Object.values(body.data as Record<string, unknown>).flatMap((group) => Array.isArray(group) ? group : []);
  }
  return [];
}

function discoveryUrls(rawBase: string): string[] {
  let base = rawBase.replace(/\/+$/, '');
  // Operators often paste the image-generation endpoint from the provider docs.
  // Discovery needs the API root, otherwise it would request
  // /images/generations/models.
  base = base.replace(/\/(?:images\/(?:generations|edits))$/i, '');
  const primary = base.endsWith('/models') ? base : `${base}/models`;
  const urls = [primary];
  try {
    const parsed = new URL(base);
    if (!base.endsWith('/models') && /\/v1$/i.test(parsed.pathname)) {
      urls.push(`${parsed.origin}/api/models`);
    }
  } catch {
    // assertSafeUrl below returns the user-facing invalid URL error.
  }
  return urls;
}

/** Admin API used by the built-in management panel. */
export function registerAdminRoutes(app: SooyaApp): void {
  const { server, repos, services, config } = app;
  const adminMessages = new AdminMessageRepo(app.db, repos.mediaText);
  const admin = requireAdminToken(app);
  const guard = { preHandler: admin };

  server.get('/api/admin/persona', guard, async () => ({ persona: config.getPersona() }));
  server.put('/api/admin/persona', guard, async (req, reply) => {
    const parsed = PersonaSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    try {
      const persona = config.setPersona(parsed.data);
      services.bus.publish('persona.updated', { persona: { name: persona.name, avatar: persona.avatar, userAvatar: persona.userAvatar, tagline: persona.tagline } });
      return { persona };
    } catch (err) {
      reply.code(400);
      return { error: 'invalid_persona', message: (err as Error).message };
    }
  });

  /**
   * Minimal voice-behavior surface (voice-system convergence §4.1): the
   * 「助手配置 → 语音行为」 panel edits exactly two knobs — whether she ever
   * sends voice at all, and the per-clip length cap. Provider parameters and
   * per-mood mappings were deliberately removed from this surface.
   */
  server.get('/api/admin/voice-behavior', guard, async () => {
    const speechStyle = repos.settings.get('voice.speechStyle', DEFAULT_SPEECH_STYLE);
    return { enabled: config.getPersona().voicePolicy.enabled, maxVoiceSeconds: speechStyle.maxVoiceSeconds };
  });

  server.put('/api/admin/voice-behavior', guard, async (req, reply) => {
    const parsed = z.object({
      enabled: z.boolean().optional(),
      maxVoiceSeconds: z.number().int().min(5).max(120).optional()
    }).safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    if (parsed.data.enabled !== undefined) {
      const persona = config.getPersona();
      config.setPersona({ voicePolicy: { ...persona.voicePolicy, enabled: parsed.data.enabled } });
    }
    if (parsed.data.maxVoiceSeconds !== undefined) {
      const current = repos.settings.get('voice.speechStyle', DEFAULT_SPEECH_STYLE);
      repos.settings.set('voice.speechStyle', { ...current, maxVoiceSeconds: parsed.data.maxVoiceSeconds });
    }
    const speechStyle = repos.settings.get('voice.speechStyle', DEFAULT_SPEECH_STYLE);
    repos.audit.add('voice', 'behavior.updated', null, parsed.data as Record<string, unknown>);
    return { enabled: config.getPersona().voicePolicy.enabled, maxVoiceSeconds: speechStyle.maxVoiceSeconds };
  });

  /** Saved model library. Settings-backed so it survives config reloads. */
  const PRESETS_KEY = 'models.presets';
  const StoredModelPresetSchema = ModelPresetSchema.extend({ apiKey: z.string().optional() });
  const StoredModelPresetsSchema = z.array(StoredModelPresetSchema).max(60);
  type StoredModelPreset = z.infer<typeof StoredModelPresetSchema>;

  type PublicModelPreset = ModelPreset & { apiKeyBound: boolean; apiKeyConfigured: boolean };

  const publicPreset = (preset: StoredModelPreset): PublicModelPreset => {
    const { apiKey, ...publicFields } = preset;
    return {
      ...publicFields,
      apiKeyBound: Object.prototype.hasOwnProperty.call(preset, 'apiKey'),
      apiKeyConfigured: apiKey !== undefined && apiKey.length > 0
    };
  };

  const readStoredPresets = (): StoredModelPreset[] => {
    const raw = repos.settings.get<unknown>(PRESETS_KEY, []);
    let legacyFree: unknown = raw;
    if (Array.isArray(raw)) {
      legacyFree = raw.filter((item) => !(item && typeof item === 'object' && (item as { slot?: unknown }).slot === 'stt'));
    }
    const parsed = StoredModelPresetsSchema.safeParse(legacyFree);
    if (Array.isArray(raw) && Array.isArray(legacyFree) && legacyFree.length !== raw.length) {
      repos.settings.set(PRESETS_KEY, parsed.success ? parsed.data : []);
    }
    return parsed.success ? parsed.data : [];
  };

  const readPresets = (): PublicModelPreset[] =>
    readStoredPresets().map(publicPreset);

  const savePublicPresets = (presets: ModelPreset[]): PublicModelPreset[] => {
    const existing = readStoredPresets();
    const stored = presets.map((preset) => {
      const previous = existing.find((item) => item.id === preset.id);
      return previous && previous.slot === preset.slot && Object.prototype.hasOwnProperty.call(previous, 'apiKey')
        ? { ...preset, apiKey: previous.apiKey }
        : preset;
    });
    repos.settings.set(PRESETS_KEY, stored);
    return stored.map(publicPreset);
  };

  server.get('/api/admin/model-presets', guard, async () => ({
    presets: readPresets(),
    slots: MODEL_SLOTS
  }));

  server.put('/api/admin/model-presets', guard, async (req, reply) => {
    const parsed = ModelPresetsSchema.safeParse((req.body as { presets?: unknown } | null)?.presets);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    const seen = new Set<string>();
    for (const preset of parsed.data) {
      if (seen.has(preset.id)) {
        reply.code(400);
        return { error: 'duplicate_id', message: `预设 id 重复：${preset.id}` };
      }
      seen.add(preset.id);
    }
    return { presets: savePublicPresets(parsed.data) };
  });

  server.post('/api/admin/model-presets/from-current', guard, async (req, reply) => {
    const parsed = ModelPresetSchema.safeParse((req.body as { preset?: unknown } | null)?.preset);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    const existing = readStoredPresets();
    if (existing.length >= 60) {
      reply.code(400);
      return { error: 'too_many_presets', message: '模型库最多保存 60 个预设' };
    }
    if (existing.some((item) => item.id === parsed.data.id)) {
      reply.code(400);
      return { error: 'duplicate_id', message: `预设 id 重复：${parsed.data.id}` };
    }
    const slotConfig = ['chat', 'vision', 'summary', 'director'].includes(parsed.data.slot)
      ? config.chatModelFor(parsed.data.slot as 'chat' | 'vision' | 'summary' | 'director')
      : (config.getModels() as unknown as Record<string, { apiKey?: unknown } | undefined>)[parsed.data.slot];
    const apiKey = typeof slotConfig?.apiKey === 'string' ? slotConfig.apiKey : '';
    const stored = [...existing, { ...parsed.data, apiKey }];
    repos.settings.set(PRESETS_KEY, stored);
    return { preset: publicPreset(stored[stored.length - 1]!) };
  });

  /** Assign a saved preset to its capability slot and rebuild the providers. */
  server.post('/api/admin/model-presets/:id/apply', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const preset = readStoredPresets().find((item) => item.id === id);
    if (!preset) {
      reply.code(404);
      return { error: 'not_found' };
    }
    try {
      config.setModels({
        [preset.slot]: {
          provider: preset.provider,
          model: preset.model,
          ...(preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
          ...(Object.prototype.hasOwnProperty.call(preset, 'apiKey') ? {
            apiKey: preset.apiKey,
            ...(preset.slot === 'tts' ? { apiKeyEnv: '' } : {})
          } : {})
        }
      });
    } catch (err) {
      reply.code(400);
      return { error: 'invalid_preset', message: (err as Error).message.slice(0, 500) };
    }
    services.capabilities.rebuild();
    return { applied: preset.slot, models: config.safeModels() };
  });

  server.get('/api/admin/models', guard, async () => ({ models: config.safeModels() }));
  server.put('/api/admin/models', guard, async (req, reply) => {
    try {
      config.setModels(req.body);
      services.capabilities.rebuild();
      services.webSearch.rebuild(config.getModels().webSearch);
      return { models: config.safeModels() };
    } catch (err) {
      reply.code(400);
      return { error: 'invalid_models', message: (err as Error).message.slice(0, 500) };
    }
  });

  const WebSearchTestSchema = z.object({
    provider: z.enum(['doubao', 'tavily', 'responses']),
    query: z.string().trim().min(1).max(300)
  });
  server.post('/api/admin/models/web-search/test', guard, async (req, reply) => {
    const parsed = WebSearchTestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    const { provider, query } = parsed.data;
    const chatConfig = config.getModels().chat;
    if (provider === 'responses' && (chatConfig.provider !== 'openai-responses' || !chatConfig.supportsTools)) {
      reply.code(409);
      return { error: 'responses_search_unavailable', message: '当前聊天模型未启用 Responses 原生搜索能力' };
    }
    const started = Date.now();
    try {
      const nativeSearch = provider === 'responses'
        ? async (signal: AbortSignal) => {
            const result = await services.capabilities.chatProvider().complete({
              messages: [{ role: 'user', content: [{ type: 'text', text: query }] }],
              maxTokens: 256,
              signal,
              webSearch: { enabled: true }
            });
            if (!result.webSearch?.used) return null;
            return {
              provider: 'responses' as const,
              query,
              answer: result.text,
              citations: result.webSearch.citations
            };
          }
        : undefined;
      const search = config.getModels().webSearch;
      const result = await services.webSearch.test(provider, { query, maxResults: search.maxResults }, nativeSearch);
      if (!result) {
        reply.code(502);
        return { error: 'search_test_failed', provider, message: '没有获得可用搜索结果' };
      }
      return { ok: true, provider, latencyMs: Date.now() - started, resultCount: result.citations.length };
    } catch (error) {
      repos.errors.add('web-search.test', `${provider}:failed`, { diagnostic: redactDiagnostic(error) });
      reply.code(502);
      return { error: 'search_test_failed', provider, message: '搜索连接测试失败' };
    }
  });

  /**
   * Ask the configured endpoint which models it serves, so the model name can be
   * picked instead of typed from memory.
   *
   * The key never leaves the server: the panel sends at most a base URL, and the
   * credential is taken from the saved config. `baseUrl` is
   * accepted so the list can be pulled for an address that is still unsaved in
   * the form, which is exactly when you need it.
   */
  const DISCOVERABLE = new Set([
    'openai-chat',
    'openai-responses',
    'openai-compatible',
    'openai-embeddings',
    'openai-images',
    'openai-tts',
    'openai-rerank',
    'anthropic-messages'
  ]);
  server.post('/api/admin/models/:slot/discover', guard, async (req, reply) => {
    const slot = (req.params as { slot?: string }).slot as ModelSlot | undefined;
    if (!slot || !MODEL_SLOTS.includes(slot)) {
      reply.code(400);
      return { error: 'bad_request', message: '未知的能力槽位' };
    }
    const parsed = z.object({ baseUrl: z.string().max(300).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    const saved = (config.getModels() as unknown as Record<string, { provider?: string; baseUrl?: string; apiKey?: string; newApiUserId?: string } | undefined>)[slot];
    const provider = saved?.provider ?? 'none';
    if (!DISCOVERABLE.has(provider)) {
      // A vendor-specific protocol has no /models route. Saying so beats a
      // network error the reader has to reverse-engineer.
      reply.code(400);
      return { error: 'discovery_unsupported', message: `「${provider}」这种接口不提供模型列表，模型名需要手填` };
    }
    const base = (parsed.data.baseUrl ?? saved?.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) {
      reply.code(400);
      return { error: 'missing_base_url', message: '先填接口地址再拉取' };
    }
    const urls = discoveryUrls(base);
    try {
      for (const url of urls) await assertSafeUrl(url, app.env.ALLOW_PRIVATE_NETWORK_FETCH);
    } catch (err) {
      reply.code(400);
      return { error: 'unsafe_url', message: (err as Error).message.slice(0, 200) };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      // Anthropic lists models on the same path but authenticates differently;
      // sending it a bearer token would just come back 401.
      const headers: Record<string, string> = saved?.apiKey
        ? provider === 'anthropic-messages'
          ? { 'x-api-key': saved.apiKey, 'anthropic-version': '2023-06-01' }
          : { authorization: `Bearer ${saved.apiKey}` }
        : {};
      if (saved?.newApiUserId?.trim()) headers['New-Api-User'] = saved.newApiUserId.trim();
      let url = urls[0]!;
      let res = await (app.fetchImpl ?? fetch)(url, { headers, signal: controller.signal });
      // NewAPI exposes its frontend model list at /api/models. Newer versions
      // may serve /v1/models too, so only try the fallback when the standard
      // route is genuinely absent.
      if (!res.ok && (res.status === 404 || res.status === 405) && urls[1]) {
        url = urls[1];
        res = await (app.fetchImpl ?? fetch)(url, { headers, signal: controller.signal });
      }
      if (!res.ok) {
        reply.code(502);
        return { error: 'discovery_failed', message: `拉取失败：HTTP ${res.status}` };
      }
      const payload = await res.json();
      const rows = modelRows(payload);
      const ids = [...new Set(
        rows
          .map((row) => (typeof row === 'string' ? row : (row as { id?: unknown; name?: unknown })?.id ?? (row as { name?: unknown })?.name))
          .filter((id): id is string => typeof id === 'string' && !!id.trim())
          .map((id) => id.trim())
      )].sort((a, b) => a.localeCompare(b)).slice(0, 300);
      if (!ids.length) {
        reply.code(502);
        return { error: 'discovery_empty', message: '接口返回了列表，但里面没有可用的模型名' };
      }
      return { models: ids, source: url };
    } catch (err) {
      repos.errors.add('admin.discover', (err as Error).message);
      reply.code(502);
      return { error: 'discovery_failed', message: (err as Error).message.slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  });

  /**
   * Probe one slot's saved config with a single real request.
   *
   * `inspectHealth()` -- and therefore `/api/admin/capabilities` -- deliberately
   * never calls the endpoint: it only reports whether a slot *looks* configured
   * ("configured (endpoint not called)"). That leaves the panel unable to tell
   * "saved" from "actually works", which is the question this route answers.
   *
   * Deliberate limits: one call against the currently saved config (the key
   * never leaves the server, so the panel sends no body), the cheapest request
   * that still exercises credentials + model name + response shape, and no
   * polling. Slots whose cheapest call is not cheap (image generation) or needs
   * a sample the panel does not have (transcription) say so instead of billing
   * the user for a health check.
   */
  const PROBE_TEXT = '你好';
  const VISION_PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  interface ProbeOutcome {
    provider: string;
    model?: string;
    detail: string;
  }
  server.post('/api/admin/models/:slot/test', guard, async (req, reply) => {
    const slot = (req.params as { slot?: string }).slot as ModelSlot | undefined;
    if (!slot || !MODEL_SLOTS.includes(slot)) {
      reply.code(400);
      return { error: 'bad_request', message: '未知的能力槽位' };
    }
    if (slot === 'image' && (req.body as { force?: unknown } | null)?.force !== true) {
      reply.code(400);
      return {
        error: 'test_unsupported',
        slot,
        message: '出图会产生真实生成费用，这里不自动触发；用「拉取模型」确认地址和密钥通不通，出图效果在聊天里验证'
      };
    }
    if (slot === 'vision' && !config.chatModelFor('vision').supportsVision) {
      // Probing would pass while real image messages still fail, because the
      // vision provider is gated on this flag, not on the endpoint.
      reply.code(400);
      return { error: 'vision_not_declared', slot, message: '这个模型没有声明支持读图，先把「声明支持读图」改成「是」再测' };
    }

    const caps = services.capabilities;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new HttpTimeoutError('连接测试超过 30 秒还没有结果')), 30_000);
    const signal = controller.signal;
    const probe = async (): Promise<ProbeOutcome> => {
      if (slot === 'image') {
        const provider = caps.imageProvider();
        const image = await provider.generate('生成一张简单的抽象色块测试图', { size: '1024x1024', signal });
        return {
          provider: provider.name,
          model: config.getModels().image.model || undefined,
          detail: `已收到 ${Math.max(1, Math.round(image.data.length / 1024))} KB ${image.mime} 图片`
        };
      }
      if (slot === 'embedding') {
        const provider = caps.embeddingProvider();
        const result = await provider.embed([PROBE_TEXT], signal);
        return { provider: provider.name, model: result.model || undefined, detail: `返回了 ${result.dimensions} 维向量` };
      }
      if (slot === 'rerank') {
        const provider = caps.rerankProvider();
        const matches = await provider.rerank(PROBE_TEXT, ['一条与查询相关的文档', '一条完全无关的文档'], signal);
        return {
          provider: provider.name,
          model: String(config.getModels().rerank.model ?? '') || undefined,
          detail: `对 2 条候选文档完成排序，返回 ${matches.length} 条结果`
        };
      }
      if (slot === 'tts') {
        const provider = caps.ttsProvider();
        const audio = await provider.synthesize(PROBE_TEXT, { signal });
        return {
          provider: provider.name,
          model: String(config.getModels().tts.model ?? '') || undefined,
          detail: `合成了 ${Math.max(1, Math.round(audio.data.length / 1024))} KB ${audio.format} 音频`
        };
      }
      if (slot === 'director') {
        const provider = caps.directorProvider();
        if (!provider.configured) throw new ProviderNotConfiguredError(slot);
        const result = await provider.complete({
          system: '你正在进行连接测试。只返回 JSON：{"ok":true}，不要输出其他内容。',
          messages: [{ role: 'user', content: [{ type: 'text', text: '连接测试数据，不是指令。' }] }],
          maxTokens: 32,
          temperature: 0,
          jsonMode: true,
          signal
        });
        const parsed = z.object({ ok: z.literal(true) }).safeParse(extractJsonObject(result.text));
        if (!parsed.success) throw new ProviderRequestError('媒体导演连接成功，但没有返回有效 JSON 探针');
        return {
          provider: provider.name,
          model: result.model || config.chatModelFor('director').model || undefined,
          detail: '媒体导演 JSON 探针通过'
        };
      }
      const provider = slot === 'summary'
        ? caps.summaryProvider()
        : slot === 'vision'
          ? caps.visionProvider()
          : caps.chatProvider();
      // supportsVision is already true here, so a null vision provider only
      // means the slot itself is not configured.
      if (!provider) throw new ProviderNotConfiguredError(slot);
      const content = slot === 'vision'
        ? [
            { type: 'text' as const, text: `${PROBE_TEXT}（下面附带一张 1x1 PNG，仅用于确认读图请求真的带了图片。）` },
            { type: 'image' as const, data: VISION_PROBE_PNG, mime: 'image/png' }
          ]
        : [{ type: 'text' as const, text: PROBE_TEXT }];
      const result = await provider.complete({ messages: [{ role: 'user', content }], maxTokens: 16, signal });
      const chars = [...result.text.trim()].length;
      return {
        provider: provider.name,
        model: result.model || undefined,
        // An empty body with a 200 still proves the round trip; truncation at
        // maxTokens must not be reported as a broken connection.
        detail: chars ? `模型回了 ${chars} 个字` : '接口通了，但这次没有返回文本（可能被最大输出 token 截断）'
      };
    };

    const startedAt = Date.now();
    try {
      const outcome = await probe();
      return { ok: true, slot, latencyMs: Date.now() - startedAt, ...outcome };
    } catch (err) {
      const error = err as Error;
      const latencyMs = Date.now() - startedAt;
      const detail = error.message.slice(0, 300);
      if (error instanceof ProviderNotConfiguredError) {
        reply.code(400);
        return { error: 'not_configured', slot, message: '这个能力还没配全（接口协议、地址、模型名、密钥缺一不可）', detail };
      }
      if (error instanceof SsrfError) {
        reply.code(400);
        return { error: 'unsafe_url', slot, message: `接口地址不允许访问：${detail}`, detail };
      }
      repos.errors.add('admin.model-test', `${slot}: ${detail}`);
      const status = error instanceof ProviderRequestError ? error.status : undefined;
      reply.code(502);
      if (status && status >= 400 && status < 500) {
        const isAuth = status === 401 || status === 403;
        return {
          error: isAuth ? 'auth_failed' : 'request_rejected',
          slot,
          status,
          latencyMs,
          message: isAuth
            ? `鉴权失败（HTTP ${status}）：密钥不对，或者这把密钥没有这个模型的权限`
            : `接口拒绝了这次请求（HTTP ${status}）：模型名或参数可能不对`,
          detail
        };
      }
      if (status && status >= 500) {
        return { error: 'upstream_error', slot, status, latencyMs, message: `上游服务出错（HTTP ${status}），过一会儿再试`, detail };
      }
      if (error instanceof HttpTimeoutError) {
        return { error: 'timeout', slot, latencyMs, message: `请求超时：${detail}`, detail };
      }
      return { error: 'unreachable', slot, latencyMs, message: `连不上接口地址：${detail}`, detail };
    } finally {
      clearTimeout(timer);
    }
  });

  server.get('/api/admin/capabilities', guard, async () => ({
    capabilities: await services.capabilities.statuses(),
    embeddingDimensions: services.capabilities.embeddingDimensions(),
    policy: services.capabilityPolicy
  }));

  server.put('/api/admin/tts', guard, async (req, reply) => {
    const schema = z.object({
      model: z.record(z.unknown()).optional(),
      policy: z.object({
        enabled: z.boolean().optional(),
        frequency: z.enum(['never', 'low', 'medium', 'high']).optional(),
        maxCharsPerClip: z.number().int().min(20).max(2000).optional(),
        alwaysAttachTranscript: z.boolean().optional()
      }).optional()
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    if (parsed.data.model) {
      config.setModels({ tts: parsed.data.model });
      services.capabilities.rebuild();
    }
    if (parsed.data.policy) {
      const persona = config.getPersona();
      config.setPersona({ voicePolicy: { ...persona.voicePolicy, ...parsed.data.policy } });
    }
    return { models: config.safeModels(), voicePolicy: config.getPersona().voicePolicy };
  });

  server.put('/api/admin/image', guard, async (req, reply) => {
    const schema = z.object({
      model: z.record(z.unknown()).optional(),
      policy: z.object({
        enabled: z.boolean().optional(),
        frequency: z.enum(['never', 'low', 'medium', 'high']).optional(),
        maxPerReply: z.number().int().min(0).max(4).optional()
      }).optional()
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    if (parsed.data.model) {
      config.setModels({ image: parsed.data.model });
      services.capabilities.rebuild();
    }
    if (parsed.data.policy) {
      const persona = config.getPersona();
      config.setPersona({ imagePolicy: { ...persona.imagePolicy, ...parsed.data.policy } });
    }
    return { models: config.safeModels(), imagePolicy: config.getPersona().imagePolicy };
  });

  server.get('/api/admin/stickers', guard, async (req, reply) => {
    const parsed = z.object({
      q: z.string().trim().max(200).optional(),
      status: z.enum(['pending', 'processing', 'ready', 'failed']).optional(),
      source: z.enum(['legacy', 'ai', 'manual']).optional(),
      emotion: z.string().trim().max(40).optional(),
      // Boolean("false") is true, so z.coerce.boolean() would make the
      // disabled filter impossible to use from a query string.
      enabled: z.preprocess((value) => value === undefined ? undefined : value === true || value === 'true', z.boolean().optional()),
      sort: z.enum(['created', 'name', 'recent', 'usage']).default('created'),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      offset: z.coerce.number().int().min(0).default(0)
    }).safeParse(req.query);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const filters = { q: parsed.data.q, enabled: parsed.data.enabled, status: parsed.data.status, source: parsed.data.source, emotion: parsed.data.emotion };
    const stickers = repos.stickers.list({ ...filters, sort: parsed.data.sort, limit: parsed.data.limit, offset: parsed.data.offset });
    const total = repos.stickers.countFiltered(filters);
    const page = stickers.map((sticker) => {
      const media = repos.media.get(sticker.mediaId);
      // The vector is an internal retrieval artifact; returning it would make
      // the admin list needlessly large and expose implementation details.
      return { ...sticker, embedding: undefined, mime: media?.mime, animated: media?.animated === 1, available: media ? services.mediaStore.exists(media) : false, hasEmbedding: Boolean(sticker.embedding) };
    });
    return { stickers: page, total, offset: parsed.data.offset, facets: repos.stickers.facets(filters), analysisVersion: STICKER_ANALYSIS_VERSION };
  });
  server.post('/api/admin/stickers', guard, async (req, reply) => {
    if (!req.isMultipart()) {
      reply.code(400);
      return { error: 'expected_multipart' };
    }
    const created: unknown[] = [];
    const failed: Array<{ filename: string; error: string }> = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const fields = part.fields as Record<string, { value?: string } | undefined>;
      const name = (fields.name?.value ?? part.filename ?? 'sticker').replace(/\.[^.]+$/, '').slice(0, 60);
      const emotion = fields.emotion?.value ?? 'neutral';
      const tags = (fields.tags?.value ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
      try {
        const buffer = await part.toBuffer();
        await services.storage.assertWritable(buffer.length);
        const media = await services.mediaStore.save({ kind: 'sticker', origin: 'upload', data: buffer, declaredMime: part.mimetype, filename: part.filename });
        const unique = repos.stickers.getByName(name) ? `${name}-${Date.now().toString(36)}` : name;
        const sticker = repos.stickers.create({ mediaId: media.id, name: unique, tags: tags.length ? tags : [emotion], emotion, nameSource: 'manual' });
        created.push(sticker);
        repos.jobs.enqueue('sticker.analyze', { stickerId: sticker.id }, { maxAttempts: 2, priority: JOB_PRIORITY.stickerAnalyze });
      } catch (err) {
        failed.push({ filename: part.filename ?? 'unknown', error: (err as Error).message });
      }
    }
    if (created.length === 0) {
      reply.code(400);
      return { created, failed };
    }
    return { created, failed };
  });

  server.patch('/api/admin/stickers/:id', guard, async (req, reply) => {
    const parsed = z.object({ tags: z.array(z.string()).optional(), emotion: z.string().optional(), enabled: z.boolean().optional(), name: z.string().min(1).max(60).optional(), description: z.string().max(500).optional(), imageText: z.string().max(300).optional(), userMeaning: z.string().max(120).optional(), favorite: z.boolean().optional(), userMeaningSource: z.enum(['none', 'ai', 'manual']).optional() }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    const { favorite, userMeaning, userMeaningSource, description, imageText, tags, ...stickerPatch } = parsed.data;
    const id = (req.params as { id: string }).id;
    let updated = repos.stickers.update(id, stickerPatch);
    if (updated && (description !== undefined || imageText !== undefined || tags !== undefined)) {
      updated = repos.stickers.updateManualSemantics(updated.id, { description, imageText, tags });
    }
    if (updated && userMeaning !== undefined) {
      updated = repos.stickers.setUserMeaning(updated.id, userMeaning, userMeaningSource ?? 'manual');
    } else if (updated && userMeaningSource !== undefined) {
      updated = repos.stickers.update(updated.id, { userMeaningSource });
    }
    if (updated && favorite !== undefined) updated = repos.stickers.setFavorite(updated.id, favorite);
    if (!updated) {
      reply.code(404);
      return { error: 'not_found' };
    }
    if (updated && (parsed.data.description !== undefined || parsed.data.imageText !== undefined || parsed.data.tags !== undefined || parsed.data.name !== undefined || parsed.data.userMeaning !== undefined)) {
      if (updated.analysisStatus === 'ready') repos.jobs.enqueue('sticker.embed', { stickerId: updated.id }, { maxAttempts: 2 });
      services.bus.publish('sticker.updated', { stickerId: updated.id, semantic: true });
    }
    return { sticker: updated };
  });

  server.post('/api/admin/stickers/analyze-batch', guard, async (req, reply) => {
    const parsed = z.object({ mode: z.enum(['missing_or_stale', 'selected']).default('missing_or_stale'), ids: z.array(z.string().min(1)).max(200).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const source = parsed.data.ids?.map((id) => repos.stickers.get(id)).filter((sticker): sticker is NonNullable<typeof sticker> => Boolean(sticker)) ?? repos.stickers.list({ enabledOnly: false });
    const candidates = source.filter((sticker) => sticker.analysisSource !== 'manual' && (parsed.data.mode === 'selected' || sticker.analysisStatus !== 'ready' || sticker.analysisVersion < STICKER_ANALYSIS_VERSION));
    if (candidates.length > 0) {
      repos.jobs.enqueue('sticker.analyze.backfill', { ids: candidates.map((sticker) => sticker.id) }, { maxAttempts: 2, priority: JOB_PRIORITY.stickerAnalyze });
    }
    return { queued: candidates.length, skipped: source.length - candidates.length };
  });

  server.post('/api/admin/stickers/:id/analyze', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const sticker = repos.stickers.get(id);
    if (!sticker) { reply.code(404); return { error: 'not_found' }; }
    const force = (req.body as { force?: unknown } | null)?.force === true;
    if (sticker.analysisSource === 'manual' && !force) { reply.code(409); return { error: 'manual_semantics_protected' }; }
    const expectedSemanticRevision = sticker.semanticRevision;
    repos.stickers.setAnalysisState(id, { status: 'pending', error: null }, { allowManual: force });
    const job = repos.jobs.enqueue('sticker.analyze', { stickerId: id, force, expectedSemanticRevision }, { maxAttempts: 2, priority: JOB_PRIORITY.stickerAnalyze });
    return { queued: true, jobId: job.id, stickerId: id };
  });

  server.delete('/api/admin/stickers/:id', guard, async (req, reply) => {
    const sticker = repos.stickers.get((req.params as { id: string }).id);
    if (!sticker) {
      reply.code(404);
      return { error: 'not_found' };
    }
    /*
     * A sticker that was sent in chat lives on as a message part pointing at
     * the sticker's media. Deleting the media here used to turn every such
     * history bubble into a broken image, silently and irreversibly -- the same
     * failure permanent media deletion already refuses with a 409. The
     * `stickers` bucket of references() counts this sticker's own row, so only
     * the other buckets mean something else would break.
     */
    const references = repos.media.references(sticker.mediaId);
    if (references.messageParts > 0) {
      reply.code(409);
      return { error: 'sticker_is_referenced', references };
    }
    repos.stickers.delete(sticker.id);
    await services.mediaStore.delete(sticker.mediaId);
    repos.audit.add('sticker', 'deleted', sticker.id);
    return { deleted: true };
  });

  server.get('/api/admin/mcp/servers', guard, async () => services.ombreAdmin.mcpOverview());
  server.get('/api/admin/mcp/tools/:name', guard, async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const tool = services.ombreAdmin.toolSchema(name);
    if (!tool) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return { tool };
  });
  server.post('/api/admin/mcp/:serverId/test', guard, async (req, reply) => {
    try {
      const snapshot = await services.mcpManager.test((req.params as { serverId: string }).serverId);
      return { ok: snapshot.state === 'ready', server: snapshot };
    } catch (error) {
      reply.code(502);
      return { ok: false, error: 'mcp_test_failed', message: 'MCP 连接测试失败。' };
    }
  });
  server.post('/api/admin/mcp/:serverId/refresh-tools', guard, async (req, reply) => {
    try {
      const snapshot = await services.mcpManager.refreshTools((req.params as { serverId: string }).serverId);
      return { ok: true, server: snapshot };
    } catch (error) {
      reply.code(502);
      return { ok: false, error: 'mcp_refresh_failed', message: 'MCP 工具刷新失败。' };
    }
  });

  server.get('/api/admin/memory/status', guard, async () => services.ombreAdmin.status());
  server.post('/api/admin/memory/commit/:batchId/:revision/retry', guard, async (req, reply) => {
    const params = req.params as { batchId?: string; revision?: string };
    const batchId = String(params.batchId ?? '');
    const revision = Number(params.revision ?? 0);
    if (!/^[A-Za-z0-9_-]{1,120}$/u.test(batchId) || !Number.isInteger(revision) || revision < 1) {
      reply.code(400);
      return { error: 'bad_request' };
    }
    const receipt = repos.ombreCommits.get(batchId, revision);
    if (!receipt) {
      reply.code(404);
      return { error: 'commit_not_found' };
    }
    if (receipt.state !== 'uncertain') {
      reply.code(409);
      return { error: 'commit_not_uncertain', state: receipt.state };
    }
    if (!repos.replyBatches.isCurrentRevision(batchId, revision)) {
      reply.code(409);
      return { error: 'revision_fence' };
    }
    let detail: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(receipt.detail_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>;
    } catch { /* malformed detail cannot be used for a safe retry */ }
    const userMessageIds = Array.isArray(detail.userMessageIds) ? detail.userMessageIds.map(String).filter(Boolean) : [];
    const assistantMessageId = typeof detail.assistantMessageId === 'string' ? detail.assistantMessageId : '';
    if (!userMessageIds.length || !assistantMessageId) {
      reply.code(409);
      return { error: 'commit_retry_receipt_incomplete' };
    }
    repos.jobs.enqueue('ombre.memory_commit', {
      batchId,
      revision,
      userMessageIds,
      assistantMessageId,
      manualRetry: true
    }, { maxAttempts: 1 });
    repos.audit.add('ombre', 'memory.commit.retry', batchId, { revision });
    return { queued: true, batchId, revision };
  });
  server.get('/api/admin/memory/activity', guard, async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    return { activity: services.ombreAdmin.activity(limit) };
  });
  server.get('/api/admin/memory/legacy', guard, async (req) => {
    const query = req.query as { limit?: string; offset?: string };
    return services.ombreAdmin.legacy(Number(query.limit ?? 100), Number(query.offset ?? 0));
  });
  server.get('/api/admin/memory/ombre/search', guard, async (req, reply) => {
    const query = req.query as { q?: string; limit?: string };
    try {
      return await services.ombreAdmin.search(query.q ?? '', Number(query.limit ?? 10));
    } catch (error) {
      reply.code(502);
      return { error: 'ombre_search_failed', message: 'Ombre 搜索暂时不可用' };
    }
  });
  server.get('/api/admin/memory/ombre/catalog', guard, async (req, reply) => {
    try {
      return await services.ombreAdmin.catalog(Number((req.query as { limit?: string }).limit ?? 50));
    } catch (error) {
      if (error instanceof OmbreCatalogUnavailableError) {
        reply.code(409);
        return { error: error.code, message: '当前 Ombre 版本未提供可读目录接口' };
      }
      reply.code(502);
      return { error: 'ombre_catalog_failed', message: 'Ombre 目录暂时不可用' };
    }
  });

  server.get('/api/admin/memories', guard, async (req) => {
    const q = req.query as { limit?: string; offset?: string; kind?: string };
    return {
      memories: repos.memories.list({ limit: Number(q.limit ?? 100), offset: Number(q.offset ?? 0), kind: q.kind as never }),
      backend: app.env.MEMORY_BACKEND,
      readOnly: app.env.MEMORY_BACKEND === 'ombre',
      stats: services.memory.stats(),
      ...(app.env.MEMORY_BACKEND === 'ombre' ? {} : { recall: services.context.memoryRecallTrace() })
    };
  });
  server.patch('/api/admin/memories/:id', guard, async (req, reply) => {
    if (app.env.MEMORY_BACKEND === 'ombre') {
      reply.code(409);
      return { error: 'memory_backend_ombre', message: '长期记忆已由 Ombre Brain 管理，请使用 MCP/Dashboard。' };
    }
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { content?: string; importance?: number; confidence?: number };
    if (body.content !== undefined && (typeof body.content !== 'string' || !body.content.trim())) {
      reply.code(400);
      return { error: 'bad_request', message: 'content must be a non-empty string' };
    }
    const updated = repos.memories.update(id, {
      ...(body.content !== undefined ? { content: body.content.trim() } : {}),
      ...(typeof body.importance === 'number' ? { importance: body.importance } : {}),
      ...(typeof body.confidence === 'number' ? { confidence: body.confidence } : {})
    });
    if (!updated) {
      reply.code(404);
      return { error: 'not_found' };
    }
    services.bus.publish('memory.updated', { id });
    return { memory: updated };
  });
  server.delete('/api/admin/memories/:id', guard, async (req, reply) => {
    if (app.env.MEMORY_BACKEND === 'ombre') {
      reply.code(409);
      return { error: 'memory_backend_ombre', message: '长期记忆已由 Ombre Brain 管理，请使用 MCP/Dashboard。' };
    }
    const ok = repos.memories.delete((req.params as { id: string }).id);
    if (!ok) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return { deleted: true };
  });
  server.post('/api/admin/memories/clear', guard, async (_req, reply) => {
    if (app.env.MEMORY_BACKEND === 'ombre') {
      reply.code(409);
      return { cleared: false, error: 'memory_backend_ombre', message: '长期记忆已由 Ombre Brain 管理。' };
    }
    const result = services.memory.clearAll();
    services.bus.publish('memory.updated', { cleared: true, ...result });
    return { cleared: true, ...result, stats: services.memory.stats() };
  });

  server.get('/api/admin/media', guard, async (req) => {
    const q = req.query as { q?: string; limit?: string; offset?: string; kind?: string; origin?: string; state?: string; sort?: string };
    const rows = repos.media.listAdmin({
      q: q.q,
      limit: Number(q.limit ?? 40),
      offset: Number(q.offset ?? 0),
      kind: ['image', 'audio', 'sticker', 'file'].includes(q.kind ?? '') ? q.kind as never : undefined,
      origin: ['upload', 'generated', 'builtin', 'remote'].includes(q.origin ?? '') ? q.origin as never : undefined,
      state: q.state === 'trashed' || q.state === 'all' ? q.state : 'active',
      sort: q.sort === 'size' || q.sort === 'usage' ? q.sort : 'created'
    });
    return {
      media: rows.map((row) => ({
        ...toMediaRef(row),
        origin: row.origin,
        exists: services.mediaStore.exists(row),
        createdAt: row.created_at,
        deletedAt: row.deleted_at,
        favorite: row.favorite === 1,
        usageCount: row.usage_count,
        references: { messageParts: row.message_parts, stickers: row.stickers, moments: row.moments, voiceGenerations: row.voice_generations },
        ...mediaMeta(row)
      })),
      total: repos.media.countAdmin({ q: q.q, kind: ['image', 'audio', 'sticker', 'file'].includes(q.kind ?? '') ? q.kind as never : undefined, origin: ['upload', 'generated', 'builtin', 'remote'].includes(q.origin ?? '') ? q.origin as never : undefined, state: q.state === 'trashed' || q.state === 'all' ? q.state : 'active' }),
      offset: Number(q.offset ?? 0)
    };
  });

  server.get('/api/admin/media/:id/usage', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = repos.media.get(id);
    if (!row) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const references = repos.media.references(id);
    return {
      mediaId: id,
      usageCount: references.total + (services.storage.isAvatarMedia(id) ? 1 : 0),
      references,
      avatar: services.storage.isAvatarMedia(id)
    };
  });

  server.get('/api/admin/media/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = repos.media.get(id);
    if (!row) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const references = repos.media.references(id);
    const avatar = services.storage.isAvatarMedia(id);
    return {
      media: {
        ...toMediaRef(row),
        origin: row.origin,
        exists: services.mediaStore.exists(row),
        createdAt: row.created_at,
        deletedAt: row.deleted_at,
        favorite: row.favorite === 1,
        tags: mediaMeta(row).tags,
        meta: mediaMeta(row).meta,
        references,
        usageCount: references.total + (avatar ? 1 : 0),
        avatar
      }
    };
  });

  server.get('/api/admin/chat/history', guard, async (req, reply) => {
    const parsed = z.object({
      q: z.string().trim().max(200).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      role: z.enum(['user', 'assistant']).optional(),
      hasMedia: z.preprocess((value) => value === undefined ? undefined : value === true || value === 'true', z.boolean().optional()),
      mediaKind: z.enum(['image', 'audio', 'sticker', 'file']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(40),
      offset: z.coerce.number().int().min(0).default(0)
    }).safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    return adminMessages.page(parsed.data as AdminHistoryOptions);
  });

  server.get('/api/admin/chat/history/:id/context', guard, async (req, reply) => {
    const parsed = z.object({ before: z.coerce.number().int().min(0).max(50).default(10), after: z.coerce.number().int().min(0).max(50).default(10) }).safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    const context = adminMessages.context((req.params as { id: string }).id, parsed.data.before, parsed.data.after);
    if (!context) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return context;
  });

  /** Legacy endpoint now performs a reversible soft delete. */
  server.delete('/api/admin/media/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const references = repos.media.references(id);
    const avatar = services.storage.isAvatarMedia(id);
    if (references.total > 0 || avatar) {
      reply.code(409);
      return { error: 'media_in_use', references, avatar };
    }
    if (!repos.media.trash(id)) {
      reply.code(404);
      return { error: 'not_found' };
    }
    repos.audit.add('media', 'trashed.legacy', id);
    return { deleted: true, trashed: true };
  });

  server.get('/api/admin/metrics', guard, async (req) => {
    const days = Math.max(1, Math.min(90, Number((req.query as { days?: string }).days ?? 7)));
    return { aggregates: app.services.metrics.aggregates(days), daily: app.services.metrics.daily(days) };
  });

  // 分布统计（min/max/mean/p50/p95，本地日期窗口，完整版 §10）。
  server.get('/api/admin/metrics/distributions', guard, async (req) => {
    const days = Math.max(1, Math.min(90, Number((req.query as { days?: string }).days ?? 7)));
    return { distributions: app.services.metrics.distributions(days) };
  });

  // 版本对比：currentDays 为当前窗口，previousDays 为其前等长基线窗口。
  // Weather admin surface (restored: accidentally removed with the shadow/
  // experiments cleanup). Weather identity is the active city.
  server.get('/api/admin/weather/status', guard, async () => {
    const snapshot = services.world.snapshot();
    const observedAt = snapshot.weather?.observedAt ? Date.parse(snapshot.weather.observedAt) : NaN;
    const now = Date.parse(snapshot.now);
    const cacheAgeSec = Number.isFinite(observedAt)
      ? Math.max(0, Math.floor(((Number.isFinite(now) ? now : Date.now()) - observedAt) / 1000))
      : null;
    return {
      enabled: services.weather.isEnabled,
      provider: { name: services.weather.providerName, configured: services.weather.providerName !== null, active: services.weather.isEnabled },
      currentSource: snapshot.weather?.provider ?? null,
      cacheAgeSec,
      lastSnapshot: snapshot.weather ?? null,
      forecast: snapshot.forecast ?? null,
      daylight: snapshot.daylight ?? null,
      location: snapshot.location ? { id: snapshot.location.id, name: snapshot.location.name, kind: snapshot.location.kind } : null
    };
  });
  server.get('/api/admin/weather/forecast', guard, async () => {
    const snapshot = services.world.snapshot();
    return { forecast: snapshot.forecast ?? null, daylight: snapshot.daylight ?? null };
  });
  server.post('/api/admin/weather/refresh', guard, async () => {
    const world = await services.world.refreshAll({ forceCurrent: true });
    return { ok: true, snapshot: world.weather ?? null, presence: services.presence.sync('admin.weather.refresh') };
  });

  server.get('/api/admin/system', guard, async () => ({
    version: app.state.version,
    startedAt: app.state.startedAt,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    loadAvg: os.loadavg(),
    database: {
      recovered: app.state.dbRecovered,
      recoveredFrom: app.state.dbRecoveredFrom ?? null,
      inconsistent: app.state.dbInconsistent ?? null,
      messages: repos.messages.count(),
      media: repos.media.count(),
      memories: repos.memories.count(),
      summaries: repos.summaries.count(),
      pendingJobs: repos.jobs.pendingCount()
    },
    storage: await services.storage.status(),
    stream: { subscribers: services.bus.subscriberCount(), lastEventSeq: services.bus.lastSeq() },
    agent: { active: services.agents.active, tools: services.tools.list(), capabilities: services.agentCapabilities.list() }
  }));

  server.get('/api/admin/errors', guard, async (req) => ({ errors: repos.errors.list(Number((req.query as { limit?: string }).limit ?? 100)) }));
  server.delete('/api/admin/errors', guard, async () => { repos.errors.clear(); return { cleared: true }; });
  server.get('/api/admin/jobs', guard, async () => ({ jobs: repos.jobs.list(50) }));

  server.post('/api/admin/chat/clear', guard, async () => {
    repos.messages.clearAll();
    repos.events.clear();
    services.bus.publish('system.notice', { notice: 'chat cleared', reason: 'chat-cleared', action: 'reload', lastMessageSeq: 0 });
    return { cleared: true, messages: repos.messages.count() };
  });

  server.get('/api/admin/backups', guard, async () => ({ backups: await services.backups.list() }));
  server.post('/api/admin/backups', guard, async (_req, reply) => {
    try { return { backup: await services.backups.create('manual') }; }
    catch (err) { reply.code(500); return { error: 'backup_failed', message: (err as Error).message }; }
  });
  server.post('/api/admin/backups/:name/verify', guard, async (req) => await services.backups.verify((req.params as { name: string }).name));
  // §36: report-only media/db consistency; never deletes or rewrites anything.
  server.get('/api/admin/backups/integrity', guard, async () => await services.backups.integrityReport());
  server.post('/api/admin/backups/:name/restore', guard, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    try {
      const result = await services.backups.restore(name);
      services.bus.publish('system.notice', { notice: 'database restored from backup', backup: name, reason: 'database-restored', action: 'reload', lastMessageSeq: repos.messages.maxSeq() });
      return { restored: true, backupPath: result.restored, preservedAs: result.preservedAs };
    } catch (err) {
      reply.code(400);
      return { error: 'restore_failed', message: (err as Error).message };
    }
  });
  server.delete('/api/admin/backups/:name', guard, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!/^sooya-[\w.-]+\.db$/.test(name)) {
      reply.code(400);
      return { error: 'bad_name' };
    }
    const found = (await services.backups.list()).find((backup) => backup.name === name);
    if (!found) {
      reply.code(404);
      return { error: 'not_found' };
    }
    await fsp.rm(found.path, { force: true });
    await fsp.rm(`${found.path}.json`, { force: true });
    await fsp.rm(`${found.path}.sha256`, { force: true });
    repos.audit.add('backup', 'deleted', name);
    return { deleted: true };
  });

}
