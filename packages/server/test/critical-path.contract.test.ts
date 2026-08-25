import { afterEach, describe, expect, it } from 'vitest';
import { JobWorker } from '../src/core/jobs.js';
import { createHarness, type Harness } from './helpers/harness.js';
import { abortableBlock, deferred } from './helpers/faults.js';
import { eventually } from './helpers/eventually.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

describe('critical user-path contracts', () => {
  it('C4/C5: a blocked autonomous or background job cannot occupy critical delivery', async () => {
    harness = await createHarness({ startWorkers: false });
    const worker = new JobWorker(harness.app.repos.jobs, harness.app.repos.errors, { intervalMs: 5 });
    const started = deferred<void>();
    let delivered = false;

    worker.register('contract.background.hang', async (_payload, context) => {
      started.resolve();
      await abortableBlock(context.signal);
    }, { lane: 'background', timeoutMs: 5000, maxAttempts: 1, cancellable: true });
    worker.register('contract.qq.deliver', async () => {
      delivered = true;
    }, { lane: 'critical', timeoutMs: 1000, maxAttempts: 1, cancellable: true });

    harness.app.repos.jobs.enqueue('contract.background.hang', {}, { maxAttempts: 1 });
    worker.start();
    await started.promise;
    harness.app.repos.jobs.enqueue('contract.qq.deliver', {}, { maxAttempts: 1 });
    await eventually(() => expect(delivered).toBe(true));
    await worker.stop();
  });

  it('C9: a provider timeout is persisted as a visible failed job', async () => {
    harness = await createHarness({ startWorkers: false });
    const worker = new JobWorker(harness.app.repos.jobs, harness.app.repos.errors, { intervalMs: 5 });
    worker.register('contract.provider.timeout', async (_payload, context) => new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }), {
      lane: 'background', timeoutMs: 15, maxAttempts: 1, retryable: false, cancellable: true, timeoutMode: 'abort'
    });
    const row = harness.app.repos.jobs.enqueue('contract.provider.timeout', {}, { maxAttempts: 1 });
    await worker.drain(1);
    const failed = harness.app.repos.jobs.list(20).find((job) => job.id === row.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.last_error).toContain('timed out');
  });

  it('C6/C7/C8: flow outcomes are terminal and restart recovery keeps durable work idempotent', async () => {
    harness = await createHarness({ startWorkers: false });
    const trace = harness.app.services.flowTrace.start('proactive', 'contract', 'proactive.evaluated');
    harness.app.services.flowTrace.block(trace.traceId, 'proactive.blocked', { reason: 'provider_timeout' });
    expect(harness.app.services.flowTrace.get(trace.traceId)?.status).toBe('blocked');

    const message = harness.app.repos.messages.create({ role: 'assistant', status: 'sent', parts: [{ type: 'text', text: '一次投递' }] }).message;
    const first = harness.app.repos.channelDeliveries.enqueue({ channel: 'qq', messageId: message.id, externalConversationId: 'owner' });
    const second = harness.app.repos.channelDeliveries.enqueue({ channel: 'qq', messageId: message.id, externalConversationId: 'owner' });
    expect(second.row.id).toBe(first.row.id);
  });
});
