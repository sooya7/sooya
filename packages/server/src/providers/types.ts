export interface HealthStatus {
  capability: string;
  configured: boolean;
  ok: boolean;
  provider: string;
  model?: string;
  detail?: string;
  checkedAt: string;
}

export interface ChatTextPart {
  type: 'text';
  text: string;
}
export interface ChatImagePart {
  type: 'image';
  /** base64 data (no data: prefix) */
  data: string;
  mime: string;
}
export type ChatContentPart = ChatTextPart | ChatImagePart;

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: ChatContentPart[];
}

export interface ChatRequest {
  system?: string;
  messages: ChatTurn[];
  maxTokens?: number;
  temperature?: number;
  /** Abort signal wired to request timeouts. */
  signal?: AbortSignal;
  /** Ask provider to return strict JSON when supported. */
  jsonMode?: boolean;
}

export interface ChatChunk {
  delta: string;
}

export interface ChatResult {
  text: string;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  model: string;
  /**
   * `jsonMode` was asked for, but the endpoint cannot enforce it: the request
   * was served with a prompt constraint instead, so the text needs lenient
   * parsing rather than being trusted as strict JSON.
   */
  jsonModeDegraded?: boolean;
}

export interface ChatProvider {
  readonly name: string;
  readonly configured: boolean;
  complete(req: ChatRequest): Promise<ChatResult>;
  stream(req: ChatRequest, onChunk: (c: ChatChunk) => void): Promise<ChatResult>;
  inspectHealth(): Promise<HealthStatus>;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly configured: boolean;
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult>;
  inspectHealth(): Promise<HealthStatus>;
}

export interface GeneratedImage {
  data: Buffer;
  mime: string;
  width?: number;
  height?: number;
}

export interface ImageProvider {
  readonly name: string;
  readonly configured: boolean;
  generate(prompt: string, opts?: { size?: string; signal?: AbortSignal }): Promise<GeneratedImage>;
  edit(prompt: string, image: Buffer, opts?: { mime?: string; signal?: AbortSignal }): Promise<GeneratedImage>;
  inspectHealth(): Promise<HealthStatus>;
}

export interface SynthesizedAudio {
  data: Buffer;
  mime: string;
  format: string;
  durationSec?: number;
}

export interface TTSOptions {
  voice?: string;
  signal?: AbortSignal;
  /** Natural-language delivery direction for instruction-capable speech models. */
  instructions?: string;
  /** Per-utterance speed multiplier. */
  speed?: number;
  /** Optional diagnostic label saved by callers, not required by providers. */
  emotion?: string;
  /**
   * The vendor's own emotion word, when the caller knows it. Kept separate from
   * `emotion` because that one is our internal label (`gentle` has no vendor
   * equivalent) and is also what gets written next to the message.
   */
  apiEmotion?: string;
}

export interface TTSProvider {
  readonly name: string;
  readonly configured: boolean;
  synthesize(text: string, opts?: TTSOptions): Promise<SynthesizedAudio>;
  inspectHealth(): Promise<HealthStatus>;
}

export class ProviderNotConfiguredError extends Error {
  override name = 'ProviderNotConfiguredError';
  constructor(capability: string) {
    super(`capability "${capability}" is not configured`);
  }
}

export class ProviderRequestError extends Error {
  override name = 'ProviderRequestError';
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

export class ImageEditUnsupportedError extends Error {
  override name = 'ImageEditUnsupportedError';
}

export type ImageReferenceErrorCode =
  | 'too_many_reference_images'
  | 'reference_image_too_large'
  | 'reference_image_type_unsupported'
  | 'reference_upload_failed'
  | 'reference_upload_invalid_response'
  | 'reference_generation_failed';

export class ImageReferenceError extends Error {
  override name = 'ImageReferenceError';

  constructor(
    readonly code: ImageReferenceErrorCode,
    readonly publicMessage: string,
    message: string
  ) {
    super(message);
  }
}
