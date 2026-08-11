/**
 * Durable jobs share one worker, so the queue needs an explicit policy rather
 * than relying on insertion order. Interactive and user-visible follow-up
 * work must get a turn before catalogue maintenance.
 */
export const JOB_PRIORITY = {
  interactive: 100,
  reply: 100,
  push: 95,
  media: 90,
  life: 75,
  weather: 70,
  default: 50,
  stickerAnalyze: 20,
  stickerEmbed: 15,
  maintenance: 10,
  backup: 5
} as const;

const JOB_PRIORITIES: Record<string, number> = {
  reply: JOB_PRIORITY.reply,
  'push.reply': JOB_PRIORITY.push,
  'media.extract_text': JOB_PRIORITY.media,
  'life.conversation': JOB_PRIORITY.life,
  'life.tick': JOB_PRIORITY.life,
  'weather.refresh': JOB_PRIORITY.weather,
  'sticker.analyze': JOB_PRIORITY.stickerAnalyze,
  'sticker.analyze.backfill': JOB_PRIORITY.stickerAnalyze,
  'sticker.embed': JOB_PRIORITY.stickerEmbed,
  'sticker.user-meaning.learn': JOB_PRIORITY.life,
  'sticker.embed.backfill': JOB_PRIORITY.maintenance,
  'memory.embed.backfill': JOB_PRIORITY.maintenance,
  maintenance: JOB_PRIORITY.maintenance,
  'backup.create': JOB_PRIORITY.backup
};

export function priorityForJob(type: string): number {
  return JOB_PRIORITIES[type] ?? JOB_PRIORITY.default;
}
