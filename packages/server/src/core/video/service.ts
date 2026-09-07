import type { ConfigStore } from '../../config/store.js';
import type { VideoModelConfig } from '../../config/schema.js';
import type { MediaRepo, MediaRow } from '../../db/repos/media.repo.js';
import { toMediaRef } from '../../db/repos/media.repo.js';
import type { ErrorLogRepo, JobRepo } from '../../db/repos/misc.repo.js';
import type { AuditRepo } from '../../db/repos/feature.repo.js';
import {
  VIDEO_TASK_TERMINAL,
  videoTaskParams,
  type VideoTaskRepo,
  type VideoTaskRow,
  type VideoTaskStatus
} from '../../db/repos/video-task.repo.js';
import { fileTypeFromBuffer } from 'file-type';
import { ALLOWED_VIDEO_MIME, MediaStore, MediaValidationError } from '../../media/store.js';
import { ProviderNotConfiguredError, ProviderRequestError, type VideoProvider, type VideoTaskSnapshot } from '../../providers/types.js';
import { HttpSizeError, SsrfError } from '../../util/http.js';
import type { MediaRef } from '../types.js';
import type { CapabilityRegistry } from '../capabilities.js';
import type { JobWorker } from '../jobs.js';
import { nowIso } from '../../util/ids.js';

export const VIDEO_JOB_TYPE = 'video.generate';

/** Consecutive transient failures (network, 5xx) tolerated before a task is failed. */
const MAX_STEP_FAILURES = 5;
const MAX_PROMPT_CHARS = 2000;

/** Who asked for the clip, and what should happen when it is ready. */
export interface VideoTaskOrigin {
  kind: 'admin' | 'reply' | 'proactive';
  /** The assistant message whose text promised the clip. */
  messageId?: string;
  /** Publish the finished clip as a follow-up chat message and deliver it. */
  deliver?: boolean;
  /** The model's original 画面意图 before director expansion. */
  intent?: string;
}

export interface VideoGenerationInput {
  prompt: string;
  /** First frame for image-to-video; already persisted as a media row. */
  sourceMediaId?: string | null;
  /** First frame as raw bytes (a persona reference); persisted here as a media row. */
  sourceImage?: { data: Buffer; mime: string; name?: string } | null;
  durationSec?: number;
  size?: string;
  origin?: VideoTaskOrigin;
}

/** What the chat side does once a task settles; see core/video/follow-up.ts. */
export interface VideoFollowUp {
  onSucceeded(task: PublicVideoTask, media: MediaRow): void | Promise<void>;
  onFailed(task: PublicVideoTask, reason: string): void | Promise<void>;
}

export interface PublicVideoTask {
  id: string;
  mode: 'text' | 'image';
  prompt: string;
  status: VideoTaskStatus;
  progress: number | null;
  provider: string;
  model: string;
  params: Record<string, unknown>;
  origin: VideoTaskOrigin | null;
  remoteId: string | null;
  sourceMedia: MediaRef | null;
  media: MediaRef | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export class VideoRequestError extends Error {
  override name = 'VideoRequestError';
  constructor(
    readonly code: 'not_configured' | 'invalid_prompt' | 'too_many_active_tasks' | 'source_not_found' | 'source_not_image' | 'invalid_params',
    readonly publicMessage: string,
    readonly httpStatus: number
  ) {
    super(publicMessage);
  }
}

export interface VideoGenerationDeps {
  tasks: VideoTaskRepo;
  media: MediaRepo;
  mediaStore: MediaStore;
  jobs: JobRepo;
  errors: ErrorLogRepo;
  audit?: AuditRepo;
  capabilities: Pick<CapabilityRegistry, 'videoProvider'>;
  config: Pick<ConfigStore, 'getModels'>;
  /** Storage hard-limit guard; absent in unit tests. */
  assertWritable?: (bytes: number) => Promise<void>;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  now?: () => Date;
}

/**
 * Text-to-video and image-to-video through the admin API.
 *
 * A vendor video job takes minutes, so nothing here holds an HTTP request open.
 * `create()` writes a task row and enqueues one durable `video.generate` job;
 * each job run performs exactly one step (start the vendor job, or poll it
 * once, or download the finished file) and, when more work remains, enqueues
 * the next step with a delay. The task row is the single source of truth the
 * API reads back, and it survives restarts because the jobs table does.
 */
export class VideoGenerationService {
  private followUp: VideoFollowUp | null = null;

