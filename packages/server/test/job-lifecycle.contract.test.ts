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

    /*
     * 同 abort 用例：handler 的结束时机由测试放行，不靠 sleep 竞速。
     * timeoutMs=15 仍小于「放行前必然经过的时间」，所以 onSlowJob 依旧会触发。
     */
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    worker.register('lifecycle.observe.first', async () => {
      firstStarted = true;
      await firstGate;
      firstSettled = true;
    }, { lane: 'background', timeoutMs: 15, maxAttempts: 1, retryable: false });
    worker.register('lifecycle.observe.second', async () => {
      secondStarted = true;
    }, { lane: 'background', timeoutMs: 1000, maxAttempts: 1, retryable: false });

    const first = harness.app.repos.jobs.enqueue('lifecycle.observe.first', {}, { priority: 100 });
    const second = harness.app.repos.jobs.enqueue('lifecycle.observe.second', {}, { priority: 50 });
    worker.start();

    await eventually(() => expect(firstStarted).toBe(true));
    // 未放行 => handler 一定没 settle，lane 一定还被占着（observe 模式不抢占）。
    await sleep(30);
    expect(firstSettled).toBe(false);
    expect(secondStarted).toBe(false);

    releaseFirst();
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

    /*
     * cleanup 的完成时机由测试显式放行，而不是由一个墙上时钟定时器决定。
     *
     * 原实现让 cleanup 在 abort 后 30ms 自行完成，测试则 `sleep(15)` 后断言「还没
     * 完成」。这条否定断言的正确性依赖「eventually 的轮询延迟 + 15ms < 30ms」，
     * 148 个测试文件并行时轮询轻易超调 15ms 以上，断言就会翻转 —— 这正是该用例
     * 间歇性失败的原因。改成 deferred 之后，「lane 仍被占用」这件事在放行之前
     * 恒为真，与调度快慢和机器负载完全无关。
     */
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });

    worker.register('lifecycle.abort.cleanup', async (_payload, context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => {
          cleanupStarted = true;
          void cleanupGate.then(() => {
            cleanupDone = true;
            resolve();
          });
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

    // 未放行 => cleanup 一定没结束，lane 一定还被占着。给调度器几次 tick 的机会去
    // 犯错（intervalMs=5），确认它并没有把 lane 让给下一个 job。
    await sleep(30);
    expect(cleanupDone).toBe(false);
    expect(nextStarted).toBe(false);

    releaseCleanup();
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
