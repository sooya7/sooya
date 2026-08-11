export type PartType = 'text' | 'sticker' | 'image' | 'audio' | 'file' | 'system';
export type PartStatus = 'pending' | 'sent' | 'failed';
export type MessageStatus = 'pending' | 'sending' | 'sent' | 'failed';
export type Role = 'user' | 'assistant' | 'system';

export interface MediaRef {
  id: string;
  kind: 'image' | 'audio' | 'sticker' | 'file';
  mime: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  url: string;
  name?: string | null;
  transcript?: string | null;
  animated?: boolean;
  textStatus?: 'pending' | 'ready' | 'failed' | 'unsupported';
  textError?: string | null;
}

export interface MessagePart {
  id: string;
  type: PartType;
  text?: string | null;
  mediaId?: string | null;
  status: PartStatus;
  error?: string | null;
  duration?: number | null;
  transcript?: string | null;
  meta?: Record<string, unknown>;
  media?: MediaRef | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
  seq: number;
  status: MessageStatus;
  clientMsgId?: string | null;
  replyTo?: string | null;
  error?: string | null;
  content: MessagePart[];
  meta?: Record<string, unknown>;
  /** Client-only: message not yet acknowledged by the server. */
  pendingLocal?: boolean;
}

export interface PersonaInfo {
  name: string;
  avatar: string;
  userAvatar: string;
  tagline: string;
}

export interface StickerInfo {
  id: string;
  name: string;
  emotion: string;
  tags: string[];
  url: string;
  mediaId: string;
  description?: string | null;
  imageText?: string | null;
  userMeaning?: string | null;
  favorite?: boolean;
  assistantUseCount?: number;
  assistantLastUsedAt?: string | null;
  userUseCount?: number;
  analysisStatus?: 'pending' | 'processing' | 'ready' | 'failed';
  userLastUsedAt?: string | null;
  animated?: boolean;
}

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'unauthorized';

export interface ActivityState {
  thinking: boolean;
  label: string | null;
}

/** What she is doing right now, shown in the header. */
export interface LifeState {
  activity: string;
  kind: string;
  mood: string;
  startedAt: string;
  endsAt: string;
  recent: Array<{ activity: string; startedAt: string; endedAt: string }>;
}

export type WeatherCondition = 'clear' | 'cloudy' | 'rain' | 'snow' | 'storm' | 'fog' | 'wind' | 'unknown';

export interface WorldPresence {
  city: { id: string; name: string; region?: string | null; country?: string | null } | null;
  location: { id: string; name: string; kind: string } | null;
  travel: {
    fromLocationId: string;
    fromName: string | null;
    toLocationId: string;
    toName: string | null;
    mode: string;
    expectedArriveAt: string;
  } | null;
  weather: {
    condition: WeatherCondition;
    temperatureC: number | null;
    feelsLikeC: number | null;
    observedAt: string;
    stale: boolean;
    provider: string;
  } | null;
  updatedAt: string;
}