  constructor(private readonly deps: VideoGenerationDeps) {}

  /** Hooks that turn a finished task into a chat message; wired once the coordinator exists. */
  attachFollowUp(followUp: VideoFollowUp): void {
    this.followUp = followUp;
  }

  registerJobs(worker: JobWorker): void {
    worker.register(
      VIDEO_JOB_TYPE,
      async (payload) => {
        const taskId = String(payload.taskId ?? '');
        if (taskId) await this.step(taskId);
      },
      // One step is one HTTP call, except the download, which can take a while.
      { lane: 'background', timeoutMs: 6 * 60_000, maxAttempts: 1, retryable: false, timeoutMode: 'observe' }
    );
  }

  private cfg(): VideoModelConfig {
    return this.deps.config.getModels().video;
  }

  private provider(): VideoProvider {
    return this.deps.capabilities.videoProvider();
  }

  configured(): boolean {
    return this.provider().configured;
  }

  /** Tasks created in the last window, for the persona's rolling daily cap. */
  countCreatedSince(iso: string): number {
    return this.deps.tasks.countCreatedSince(iso);
  }

  /** Validates, persists and schedules a task. Throws VideoRequestError on caller mistakes. */
  async create(input: VideoGenerationInput): Promise<PublicVideoTask> {
    const provider = this.provider();
    if (!provider.configured) throw new VideoRequestError('not_configured', '视频生成模型还没配置好（接口协议、地址、模型名、密钥缺一不可）', 503);
    const prompt = input.prompt.trim();
    if (!prompt) throw new VideoRequestError('invalid_prompt', '请填写视频描述', 400);
    if ([...prompt].length > MAX_PROMPT_CHARS) throw new VideoRequestError('invalid_prompt', `视频描述最多 ${MAX_PROMPT_CHARS} 个字符`, 400);
    const cfg = this.cfg();
    if (this.deps.tasks.countActive() >= cfg.maxActiveTasks) {
      throw new VideoRequestError('too_many_active_tasks', `已有 ${cfg.maxActiveTasks} 个视频任务在排队或生成中，等它们结束再提交`, 429);
    }
    let sourceMediaId: string | null = null;
    if (input.sourceMediaId) {
      const row = this.deps.media.get(input.sourceMediaId);
      if (!row || row.deleted_at) throw new VideoRequestError('source_not_found', '参考图不存在', 404);
      if (row.kind !== 'image' && row.kind !== 'sticker') throw new VideoRequestError('source_not_image', '参考图必须是图片', 400);
      if (!this.deps.mediaStore.exists(row)) throw new VideoRequestError('source_not_found', '参考图文件已不在磁盘上', 404);
      sourceMediaId = row.id;
    } else if (input.sourceImage) {
      // A persona reference lives on disk, not in the media table; persist a
      // copy so the task row can point at it like any other first frame.
      const row = await this.deps.mediaStore.save({
        kind: 'image',
        origin: 'builtin',
        data: input.sourceImage.data,
        declaredMime: input.sourceImage.mime,
        filename: input.sourceImage.name,
        meta: { videoFirstFrame: true }
      });
      sourceMediaId = row.id;
    }
    const params: Record<string, unknown> = {};
    if (input.durationSec !== undefined) params.durationSec = input.durationSec;
    if (input.size) params.size = input.size;
    if (input.origin) params.origin = input.origin;

    const row = this.deps.tasks.create({
      mode: sourceMediaId ? 'image' : 'text',
      prompt,
      provider: provider.name,
      model: cfg.model,
      params,
      sourceMediaId
    });
    this.schedule(row.id, 0);
    this.deps.audit?.add('video', 'task.created', row.id, { mode: row.mode, provider: row.provider, model: row.model });
    this.deps.onLog?.('info', 'video task created', { taskId: row.id, mode: row.mode, provider: row.provider });
    return this.toPublic(row);
  }

