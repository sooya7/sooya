import type { ConfigStore } from '../config/store.js';
import { createChatProvider, type ProviderDeps } from '../providers/chat/openai.js';
import { createEmbeddingProvider, OpenAIEmbeddingProvider } from '../providers/embedding.js';
import { createImageProvider } from '../providers/image.js';
import { createRerankProvider } from '../providers/rerank.js';
import { createTTSProvider } from '../providers/tts.js';
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

  constructor(
    private readonly config: ConfigStore,
    private readonly deps: ProviderDeps
  ) {
    this.rebuild();
  }

  rebuild(): void {
    const models = this.config.getModels();
    this.chat = createChatProvider(this.config.chatModelFor('chat'), this.deps);
    this.vision = createChatProvider(this.config.chatModelFor('vision'), this.deps);
    this.summary = createChatProvider(this.config.chatModelFor('summary'), this.deps);
    this.director = createChatProvider(this.config.chatModelFor('director'), this.deps);
    this.embedding = createEmbeddingProvider(models.embedding, this.deps);
    this.image = createImageProvider(models.image, this.deps);
    this.tts = createTTSProvider(models.tts, this.deps);
    this.rerank = createRerankProvider(models.rerank, this.deps);
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
