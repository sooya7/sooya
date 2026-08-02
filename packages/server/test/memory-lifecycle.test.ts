import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;

afterEach(async () => {
  if (h) await h.cleanup();
});

describe('memory lifecycle', () => {
  it('adds lifecycle columns while retaining the legacy active flag', async () => {
    h = await createHarness();

    const columns = h.app.db
      .prepare('PRAGMA table_info(memories)')
      .all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['active', 'supersedes_id', 'superseded_by_id', 'archived_at'])
    );
  });

  it('atomically replaces a fact and preserves both sides of the supersession link', async () => {
    h = await createHarness();
    const old = h.app.repos.memories.upsert({
      kind: 'profile',
      content: 'User lives in Hangzhou',
      sourceMessageId: 'message-old'
    }).record;

    const result = h.app.repos.memories.replace(old.id, {
      kind: 'profile',
      content: 'User lives in Shanghai',
      sourceMessageId: 'message-new'
    });

    const oldRow = h.app.db.prepare('SELECT active, superseded_by_id FROM memories WHERE id = ?').get(old.id) as {
      active: number;
      superseded_by_id: string | null;
    };
    const newRow = h.app.db.prepare('SELECT active, supersedes_id FROM memories WHERE id = ?').get(result.replacement.id) as {
      active: number;
      supersedes_id: string | null;
    };

    expect(oldRow).toEqual({ active: 0, superseded_by_id: result.replacement.id });
    expect(newRow).toEqual({ active: 1, supersedes_id: old.id });
    expect(result.previous.supersededById).toBe(result.replacement.id);
    expect(result.replacement.supersedesId).toBe(old.id);
    expect(result.replacement.sources).toEqual(['message-new']);
    expect(h.app.repos.memories.list()).toEqual([result.replacement]);
    expect(h.app.repos.memories.searchFts('Hangzhou').map((record) => record.id)).not.toContain(old.id);
  });

  it('archives projects without deleting them or returning them from ordinary recall', async () => {
    h = await createHarness({ embedding: 'off' });
    const project = h.app.repos.memories.upsert({
      kind: 'project',
      content: 'Project Luna is migrating its memory schema',
      sourceMessageId: 'message-project'
    }).record;

    expect((await h.app.services.memory.recall('Luna')).memories).toHaveLength(1);
    expect(h.app.repos.memories.archive(project.id)).toBe(true);

    const archived = h.app.repos.memories.get(project.id)!;
    expect(archived.archivedAt).toBeTruthy();
    expect(archived.sources).toEqual(['message-project']);
    expect((await h.app.services.memory.recall('Luna')).memories).toHaveLength(0);
    expect(h.app.repos.memories.get(project.id)).toEqual(archived);
    expect(h.app.repos.memories.list({ includeInactive: true })).toEqual([archived]);
  });

  it('supports supersede as the explicit lifecycle operation', async () => {
    h = await createHarness();
    const old = h.app.repos.memories.upsert({ kind: 'event', content: 'The meeting is on Monday' }).record;
    const result = h.app.repos.memories.supersede(old.id, { kind: 'event', content: 'The meeting is on Tuesday' });

    expect(result.previous.id).toBe(old.id);
    expect(result.replacement.supersedesId).toBe(old.id);
  });

  it('rolls back both sides when replacement insertion fails', async () => {
    h = await createHarness();
    const old = h.app.repos.memories.upsert({ kind: 'profile', content: 'User lives in Hangzhou' }).record;

    expect(() => h.app.repos.memories.replace(old.id, { kind: 'invalid' as never, content: 'New fact' })).toThrow();
    expect(h.app.db.prepare('SELECT active, superseded_by_id FROM memories WHERE id = ?').get(old.id)).toEqual({
      active: 1,
      superseded_by_id: null
    });
    expect(h.app.repos.memories.count(false)).toBe(1);
  });
});