  get(id: string): PublicVideoTask | null {
    const row = this.deps.tasks.get(id);
    return row ? this.toPublic(row) : null;
  }

  list(query: { limit?: number; offset?: number; status?: VideoTaskStatus } = {}): { tasks: PublicVideoTask[]; total: number; active: number } {
    return {
      tasks: this.deps.tasks.list(query).map((row) => this.toPublic(row)),
      total: this.deps.tasks.count(query.status),
      active: this.deps.tasks.countActive()
    };
  }

  /** Marks the task cancelled locally and tells the vendor, best-effort. */
  async cancel(id: string): Promise<PublicVideoTask | null> {
    const row = this.deps.tasks.get(id);
    if (!row) return null;
    if (VIDEO_TASK_TERMINAL.has(row.status)) return this.toPublic(row);
    const updated = this.deps.tasks.update(id, { status: 'cancelled', completedAt: nowIso() })!;
    this.deps.audit?.add('video', 'task.cancelled', id);
    if (row.remote_id) {
      const provider = this.provider();
      if (provider.configured) await provider.cancelTask(row.remote_id).catch(() => undefined);
    }
    return this.toPublic(updated);
  }

  /** Removes the record. The generated file stays in the media library. */
  delete(id: string): boolean {
    const row = this.deps.tasks.get(id);
    if (!row) return false;
    if (!VIDEO_TASK_TERMINAL.has(row.status)) return false;
    return this.deps.tasks.delete(id);
  }

  /**
   * Advances one task by one step. Never throws for provider or network
   * trouble: the outcome lands on the task row, where the API can read it.
   */
  async step(taskId: string): Promise<VideoTaskRow | undefined> {
    const task = this.deps.tasks.get(taskId);
    if (!task || VIDEO_TASK_TERMINAL.has(task.status)) return task;
    const provider = this.provider();
    const cfg = this.cfg();
    if (!provider.configured) return await this.fail(task, '视频生成模型未配置，任务无法继续');
    const startedAtMs = Date.parse(task.created_at);
    if (this.now() - startedAtMs > cfg.maxWaitMs) {
      if (task.remote_id) await provider.cancelTask(task.remote_id).catch(() => undefined);
      return await this.fail(task, `等待了 ${Math.round(cfg.maxWaitMs / 60_000)} 分钟仍未生成完成，已放弃`);
    }
    try {
      let snapshot: VideoTaskSnapshot;
      if (!task.remote_id) {
        snapshot = await provider.createTask(await this.buildRequest(task));
        this.deps.tasks.update(task.id, {
          remoteId: snapshot.remoteId,
          status: 'running',
          startedAt: nowIso(),
          progress: snapshot.progress ?? null,
          attempts: 0
        });
      } else {
        snapshot = await provider.pollTask(task.remote_id);
      }
      return await this.apply(this.deps.tasks.get(task.id)!, snapshot, provider);
    } catch (err) {
      return await this.handleStepError(this.deps.tasks.get(task.id) ?? task, err as Error);
    }
  }

