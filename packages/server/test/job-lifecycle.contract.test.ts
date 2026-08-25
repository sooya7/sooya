import { afterEach, describe, expect, it } from 'vitest';
import { JobWorker } from '../src/core/jobs.js';
import { createHarness, type Harness } from './helpers/harness.js';
import { eventually } from './helpers/eventually.js';

let harness: Harness | null = null;
let worker: JobWorker | null = null;

afterEach(async () => {
  if (worker) await worker.stop();
  worker = null;
  if (harness) await harness.cleanup();
  harness = null;
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('durable job lifecycle contracts', () => {
  it('observe timeout keeps the lane occupied until the handler settles', async () => {
    harness = await createHarness({ startWorkers: false });
    const slowEvents: Array<Record<string, unknown>> = [];
    worker = new JobWorker(harness.app.repos.jobs, harness.app.repos.errors, {
      intervalMs: 5,
      onSlowJob: (info) => slowEvents.push(info)
    });
    let firstStarted = false;
    let firstSettled = false;
    let secondStarted = false;

    worker.register('lifecycle.observe.first', async () => {
      firstStarted = true;
      await sleep(60);
      firstSettled = true;
    }, { lane: 'background', timeoutMs: 15, maxAttempts: 1, retryable: false });
    worker.register('lifecycle.observe.second', async () => {
      secondStarted = true;
    }, { lane: 'background', timeoutMs: 1000, maxAttempts: 1, retryable: false });

    const first = harness.app.repos.jobs.enqueue('lifecycle.observe.first', {}, { priority: 100 });
    const second = harness.app.repos.jobs.enqueue('lifecycle.observe.second', {}, { priority: 50 });
    worker.start();

    await eventually(() => expect(firstStarted).toBe(true));
    await sleep(30);
    expect(firstSettled).toBe(false);
    expect(secondStarted).toBe(false);

    await eventually(() => expect(secondStarted).toBe(true));
    expect(firstSettled).toBe(true);
    expect(harness.app.repos.jobs.list(10).find((row) => row.id === first.id)?.status).toBe('done');
    expect(harness.app.repos.jobs.list(10).find((row) => row.id === second.id)?.status).toBe('done');
    expect(slowEvents).toEqual([
      expect.objectContaining({
        jobId: first.id,
        type: 'lifecycle.observe.first',
        lane: 'background',
        timeoutMs: 15
      })
    ]);
  });

  it('abort timeout waits for cleanup before the next job uses the lane', async () => {
    harness = await createHarness({ startWorkers: false });
    worker = new JobWorker(harness.app.repos.jobs, harness.app.repos.errors, { intervalMs: 5 });
    let cleanupStarted = false;
    let cleanupDone = false;
    let nextStarted = false;

    worker.register('lifecycle.abort.cleanup', async (_payload, context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => {
          cleanupStarted = true;
          setTimeout(() => {
            cleanupDone = true;
            resolve();
          }, 30);
        }, { once: true });
      });
    }, {
      lane: 'background',
      timeoutMs: 10,
      maxAttempts: 1,
      retryable: false,
      cancellable: true,
      timeoutMode: 'abort'
    });
    worker.register('lifecycle.abort.next', async () => {
      nextStarted = true;
    }, { lane: 'background', timeoutMs: 1000, maxAttempts: 1, retryable: false });

    const first = harness.app.repos.jobs.enqueue('lifecycle.abort.cleanup', {}, { priority: 100 });
    const next = harness.app.repos.jobs.enqueue('lifecycle.abort.next', {}, { priority: 50 });
    worker.start();
    await eventually(() => expect(cleanupStarted).toBe(true));
    await sleep(15);
    expect(cleanupDone).toBe(false);
    expect(nextStarted).toBe(false);

    await eventually(() => expect(nextStarted).toBe(true));
    expect(cleanupDone).toBe(true);
    expect(harness.app.repos.jobs.list(10).find((row) => row.id === first.id)?.status).toBe('failed');
    expect(harness.app.repos.jobs.list(10).find((row) => row.id === next.id)?.status).toBe('done');
  });

  it('aborted handlers cannot write a late side effect', async () => {
    harness = await createHarness({ startWorkers: false });
    worker = new JobWorker(harness.app.repos.jobs, harness.app.repos.errors, { intervalMs: 5 });
    let lateSideEffects = 0;

    worker.register('lifecycle.abort.no-late-side-effect', async (_payload, context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => setTimeout(resolve, 20), { once: true });
      });
      if (!context.signal.aborted) lateSideEffects++;
    }, {
      lane: 'background',
      timeoutMs: 10,
      maxAttempts: 1,
      retryable: false,
      cancellable: true,
      timeoutMode: 'abort'
    });

    const row = harness.app.repos.jobs.enqueue('lifecycle.abort.no-late-side-effect', {});
    await worker.drain(1);
    expect(harness.app.repos.jobs.list(10).find((job) => job.id === row.id)?.status).toBe('failed');
    expect(lateSideEffects).toBe(0);
  });

  it('stop waits for active handler cleanup instead of only clearing controllers', async () => {
    harness = await createHarness({ startWorkers: false });
    worker = new JobWorker(harness.app.repos.jobs, harness.app.repos.errors, { intervalMs: 5 });
    let started = false;
    let cleaned = false;

    worker.register('lifecycle.stop.cleanup', async (_payload, context) => {
      started = true;
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => setTimeout(() => {
          cleaned = true;
          resolve();
        }, 30), { once: true });
      });
    }, { lane: 'background', timeoutMs: 5000, maxAttempts: 1, retryable: false });

    harness.app.repos.jobs.enqueue('lifecycle.stop.cleanup', {});
    worker.start();
    await eventually(() => expect(started).toBe(true));
    const stopping = worker.stop();
    await sleep(10);
    expect(cleaned).toBe(false);
    await stopping;
    expect(cleaned).toBe(true);
  });
});
