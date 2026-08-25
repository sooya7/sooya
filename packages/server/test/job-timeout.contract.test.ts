import { describe, expect, it } from 'vitest';
import { QqApiClient } from '../src/channels/qq/client.js';
import { executeWithContract, isAbortError, JobTimeoutError } from '../src/core/jobs/executor.js';
import type { JobContext, JobDefinition } from '../src/core/jobs/types.js';

const context = (signal: AbortSignal, cancel?: () => void): JobContext => ({
  jobId: 'job-timeout-contract',
  type: 'contract.timeout',
  lane: 'critical',
  attempt: 1,
  signal,
  cancel
});

describe('job timeout and cancellation contracts', () => {
  it('abort mode propagates cancellation to the handler signal', async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const definition: JobDefinition = {
      type: 'contract.abort',
      lane: 'critical',
      timeoutMs: 10,
      maxAttempts: 1,
      retryable: true,
      cancellable: true,
      timeoutMode: 'abort',
      execute: async (_payload, jobContext) => {
        observed = jobContext.signal;
        await new Promise<void>((_resolve, reject) => {
          jobContext.signal.addEventListener('abort', () => reject(new Error('cooperative abort')), { once: true });
        });
      }
    };

    await expect(executeWithContract(definition, {}, context(controller.signal, () => controller.abort()))).rejects.toBeInstanceOf(JobTimeoutError);
    expect(observed?.aborted).toBe(true);
  });

  it('observe mode records timeout without pretending the work was aborted', async () => {
    const controller = new AbortController();
    const definition: JobDefinition = {
      type: 'contract.observe',
      lane: 'background',
      timeoutMs: 10,
      maxAttempts: 1,
      retryable: true,
      cancellable: false,
      timeoutMode: 'observe',
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    const result = await executeWithContract(definition, {}, context(controller.signal, () => controller.abort()));
    expect(result).toMatchObject({ timedOut: true, timeoutMode: 'observe' });
    expect(controller.signal.aborted).toBe(false);
  });

  it('normalizes abort-shaped provider errors in one helper', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isAbortError({ kind: 'timeout' })).toBe(true);
    expect(isAbortError(new Error('ordinary provider failure'))).toBe(false);
  });

  it('passes the job abort signal into the real QQ fetch request', async () => {
    let requestSignal: AbortSignal | undefined;
    let abortObserved = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          abortObserved = true;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
      throw new Error('unreachable');
    };
    const client = new QqApiClient({ appId: 'app', appSecret: 'secret', callbackSecret: 'callback', enabled: true, env: 'production', allowedUsers: [], proactiveEnabled: true }, { fetchImpl, timeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = client.sendC2cTextMessage({ openid: 'owner', content: 'hello', signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    expect(requestSignal).toBeTruthy();
    expect(abortObserved).toBe(true);
  });
});