  private async apply(task: VideoTaskRow, snapshot: VideoTaskSnapshot, provider: VideoProvider): Promise<VideoTaskRow | undefined> {
    switch (snapshot.status) {
      case 'queued':
      case 'running': {
        const updated = this.deps.tasks.update(task.id, {
          status: 'running',
          progress: snapshot.progress ?? task.progress ?? null,
          attempts: 0,
          error: null
        });
        this.schedule(task.id, this.cfg().pollIntervalMs);
        return updated;
      }
      case 'failed':
        return await this.fail(task, snapshot.error ?? '上游视频服务报告生成失败');
      case 'cancelled': {
        const updated = this.deps.tasks.update(task.id, { status: 'cancelled', completedAt: nowIso(), error: snapshot.error ?? null });
        this.deps.audit?.add('video', 'task.cancelled_upstream', task.id);
        return updated;
      }
      case 'succeeded': {
        const cfg = this.cfg();
        const video = await provider.download(snapshot, { maxBytes: cfg.maxDownloadBytes });
        // A vendor error page or an expired signed URL comes back as HTML/JSON with
        // a 200; the file store would happily keep it as text. Insist on a real
        // container before anything is persisted or reported as a success.
        const sniffed = await fileTypeFromBuffer(video.data);
        if (!sniffed || !ALLOWED_VIDEO_MIME.has(sniffed.mime)) {
          throw new MediaValidationError(`downloaded content is not a video (${sniffed?.mime ?? 'unrecognised bytes'})`, 'NOT_VIDEO');
        }
        await this.deps.assertWritable?.(video.data.byteLength);
        const params = videoTaskParams(task);
        const media = await this.deps.mediaStore.save({
          kind: 'file',
          origin: 'generated',
          data: video.data,
          declaredMime: sniffed.mime,
          filename: `video-${task.id}.${extensionFor(sniffed.mime)}`,
          maxBytes: cfg.maxDownloadBytes,
          meta: {
            video: true,
            videoTaskId: task.id,
            mode: task.mode,
            prompt: task.prompt,
            provider: task.provider,
            model: task.model,
            params,
            sourceMediaId: task.source_media_id
          }
        });
        const updated = this.deps.tasks.update(task.id, {
          status: 'succeeded',
          progress: 100,
          mediaId: media.id,
          error: null,
          completedAt: nowIso()
        });
        this.deps.audit?.add('video', 'task.succeeded', task.id, { mediaId: media.id, bytes: media.bytes, mime: media.mime });
        this.deps.onLog?.('info', 'video task succeeded', { taskId: task.id, mediaId: media.id, bytes: media.bytes });
        if (updated) await this.notify((hooks) => hooks.onSucceeded(this.toPublic(updated), media), updated.id);
        return updated;
      }
    }
  }

  private async handleStepError(task: VideoTaskRow, err: Error): Promise<VideoTaskRow | undefined> {
    const detail = err.message.slice(0, 300);
    if (isPermanent(err)) {
      this.deps.errors.add('video.generate', `${task.id}: ${detail}`, { taskId: task.id, permanent: true });
      return await this.fail(task, publicErrorFor(err));
    }
    const attempts = task.attempts + 1;
    this.deps.errors.add('video.generate', `${task.id}: ${detail}`, { taskId: task.id, attempt: attempts });
    if (attempts >= MAX_STEP_FAILURES) return await this.fail(task, `连续 ${attempts} 次没能联系上视频服务：${detail}`);
    const updated = this.deps.tasks.update(task.id, { attempts, error: detail });
    // Back off a little further each time, capped so a poll never sleeps past the deadline.
    const delay = Math.min(this.cfg().pollIntervalMs * Math.pow(2, attempts), 120_000);
    this.schedule(task.id, delay);
    return updated;
  }

  private async fail(task: VideoTaskRow, message: string): Promise<VideoTaskRow | undefined> {
    const updated = this.deps.tasks.update(task.id, { status: 'failed', error: message.slice(0, 300), completedAt: nowIso() });
    this.deps.audit?.add('video', 'task.failed', task.id, { error: message.slice(0, 300) });
    this.deps.onLog?.('warn', 'video task failed', { taskId: task.id, error: message.slice(0, 300) });
    if (updated) await this.notify((hooks) => hooks.onFailed(this.toPublic(updated), message.slice(0, 300)), updated.id);
    return updated;
  }

  /** A follow-up that throws must not turn a settled task back into an error. */
  private async notify(run: (hooks: VideoFollowUp) => void | Promise<void>, taskId: string): Promise<void> {
    if (!this.followUp) return;
    try {
      await run(this.followUp);
    } catch (err) {
      this.deps.errors.add('video.follow_up', (err as Error).message.slice(0, 300), { taskId });
    }
  }

