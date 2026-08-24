import { DbHandle } from '../db/handle.js';
import { MediaRepo } from '../db/repos/media.repo.js';
import { MessageRepo } from '../db/repos/message.repo.js';
import { MemoryRepo } from '../db/repos/memory.repo.js';
import { CommitmentRepo } from '../db/repos/commitment.repo.js';
import { RelationshipThreadRepo } from '../db/repos/relationship-thread.repo.js';
import { EpisodeRepo } from '../db/repos/episode.repo.js';
import { InteractionOutcomeRepo } from '../db/repos/interaction-outcome.repo.js';
import { AuthTokenRepo } from '../db/repos/auth-token.repo.js';
import { OmbreCommitRepo } from '../db/repos/ombre.repo.js';
import { StickerRepo } from '../db/repos/sticker.repo.js';
import { ErrorLogRepo, EventRepo, JobRepo, SettingsRepo, SummaryRepo } from '../db/repos/misc.repo.js';
import { MediaTextRepo } from '../db/repos/media-text.repo.js';
import { AuditRepo, StorageSampleRepo } from '../db/repos/feature.repo.js';
import { LifeRepo } from '../db/repos/life.repo.js';
import { ProactiveAttemptRepo } from '../db/repos/proactive.repo.js';
import { MomentRepo } from '../db/repos/moment.repo.js';
import { VoiceGenerationRepo } from '../db/repos/voice.repo.js';
import { LifeV2Repo } from '../db/repos/life-v2.repo.js';
import { LifeLocationRepo } from '../db/repos/location.repo.js';
import { WeatherRepo } from '../db/repos/weather.repo.js';
import { MetricsRepo } from '../db/repos/metrics.repo.js';
import { ThoughtRepo } from '../db/repos/thought.repo.js';
import { ReplyBatchRepo } from '../db/repos/reply-batch.repo.js';
import { ChannelEventRepo } from '../db/repos/channel-event.repo.js';
import { ChannelIdentityRepo } from '../db/repos/channel-identity.repo.js';
import { ChannelDeliveryRepo } from '../db/repos/channel-delivery.repo.js';
import { FlowTraceRepo } from '../db/repos/flow-trace.repo.js';

export function createRepositories(db: DbHandle) {
  const mediaText = new MediaTextRepo(db);
  return {
    messages: new MessageRepo(db, mediaText),
    media: new MediaRepo(db),
    mediaText,
    memories: new MemoryRepo(db),
    commitments: new CommitmentRepo(db),
    relationshipThreads: new RelationshipThreadRepo(db),
    episodes: new EpisodeRepo(db),
    interactionOutcomes: new InteractionOutcomeRepo(db),
    authTokens: new AuthTokenRepo(db),
    ombreCommits: new OmbreCommitRepo(db),
    stickers: new StickerRepo(db),
    summaries: new SummaryRepo(db),
    jobs: new JobRepo(db),
    settings: new SettingsRepo(db),
    events: new EventRepo(db),
    errors: new ErrorLogRepo(db),
    life: new LifeRepo(db),
    proactive: new ProactiveAttemptRepo(db),
    moments: new MomentRepo(db),
    voice: new VoiceGenerationRepo(db),
    lifeV2: new LifeV2Repo(db),
    locations: new LifeLocationRepo(db),
    weather: new WeatherRepo(db),
    metrics: new MetricsRepo(db),
    thoughts: new ThoughtRepo(db),
    audit: new AuditRepo(db),
    storageSamples: new StorageSampleRepo(db),
    replyBatches: new ReplyBatchRepo(db),
    channelEvents: new ChannelEventRepo(db),
    channelIdentities: new ChannelIdentityRepo(db),
    channelDeliveries: new ChannelDeliveryRepo(db),
    flowTraces: new FlowTraceRepo(db)
  };
}

export type AppRepositories = ReturnType<typeof createRepositories>;
