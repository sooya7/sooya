import { z } from 'zod';

export const CONVERSATION_ID = 'main';

export const PartTypeSchema = z.enum(['text', 'sticker', 'image', 'audio', 'file', 'system']);
export type PartType = z.infer<typeof PartTypeSchema>;
export const PartStatusSchema = z.enum(['pending', 'sent', 'failed']);
export type PartStatus = z.infer<typeof PartStatusSchema>;
export const MessageStatusSchema = z.enum(['pending', 'sending', 'sent', 'failed']);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;
export const RoleSchema = z.enum(['user', 'assistant', 'system']);
export type Role = z.infer<typeof RoleSchema>;

export interface MessagePart { id: string; type: PartType; text?: string | null; mediaId?: string | null; status: PartStatus; error?: string | null; duration?: number | null; transcript?: string | null; meta?: Record<string, unknown>; media?: MediaRef | null; }
export interface MediaRef { id: string; kind: 'image' | 'audio' | 'sticker' | 'file'; mime: string; bytes: number; width?: number | null; height?: number | null; duration?: number | null; url: string; name?: string | null; transcript?: string | null; textStatus?: 'pending' | 'ready' | 'failed' | 'unsupported'; textError?: string | null; }
export interface ChatMessage { id: string; conversationId: string; role: Role; createdAt: string; updatedAt: string; seq: number; status: MessageStatus; clientMsgId?: string | null; replyTo?: string | null; error?: string | null; content: MessagePart[]; meta?: Record<string, unknown>; }

export const InputPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(20000) }),
  z.object({ type: z.literal('image'), mediaId: z.string().min(1) }),
  z.object({ type: z.literal('sticker'), mediaId: z.string().min(1) }),
  z.object({ type: z.literal('file'), mediaId: z.string().min(1) })
]);
export type InputPart = z.infer<typeof InputPartSchema>;

export const SendMessageSchema = z.object({
  clientMsgId: z.string().min(1).max(128),
  content: z.array(InputPartSchema).min(1).max(20),
  replyTo: z.string().min(1).max(80).optional(),
  directives: z.object({ wantSticker: z.boolean().optional(), wantImage: z.boolean().optional(), wantVoice: z.boolean().optional(), voiceOnly: z.boolean().optional(), noSticker: z.boolean().optional(), anotherSticker: z.boolean().optional() }).optional()
});
export type SendMessageInput = z.infer<typeof SendMessageSchema>;

export type StreamEventType = 'message.received' | 'reply.queued' | 'reply.thinking' | 'reply.text.delta' | 'reply.text.done' | 'reply.sticker.selecting' | 'reply.image.generating' | 'reply.audio.generating' | 'reply.content.done' | 'reply.media.saved' | 'reply.completed' | 'reply.failed' | 'message.updated' | 'media.updated' | 'memory.updated' | 'persona.updated' | 'life.updated' | 'push.updated' | 'storage.updated' | 'system.notice' | 'ping';
export interface StreamEvent { id: string; seq: number; type: StreamEventType; createdAt: string; payload: Record<string, unknown>; }
export interface MemoryRecord { id: string; kind: 'profile' | 'preference' | 'relationship' | 'project' | 'event' | 'summary'; content: string; importance: number; confidence: number; createdAt: string; updatedAt: string; expiresAt?: string | null; hits: number; sources: string[]; hasEmbedding: boolean; supersedesId: string | null; supersededById: string | null; archivedAt: string | null; }