  private async buildRequest(task: VideoTaskRow) {
    const params = videoTaskParams(task);
    const cfg = this.cfg();
    let image: { data: Buffer; mime: string } | null = null;
    if (task.source_media_id) {
      const read = await this.deps.mediaStore.read(task.source_media_id);
      if (!read) throw new VideoSourceMissingError('参考图已被删除，无法开始图生视频');
      image = { data: read.data, mime: read.row.mime };
    }
    return {
      prompt: task.prompt,
      image,
      durationSec: typeof params.durationSec === 'number' ? params.durationSec : cfg.durationSec,
      size: typeof params.size === 'string' && params.size ? params.size : cfg.size
    };
  }

  private schedule(taskId: string, delayMs: number): void {
    const runAfter = delayMs > 0 ? new Date(this.now() + delayMs).toISOString() : undefined;
    this.deps.jobs.enqueue(VIDEO_JOB_TYPE, { taskId }, { maxAttempts: 1, runAfter });
  }

  private now(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  toPublic(row: VideoTaskRow): PublicVideoTask {
    const media = row.media_id ? this.deps.media.get(row.media_id) : undefined;
    const source = row.source_media_id ? this.deps.media.get(row.source_media_id) : undefined;
    // `origin` is bookkeeping for the chat follow-up; callers see it as its own
    // field, and `params` stays the per-request generation overrides only.
    const { origin: rawOrigin, ...params } = videoTaskParams(row);
    const origin = rawOrigin && typeof rawOrigin === 'object' ? rawOrigin as VideoTaskOrigin : null;
    return {
      id: row.id,
      mode: row.mode,
      prompt: row.prompt,
      status: row.status,
      progress: row.progress,
      provider: row.provider,
      model: row.model,
      params,
      origin,
      remoteId: row.remote_id,
      sourceMedia: source ? toMediaRef(source) : null,
      media: media ? toMediaRef(media) : null,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at
    };
  }
}

class VideoSourceMissingError extends Error {
  override name = 'VideoSourceMissingError';
}

/** Errors that a retry cannot fix: bad config, rejected request, unsafe URL, oversize file. */
function isPermanent(err: Error): boolean {
  if (err instanceof ProviderNotConfiguredError) return true;
  if (err instanceof SsrfError) return true;
  if (err instanceof HttpSizeError) return true;
  if (err instanceof MediaValidationError) return true;
  if (err instanceof VideoSourceMissingError) return true;
  if ((err as { code?: string }).code === 'STORAGE_HARD_LIMIT') return true;
  if (err instanceof ProviderRequestError) {
    const status = err.status;
    // 429 and 5xx are transient; every other 4xx is the request's fault.
    if (status !== undefined && status >= 400 && status < 500 && status !== 429 && status !== 408) return true;
    // A 2xx with an unusable body (no id, invalid JSON) will not improve on retry either.
    if (status === undefined && /invalid JSON|did not include|no video_url|was empty/i.test(err.message)) return true;
  }
  return false;
}

function publicErrorFor(err: Error): string {
  if (err instanceof ProviderNotConfiguredError) return '视频生成模型未配置';
  if (err instanceof SsrfError) return `接口地址不允许访问：${err.message.slice(0, 200)}`;
  if (err instanceof HttpSizeError) return '生成的视频超过了允许的大小上限';
  if (err instanceof MediaValidationError) return `生成结果无法保存：${err.message.slice(0, 200)}`;
  if ((err as { code?: string }).code === 'STORAGE_HARD_LIMIT') return '媒体存储已达到硬上限，先清理空间再生成';
  if (err instanceof ProviderRequestError && err.status === 401) return '鉴权失败（HTTP 401）：密钥不对，或这把密钥没有该模型的权限';
  if (err instanceof ProviderRequestError && err.status === 403) return '鉴权失败（HTTP 403）：密钥没有该模型的权限';
  return err.message.slice(0, 300);
}

function extensionFor(mime: string): string {
  if (mime === 'video/quicktime') return 'mov';
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/x-matroska') return 'mkv';
  return 'mp4';
}
