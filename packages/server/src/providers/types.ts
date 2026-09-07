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

export interface ChatToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Provider returned malformed or non-object arguments; runtime must reject the call. */
  argumentsError?: string;
}

export interface ChatToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

/** Core-level model history; providers translate these roles to their wire format. */
export type ModelTurn =
  | ChatTurn
  | { role: 'assistant_tool_call'; calls: ChatToolCall[] }
  | { role: 'tool_result'; callId: string; name: string; content: string; isError?: boolean };

export interface ChatRequest {
  system?: string;
  messages: ModelTurn[];
  maxTokens?: number;
  temperature?: number;
  /** Abort signal wired to request timeouts. */
  signal?: AbortSignal;
  /** Ask provider to return strict JSON when supported. */
  jsonMode?: boolean;
  /** Enable the Responses API hosted web-search tool for this request. */
  webSearch?: {
    enabled: true;
    userLocation?: {
      countryCode?: string;
      region?: string;
      city?: string;
    };
  };
  tools?: ChatToolDefinition[];
  toolChoice?: 'auto' | 'none' | { name: string };
}

export interface ChatChunk {
  delta: string;
}

export interface ChatResult {
  text: string;
  toolCalls?: ChatToolCall[];
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  model: string;
  /**
   * `jsonMode` was asked for, but the endpoint cannot enforce it: the request
   * was served with a prompt constraint instead, so the text needs lenient
   * parsing rather than being trusted as strict JSON.
   */
  jsonModeDegraded?: boolean;
  /** Present only when native Responses web search was requested. */
  webSearch?: {
    used: boolean;
    callCount: number;
    citations: Array<{ title: string; url: string }>;
  };
}

export interface ChatProvider {
  readonly name: string;
  readonly configured: boolean;
  /** Optional because third-party test/dummy providers may not advertise it. */
  readonly supportsTools?: boolean;
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

/** One document's relevance verdict from a reranker. */
export interface RerankMatch {
  /** Position of the document in the request's `documents` array. */
  index: number;
  /** Relevance score; only the ordering is comparable across vendors. */
  score: number;
}

export interface RerankProvider {
  readonly name: string;
  readonly configured: boolean;
  rerank(query: string, documents: string[], signal?: AbortSignal): Promise<RerankMatch[]>;
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
  generate(prompt: string, opts?: { size?: string; signal?: AbortSignal; referenceImages?: Array<{ data: Buffer; mime: string }> }): Promise<GeneratedImage>;
  edit(prompt: string, image: Buffer, opts?: { mime?: string; signal?: AbortSignal }): Promise<GeneratedImage>;
  inspectHealth(): Promise<HealthStatus>;
}

/** Lifecycle of a vendor-side video job, normalised across protocols. */
export type VideoRemoteStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface VideoTaskRequest {
  prompt: string;
  /** First-frame reference for image-to-video. Absent means text-to-video. */
  image?: { data: Buffer; mime: string } | null;
  /** WxH, e.g. 1280x720. */
  size?: string;
  durationSec?: number;
  signal?: AbortSignal;
}

export interface VideoTaskSnapshot {
  remoteId: string;
  status: VideoRemoteStatus;
  /** 0..100 when the vendor reports it. */
  progress?: number | null;
  error?: string | null;
  /** Direct download location, when the gateway hands out a URL instead of a /content route. */
  videoUrl?: string | null;
}

export interface GeneratedVideo {
  data: Buffer;
  mime: string;
}

/**
 * Video generation is asynchronous everywhere: one call starts a job, further
 * calls observe it, a last one fetches the bytes. Keeping the three steps
 * separate lets the caller persist state between them instead of holding a
 * connection open for minutes.
 */
export interface VideoProvider {
  readonly name: string;
  readonly configured: boolean;
  createTask(req: VideoTaskRequest): Promise<VideoTaskSnapshot>;
  pollTask(remoteId: string, signal?: AbortSignal): Promise<VideoTaskSnapshot>;
  download(task: VideoTaskSnapshot, opts?: { signal?: AbortSignal; maxBytes?: number }): Promise<GeneratedVideo>;
  /** Best-effort; vendors without a cancel endpoint resolve without doing anything. */
  cancelTask(remoteId: string, signal?: AbortSignal): Promise<void>;
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

