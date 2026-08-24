import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

describe('durable job priority', () => {
  it('claims interactive work before older sticker maintenance work', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    const maintenance = harness.app.repos.jobs.enqueue('sticker.embed.backfill', {});
    const reply = harness.app.repos.jobs.enqueue('qq.deliver', {});

    expect(reply.priority).toBeGreaterThan(maintenance.priority);
    expect(harness.app.repos.jobs.claimNext()?.id).toBe(reply.id);
    expect(harness.app.repos.jobs.claimNext()?.id).toBe(maintenance.id);
  });
});
