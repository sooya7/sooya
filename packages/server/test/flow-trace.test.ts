import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

describe('flow traces', () => {
  it('records a bounded user-reply lifecycle and terminal state', async () => {
    harness = await createHarness({ startWorkers: false });
    const trace = harness.app.services.flowTrace.start('user_reply', 'event-1', 'qq.webhook.received');
    harness.app.services.flowTrace.stage(trace.traceId, 'message.persisted', 'ok', { messageId: 'msg-1' });
    harness.app.services.flowTrace.stage(trace.traceId, 'qq.delivery.queued', 'running');
    harness.app.services.flowTrace.finish(trace.traceId, 'ok', { destination: 'qq' });
    const stored = harness.app.services.flowTrace.get(trace.traceId)!;
    expect(stored.kind).toBe('user_reply');
    expect(stored.status).toBe('ok');
    expect(stored.stages.map((stage) => stage.name)).toEqual([
      'qq.webhook.received', 'message.persisted', 'qq.delivery.queued', 'flow.completed'
    ]);
  });

  it('exposes the latest traces through the admin debug endpoint', async () => {
    harness = await createHarness({ startWorkers: false, env: { ADMIN_API_TOKEN: 'trace-test' } });
    harness.app.services.flowTrace.start('proactive', 'attempt-1', 'proactive.evaluated');
    const response = await harness.app.server.inject({
      method: 'GET',
      url: '/api/admin/debug/proactive-flow?limit=5',
      headers: { 'x-admin-token': 'trace-test' }
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { traces: unknown[] }).traces).toHaveLength(1);
  });
});
