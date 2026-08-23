import type { ConfigStore } from '../config/store.js';
import { createChatProvider, type ProviderDeps } from '../providers/chat/openai.js';
import { createEmbeddingProvider, OpenAIEmbeddingProvider } from '../providers/embedding.js';
import { createImageProvider } from '../providers/image.js';
import { createRerankProvider } from '../providers/rerank.js';
import { createTTSProvider } from '../providers/tts.js';
import { ProviderHealthTracker } from '../providers/health.js';
import type {
  ChatProvider,
  EmbeddingProvider,
  HealthStatus,
  ImageProvider,
  RerankProvider,
  TTSProvider
} from '../providers/types.js';

export type CapabilityName = 'chat' | 'vision' | 'summary' | 'director' | 'embedding' | 'image' | 'tts' | 'rerank';

/**
 * Central model gateway / capability registry.
 * Every capability is independently optional: a missing one never prevents boot
 * and is reported through `statuses()`.
 */
export class CapabilityRegistry {
  private chat!: ChatProvider;
  private vision!: ChatProvider;
  private summary!: ChatProvider;
  private director!: ChatProvider;
  private embedding!: EmbeddingProvider;
  private image!: ImageProvider;
  private tts!: TTSProvider;
  private rerank!: RerankProvider;

  /** §33 provider health: observed on every model call; embeddings never rerouted. */
  readonly health: ProviderHealthTracker;

  constructor(
    private readonly config: ConfigStore,
    private readonly deps: ProviderDeps,
    dbHandle?: import('../db/handle.js').DbLike
  ) {
    this.health = new ProviderHealthTracker(dbHandle);
    this.rebuild();
  }

  rebuild(): void {
    const models = this.config.getModels();
    this.chat = this.tracked('chat', createChatProvider(this.config.chatModelFor('chat'), this.deps));
    this.vision = this.tracked('vision', createChatProvider(this.config.chatModelFor('vision'), this.deps));
    this.summary = this.tracked('summary', createChatProvider(this.config.chatModelFor('summary'), this.deps));
    this.director = this.tracked('director', createChatProvider(this.config.chatModelFor('director'), this.deps));
    this.embedding = this.trackedEmbedding(createEmbeddingProvider(models.embedding, this.deps));
    this.image = createImageProvider(models.image, this.deps);
    this.tts = createTTSProvider(models.tts, this.deps);
    this.rerank = createRerankProvider(models.rerank, this.deps);
  }

  /** Wrap a chat provider so every complete/stream call feeds health (§33). */
  private tracked(capability: 'chat' | 'vision' | 'summary' | 'director', provider: ChatProvider): ChatProvider {
    const model = this.config.chatModelFor(capability).model;
    this.health.ensure(capability, model);
    const record = (ok: boolean, startedAt: number, failureType?: string) =>
      this.health.record(capability, model, { ok, latencyMs: Date.now() - startedAt, failureType });
    // Explicit delegation: `{...provider}` would drop prototype getters like
    // `configured`, which reads as "model not configured" downstream.
    return {
      get name() { return provider.name; },
      get configured() { return provider.configured; },
      get supportsTools() { return provider.supportsTools; },
      complete: async (req: Parameters<ChatProvider['complete']>[0]) => {
        const startedAt = Date.now();
        try {
          const result = await provider.complete(req);
          record(true, startedAt);
          return result;
        } catch (err) {
          record(false, startedAt, (err as Error).message.slice(0, 80));
          throw err;
        }
      },
      stream: async (req: Parameters<ChatProvider['stream']>[0], onChunk: Parameters<ChatProvider['stream']>[1]) => {
        const startedAt = Date.now();
        try {
          const result = await provider.stream(req, onChunk);
          record(true, startedAt);
          return result;
        } catch (err) {
          record(false, startedAt, (err as Error).message.slice(0, 80));
          throw err;
        }
      },
      inspectHealth: () => provider.inspectHealth()
    };
  }

