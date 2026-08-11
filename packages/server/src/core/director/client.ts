import type { MetricsService } from '../metrics.js';
import type { ChatProvider } from '../../providers/types.js';
import { HttpTimeoutError } from '../../util/http.js';
import { extractJsonObject } from '../../util/json-extract.js';
import type { DirectorEvent, DirectorRunRequest, DirectorRunResult, DirectorTask } from './types.js';

export interface DirectorClientOptions {
  metrics?: MetricsService;
  onEvent?: (event: DirectorEvent) => void;
}

/**
 * The one gateway for small, structured media decisions.
 *
 * It deliberately logs only task names, sizes, timing and failure classes.
 * The input is untrusted data, so neither prompts nor user text are emitted.
 */
export class DirectorClient {
  constructor(
    private readonly provider: () => ChatProvider,
    private readonly opts: DirectorClientOptions = {}
  ) {}

  async run<T>(request: DirectorRunRequest<T>): Promise<DirectorRunResult<T> | null> {
    const startedAt = Date.now();
    const emit = (event: DirectorEvent['event'], extra: Omit<DirectorEvent, 'event' | 'task'> = {}): void => {
      this.opts.onEvent?.({ event, task: request.task, ...extra });
    };
    this.opts.metrics?.record('director', `${request.task}.calls`);
    emit('started', { inputChars: request.input.length });

    let provider: ChatProvider;
    try {
      provider = this.provider();
    } catch (error) {
      return this.fail(request.task, startedAt, emit, 'provider_unavailable', error);
    }
    if (!provider || !provider.configured) {
      return this.fail(request.task, startedAt, emit, 'not_configured');
    }
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('director request aborted');

    const controller = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let removeExternalAbort = (): void => undefined;
    const timeoutError = new HttpTimeoutError(`director ${request.task} timed out after ${request.timeoutMs}ms`);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError);
        reject(timeoutError);
      }, request.timeoutMs);
    });
    const externalAbortPromise = request.signal
      ? new Promise<never>((_, reject) => {
          const abort = (): void => {
            controller.abort(request.signal?.reason);
            reject(request.signal?.reason ?? new Error('director request aborted'));
          };
          request.signal!.addEventListener('abort', abort, { once: true });
          removeExternalAbort = () => request.signal?.removeEventListener('abort', abort);
        })
      : null;

    const operation = provider.complete({
      system: request.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: request.input }] }],
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      jsonMode: true,
      signal: controller.signal
    });
    // A provider should honor AbortSignal, but attaching a rejection handler
    // prevents a late rejection after the task timeout from becoming unhandled.
    operation.catch(() => undefined);

    try {
      const result = await Promise.race([
        operation,
        timeoutPromise,
        ...(externalAbortPromise ? [externalAbortPromise] : [])
      ]);
      const parsed = request.schema.safeParse(extractJsonObject(result.text));
      if (!parsed.success) {
        return this.fail(request.task, startedAt, emit, 'invalid_json', parsed.error);
      }
      const latencyMs = Date.now() - startedAt;
      this.opts.metrics?.record('director', `${request.task}.success`);
      this.opts.metrics?.record('director', `${request.task}.latency_ms`, latencyMs);
      emit('completed', {
        latencyMs,
        outputChars: result.text.length,
        model: result.model || provider.name
      });
      return { data: parsed.data, model: result.model || provider.name, latencyMs };
    } catch (error) {
      if (request.signal?.aborted && !timedOut) throw error;
      return this.fail(request.task, startedAt, emit, timedOut ? 'timeout' : errorName(error), error);
    } finally {
      if (timer) clearTimeout(timer);
      removeExternalAbort();
    }
  }

  recordFallback(task: DirectorTask, reason: string): void {
    this.opts.metrics?.record('director', `${task}.fallback`);
    this.opts.onEvent?.({ event: 'fallback', task, reason });
  }

  private fail<T>(
    task: DirectorTask,
    startedAt: number,
    emit: (event: DirectorEvent['event'], extra?: Omit<DirectorEvent, 'event' | 'task'>) => void,
    reason: string,
    _error?: unknown
  ): null {
    const latencyMs = Date.now() - startedAt;
    this.opts.metrics?.record('director', `${task}.failed`);
    this.opts.metrics?.record('director', `${task}.latency_ms`, latencyMs);
    emit('failed', { latencyMs, reason });
    return null;
  }
}

function errorName(error: unknown): string {
  if (error instanceof HttpTimeoutError) return 'timeout';
  if (error instanceof Error && error.name) return error.name.slice(0, 40);
  return 'provider_error';
}
