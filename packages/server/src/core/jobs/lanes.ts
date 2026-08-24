import type { JobLane } from './types.js';

export const LANE_CONFIG: Record<JobLane, { concurrency: number; description: string }> = {
  critical: { concurrency: 2, description: 'user-visible delivery and recovery' },
  background: { concurrency: 1, description: 'conversational post-turn work' },
  autonomous: { concurrency: 1, description: 'life and proactive behavior' },
  maintenance: { concurrency: 1, description: 'cleanup, backfill and backups' }
};

export const DEFAULT_JOB_CONTRACT = {
  lane: 'background' as JobLane,
  timeoutMs: 60_000,
  maxAttempts: 3,
  retryable: true,
  cancellable: false,
  timeoutMode: 'observe' as const
};

const LANE_OVERRIDES: Record<string, JobLane> = {
  'qq.deliver': 'critical',
  'media.extract_text': 'background',
  'memory.extract': 'background',
  'ombre.memory_commit': 'background',
  'life.conversation': 'background',
  'future.analyze': 'background',
  'summary.build': 'background',
  'sticker.auto-collect': 'background',
  'sticker.user-meaning.learn': 'background',
  'life.tick': 'autonomous',
  'weather.refresh': 'autonomous',
  'ombre.dream': 'autonomous',
  'ombre.refresh_tools': 'autonomous',
  'sticker.analyze': 'maintenance',
  'sticker.analyze.backfill': 'maintenance',
  'sticker.embed': 'maintenance',
  'sticker.embed.backfill': 'maintenance',
  'memory.embed.backfill': 'maintenance',
  maintenance: 'maintenance',
  'backup.create': 'maintenance'
};

export function laneForJob(type: string): JobLane {
  return LANE_OVERRIDES[type] ?? DEFAULT_JOB_CONTRACT.lane;
}

export function timeoutForLane(lane: JobLane): number {
  switch (lane) {
    case 'critical': return 15_000;
    case 'background': return 90_000;
    case 'autonomous': return 120_000;
    case 'maintenance': return 5 * 60_000;
  }
}
