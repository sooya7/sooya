import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { JobWorker } from '../src/core/jobs.js';
import { createHarness, type Harness } from './helpers/harness.js';
import { eventually } from './helpers/eventually.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

describe('execution lanes', () => {
  it('critical work starts while autonomous/maintenance work is waiting', async () => {
    harness = await createHarness({ startWorkers: false });
    const worker = new JobWorker(harness.app.repos.jobs, harness.app.repos.errors, { intervalMs: 10 });
    let maintenanceStarted = false;
    let releaseMaintenance!: () => void;
    const maintenanceReleased = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
    let criticalStarted = false;
    worker.register('test.maintenance', async () => {
      maintenanceStarted = true;
      await maintenanceReleased;
    }, { lane: 'maintenance', timeoutMs: 5000 });
    worker.register('test.critical', async () => {
      criticalStarted = true;
    }, { lane: 'critical', timeoutMs: 5000 });
    harness.app.repos.jobs.enqueue('test.maintenance', {}, { priority: 1, maxAttempts: 1 });
    worker.start();
    await eventually(() => expect(maintenanceStarted).toBe(true));
    harness.app.repos.jobs.enqueue('test.critical', {}, { priority: 100, maxAttempts: 1 });
    await eventually(() => expect(criticalStarted).toBe(true));
    releaseMaintenance();
    await worker.stop();
  });

  it('job metadata exposes timeout, retry and cancellation policy', async () => {
    harness = await createHarness({ startWorkers: false, env: { ADMIN_API_TOKEN: 'lane-test' } });
    const definition = harness.app.services.worker.definition('qq.deliver');
    expect(definition?.lane).toBe('critical');
    expect(definition?.timeoutMs).toBe(15_000);
    expect(definition?.maxAttempts).toBe(1);
    expect(definition?.cancellable).toBe(true);
    expect(definition?.timeoutMode).toBe('abort');
    const row = harness.app.repos.jobs.enqueue('qq.deliver', {});
    expect(row.max_attempts).toBe(1);
    expect(() => harness.app.repos.jobs.enqueue('not-registered', {})).toThrow(/unknown job type/);
  });

  it('a contract timeout fails the job without waiting forever', async () => {
    harness = await createHarness({ startWorkers: false });
    harness.app.services.worker.register('test.timeout', async () => new Promise<void>(() => undefined), {
      lane: 'background', timeoutMs: 20, maxAttempts: 1
    });
    harness.app.repos.jobs.enqueue('test.timeout', {}, { maxAttempts: 1 });
    await harness.app.services.worker.drain(1);
    expect(harness.app.repos.jobs.list(1)[0]?.status).toBe('failed');
    expect(harness.app.repos.jobs.list(1)[0]?.last_error).toContain('timed out');
  });
});