  /** Embeddings are observed but NEVER rerouted (vector-space mismatch, 禁区 6). */
  private trackedEmbedding(provider: EmbeddingProvider): EmbeddingProvider {
    const model = this.config.getModels().embedding.model;
    this.health.ensure('embedding', model);
    return {
      get name() { return provider.name; },
      get configured() { return provider.configured; },
      inspectHealth: () => provider.inspectHealth(),
      embed: async (texts: string[], signal?: AbortSignal) => {
        const startedAt = Date.now();
        try {
          const result = await provider.embed(texts, signal);
          this.health.record('embedding', model, { ok: true, latencyMs: Date.now() - startedAt });
          return result;
        } catch (err) {
          this.health.record('embedding', model, { ok: false, latencyMs: Date.now() - startedAt, failureType: (err as Error).message.slice(0, 80) });
          throw err;
        }
      }
    };
  }

  chatProvider(): ChatProvider {
    return this.chat;
  }

  /** Vision-capable provider, or null when the configured model has no vision. */
  visionProvider(): ChatProvider | null {
    const cfg = this.config.chatModelFor('vision');
    if (!cfg.supportsVision) return null;
    return this.vision.configured ? this.vision : null;
  }

  summaryProvider(): ChatProvider {
    return this.summary;
  }

  /** Shared media-director model, falling back to the chat model in ConfigStore. */
  directorProvider(): ChatProvider {
    return this.director;
  }

  /** @deprecated Use directorProvider(). Kept for one migration window. */
  stickerProvider(): ChatProvider {
    return this.directorProvider();
  }

  embeddingProvider(): EmbeddingProvider {
    return this.embedding;
  }

  /** Dimension declared by config or observed from the last successful call. */
  embeddingDimensions(): number | null {
    const cfg = this.config.getModels().embedding;
    if (cfg.dimensions) return cfg.dimensions;
    if (this.embedding instanceof OpenAIEmbeddingProvider) return this.embedding.dimensions;
    return null;
  }

  imageProvider(): ImageProvider {
    return this.image;
  }

  ttsProvider(): TTSProvider {
    return this.tts;
  }

  rerankProvider(): RerankProvider {
    return this.rerank;
  }

  /** Number of vector candidates the reranker scores per recall. */
  rerankCandidateLimit(): number {
    return this.config.getModels().rerank.candidateLimit;
  }

  has(cap: CapabilityName): boolean {
    switch (cap) {
      case 'chat':
        return this.chat.configured;
      case 'vision':
        return this.visionProvider() !== null;
      case 'summary':
        return this.summary.configured;
      case 'director':
        return this.director.configured;
      case 'embedding':
        return this.embedding.configured;
      case 'image':
        return this.image.configured;
      case 'tts':
        return this.tts.configured;
      case 'rerank':
        return this.rerank.configured;
      default:
        return false;
    }
  }

  async statuses(): Promise<Record<CapabilityName, HealthStatus>> {
    const visionCfg = this.config.chatModelFor('vision');
    const [chat, vision, summary, director, embedding, image, tts, rerank] = await Promise.all([
      this.chat.inspectHealth(),
      this.vision.inspectHealth(),
      this.summary.inspectHealth(),
      this.director.inspectHealth(),
      this.embedding.inspectHealth(),
      this.image.inspectHealth(),
      this.tts.inspectHealth(),
      this.rerank.inspectHealth()
    ]);
    return {
      chat,
      vision: {
        ...vision,
        capability: 'vision',
        configured: vision.configured && visionCfg.supportsVision,
        ok: vision.ok && visionCfg.supportsVision,
        detail: visionCfg.supportsVision ? vision.detail : 'model does not declare vision support'
      },
      summary: { ...summary, capability: 'summary' },
      director: { ...director, capability: 'director', detail: director.configured ? 'media director model' : 'not configured' },
      embedding,
      image,
      tts,
      rerank
    };
  }
}
