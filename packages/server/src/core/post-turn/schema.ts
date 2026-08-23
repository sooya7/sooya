import { z } from 'zod';

const commitmentItem = z.object({
  kind: z.enum(['user_event', 'shared_plan', 'assistant_commitment', 'reminder_request', 'follow_up']),
  subject: z.enum(['user', 'assistant', 'shared']).default('user'),
  title: z.string().min(1).max(60),
  date_text: z.string().max(40).nullish().transform((v) => v ?? null),
  time_text: z.string().max(40).nullish().transform((v) => v ?? null),
  time_precision: z.enum(['exact', 'day', 'range', 'relative', 'unknown']).default('day'),
  follow_up: z.enum(['none', 'natural', 'explicit_reminder']).default('natural'),
  confidence: z.number().min(0).max(1).default(0.7),
  importance: z.number().min(0).max(1).default(0.5)
});

const resolutionItem = z.object({
  commitment_id: z.string().min(1).max(64),
  action: z.enum(['completed', 'cancelled', 'rescheduled', 'updated']),
  date_text: z.string().max(40).nullish().transform((v) => v ?? null),
  outcome: z.string().max(200).nullish().transform((v) => v ?? null),
  confidence: z.number().min(0).max(1).default(0.8)
});

const relationshipSignalItem = z.object({
  kind: z.enum(['open_topic', 'shared_experience', 'emotional_context', 'unresolved_issue', 'shared_interest', 'ongoing_joke', 'care_context']),
  title: z.string().min(1).max(60),
  summary: z.string().max(300).nullish().transform((v) => v ?? null),
  confidence: z.number().min(0).max(1).default(0.7)
});

const relationshipResolutionItem = z.object({
  thread_id: z.string().min(1).max(64),
  action: z.enum(['completed', 'cancelled', 'updated']),
  confidence: z.number().min(0).max(1).default(0.8)
});

export const analyzerOutputSchema = z.object({
  commitments: z.array(commitmentItem).max(6).default([]),
  commitment_resolutions: z.array(resolutionItem).max(6).default([]),
  relationship_signals: z.array(relationshipSignalItem).max(6).default([]),
  relationship_resolutions: z.array(relationshipResolutionItem).max(6).default([])
});

export type RawAnalyzerOutput = z.infer<typeof analyzerOutputSchema>;

export function parseAnalyzerOutput(text: string): RawAnalyzerOutput | null {
  const direct = tryParse(analyzerOutputSchema, text);
  if (direct) return direct;
  // Tolerate prose-wrapped JSON the way memory extraction does.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return tryParse(analyzerOutputSchema, text.slice(start, end + 1));
  }
  return null;
}

function tryParse<T extends z.ZodTypeAny>(schema: T, text: string): z.infer<T> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
