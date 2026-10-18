import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';
import { FileDraftService, normalizeDraftName } from '../src/core/files/drafts.js';
import { fileTools } from '../src/core/files/tools.js';
import { ToolRegistry, type ToolDescriptor } from '../src/agent/registry.js';
import { ToolPolicy } from '../src/agent/tool-policy.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const DAY = 24 * 60 * 60 * 1000;

async function rig(opts: { now?: () => number } = {}) {
  h = await createHarness({ skipStickerImport: true, startWorkers: false });
  const drafts = new FileDraftService({
    repo: h.app.repos.fileDrafts,
    mediaStore: h.app.services.mediaStore,
    mediaRepo: h.app.repos.media,
    errors: h.app.repos.errors,
    retentionMs: 3 * DAY,
    ...(opts.now ? { now: opts.now } : {})
  });
  const tools = Object.fromEntries(fileTools(drafts, { knowledgeAvailable: () => true }).map((tool) => [tool.modelName!, tool])) as Record<string, ToolDescriptor<Record<string, unknown>>>;
  const ctx = (revision = 1) => ({ phase: 'reply' as const, batchId: 'b1', revision });
  return { drafts, tools, ctx };
}

describe('file tools: write, edit, read', () => {
  it('stages a write and publishes it as the latest version of the name', async () => {
    const { drafts, tools, ctx } = await rig();
    await tools.file_write!.handler({ name: '周末计划.md', content: '# 周末\n\n- 周六爬山\n- 周日看电影\n' }, ctx());
    // Nothing is stored before the reply publishes.
    expect(h!.app.repos.fileDrafts.get('周末计划.md')).toBeUndefined();

    const published = await drafts.publish('b1', 1);
    expect(published).toEqual([{ name: '周末计划.md', mediaId: expect.any(String), saveToKnowledge: false }]);
    const row = h!.app.repos.fileDrafts.get('周末计划.md')!;
    expect(row).toMatchObject({ origin: 'written', editable: 1, version: 1 });
    const media = h!.app.repos.media.get(row.media_id)!;
    expect(media.mime).toBe('text/markdown');
    expect((await drafts.storedText('周末计划.md'))?.text).toContain('周六爬山');
  });

  it('a superseded generation leaves nothing behind', async () => {
    const { drafts, tools, ctx } = await rig();
    await tools.file_write!.handler({ name: 'a.md', content: '第一版' }, ctx(1));
    expect(await drafts.publish('b1', 2)).toEqual([]);
    expect(h!.app.repos.fileDrafts.get('a.md')).toBeUndefined();
  });

  it('edits only the passage she points at, and replaces the previous media', async () => {
    const { drafts, tools, ctx } = await rig();
    await tools.file_write!.handler({ name: 'backup.sh', content: '#!/bin/sh\nset -e\ntar czf a.tgz ./data\necho done\n' }, ctx(1));
    await drafts.publish('b1', 1);
    const firstMedia = h!.app.repos.fileDrafts.get('backup.sh')!.media_id;

    const result = await tools.file_edit!.handler({ name: 'backup.sh', old_text: 'tar czf a.tgz ./data', new_text: 'tar czf "$(date +%F).tgz" ./data' }, ctx(2));
    expect(String(result)).toContain('已修改');
    await drafts.publish('b1', 2);

    const row = h!.app.repos.fileDrafts.get('backup.sh')!;
    expect(row.version).toBe(2);
    expect(row.media_id).not.toBe(firstMedia);
    expect(h!.app.repos.media.get(firstMedia)).toBeUndefined();
    const text = (await drafts.storedText('backup.sh'))!.text;
    expect(text).toBe('#!/bin/sh\nset -e\ntar czf "$(date +%F).tgz" ./data\necho done\n');
  });

  it('deleting a passage is an edit with empty new_text', async () => {
    const { drafts, tools, ctx } = await rig();
    await tools.file_write!.handler({ name: 'list.md', content: '- 牛奶\n- 鸡蛋\n- 面包\n' }, ctx(1));
    await tools.file_edit!.handler({ name: 'list.md', old_text: '- 鸡蛋\n', new_text: '' }, ctx(1));
    await drafts.publish('b1', 1);
    expect((await drafts.storedText('list.md'))!.text).toBe('- 牛奶\n- 面包\n');
  });

  it('refuses ambiguous or missing passages with an actionable message', async () => {
    const { drafts, tools, ctx } = await rig();
    await tools.file_write!.handler({ name: 'x.txt', content: 'aa bb aa' }, ctx(1));
    await drafts.publish('b1', 1);
    await expect(tools.file_edit!.handler({ name: 'x.txt', old_text: 'aa', new_text: 'cc' }, ctx(2))).rejects.toThrow(/不止一次/);
    await expect(tools.file_edit!.handler({ name: 'x.txt', old_text: 'zz', new_text: 'cc' }, ctx(2))).rejects.toThrow(/找不到这段/);
    await expect(tools.file_edit!.handler({ name: 'nope.md', old_text: 'a', new_text: 'b' }, ctx(2))).rejects.toThrow(/找不到 nope\.md/);
  });

  it('only accepts safe text file names', () => {
    expect(normalizeDraftName('../../etc/passwd.md', { requireText: true })).toEqual({ name: 'passwd.md' });
    expect(normalizeDraftName('run.exe', { requireText: true })).toMatchObject({ error: expect.stringContaining('不支持') });
    expect(normalizeDraftName('', { requireText: true })).toMatchObject({ error: expect.any(String) });
  });

  it('file_read lists live files and reads the staged version inside the same reply', async () => {
    const { drafts, tools, ctx } = await rig();
    await tools.file_write!.handler({ name: 'notes.md', content: '旧的' }, ctx(1));
    await drafts.publish('b1', 1);
    await tools.file_write!.handler({ name: 'notes.md', content: '新的' }, ctx(2));
    expect(await tools.file_read!.handler({}, ctx(2))).toContain('notes.md（你写的）');
    expect(await tools.file_read!.handler({ name: 'notes.md' }, ctx(2))).toBe('新的');
    expect(await tools.file_read!.handler({ name: 'notes.md' }, ctx(3))).toBe('旧的');
  });

  it('marks a worth-keeping .md for the knowledge vault, never other types', async () => {
    const { drafts, tools, ctx } = await rig();
    await tools.file_write!.handler({ name: '方案.md', content: '要长期留着的', save_to_knowledge: true }, ctx(1));
    await tools.file_write!.handler({ name: 'run.sh', content: 'echo hi', save_to_knowledge: true }, ctx(1));
    const published = await drafts.publish('b1', 1);
    expect(published.map((file) => [file.name, file.saveToKnowledge])).toEqual([['方案.md', true], ['run.sh', false]]);
  });
});

describe('file retention', () => {
  it('removes a file once the retention window passes without a change', async () => {
    let now = Date.parse('2026-10-19T00:00:00Z');
    const { drafts, tools, ctx } = await rig({ now: () => now });
    await tools.file_write!.handler({ name: 'keep.md', content: '内容' }, ctx(1));
    await drafts.publish('b1', 1);
    // updated_at is the wall clock; move "now" relative to it.
    now = Date.parse(h!.app.repos.fileDrafts.get('keep.md')!.updated_at);
    const mediaId = h!.app.repos.fileDrafts.get('keep.md')!.media_id;

    now += 2 * DAY;
    expect(await drafts.sweep()).toEqual([]);
    expect(await drafts.storedText('keep.md')).not.toBeNull();

    now += 1 * DAY + 60_000;
    expect(await drafts.storedText('keep.md')).toBeNull();
    expect(await drafts.sweep()).toEqual(['keep.md']);
    expect(h!.app.repos.fileDrafts.get('keep.md')).toBeUndefined();
    expect(h!.app.repos.media.get(mediaId)).toBeUndefined();
  });

  it('a received text file becomes editable under the same name', async () => {
    const { drafts, tools, ctx } = await rig();
    const media = await h!.app.services.mediaStore.save({ kind: 'file', origin: 'remote', data: Buffer.from('print("hi")\n'), declaredMime: 'text/plain', filename: 'hello.py' });
    expect(await drafts.registerReceived(media.id, 'hello.py')).toBe('hello.py');
    expect(h!.app.repos.fileDrafts.get('hello.py')).toMatchObject({ origin: 'received', editable: 1 });
    await tools.file_edit!.handler({ name: 'hello.py', old_text: '"hi"', new_text: '"你好"' }, ctx(1));
    await drafts.publish('b1', 1);
    expect((await drafts.storedText('hello.py'))!.text).toBe('print("你好")\n');
    expect(h!.app.repos.media.get(media.id)).toBeUndefined();
  });
});

describe('tool policy for staged writes', () => {
  const base = (overrides: Partial<ToolDescriptor>): ToolDescriptor => ({
    name: 'files.write', description: 'x', inputSchema: { type: 'object' }, source: 'local', risk: 'write', phases: ['reply', 'proactive'],
    handler: async () => 'ok', ...overrides
  });

  it('allows a deferred local write in the reply phase only', () => {
    const registry = new ToolRegistry();
    const policy = new ToolPolicy(registry);
    expect(policy.check(base({ deferredEffects: true }), 'reply').allowed).toBe(true);
    expect(policy.check(base({ deferredEffects: true }), 'proactive').allowed).toBe(false);
    expect(policy.check(base({}), 'reply')).toMatchObject({ allowed: false, reason: 'non-read-tool-in-visible-phase' });
    expect(policy.check(base({ deferredEffects: true, source: 'mcp', serverId: 's', authorized: true }), 'reply').allowed).toBe(false);
    expect(new ToolPolicy(registry, { writeEnabled: false }).check(base({ deferredEffects: true }), 'reply')).toMatchObject({ allowed: false, reason: 'write-disabled' });
  });
});

describe('file_write end to end through a reply', () => {
  it('attaches the written file to her reply and keeps it as the latest version', async () => {
    let toolRound = 0;
    h = await createHarness({
      skipStickerImport: true,
      chatSupportsTools: true,
      env: { FILE_TOOLS_ENABLED: 'true' },
      chat: {
        script: [['写好啦，发你了～']],
        respond: ({ body }) => {
          const b = body as { stream?: boolean; tools?: unknown[] };
          if (b.stream === true || !Array.isArray(b.tools)) return null;
          toolRound += 1;
          const message = toolRound === 1
            ? { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_write', arguments: JSON.stringify({ name: '购物清单.md', content: '- 牛奶\n- 鸡蛋\n' }) } }] }
            : { content: '' };
          return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      }
    });
    await sendText(h.app, '帮我写个购物清单');
    let assistant = null as ReturnType<typeof h.app.repos.messages.recent>[number] | null;
    for (let i = 0; i < 200 && !assistant?.content.some((p) => p.type === 'file'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assistant = h.app.repos.messages.recent(10).find((m) => m.role === 'assistant') ?? null;
    }
    const file = assistant?.content.find((p) => p.type === 'file');
    expect(file).toBeTruthy();
    expect(file!.meta).toMatchObject({ fileName: '购物清单.md', draft: true });
    expect(h.app.repos.fileDrafts.get('购物清单.md')?.media_id).toBe(file!.mediaId);
    expect(assistant!.content.find((p) => p.type === 'text')?.text).toContain('写好啦');
  });
});

describe('saving a worth-keeping file to the knowledge vault', () => {
  it('finds the vault write tool the MCP bridge registered and writes under sooya/files', async () => {
    const { bridgeMcpTools } = await import('../src/mcp/tool-bridge.js');
    const { registerFileJobs, setupFilesAndLinks } = await import('../src/core/files/wiring.js');
    h = await createHarness({ skipStickerImport: true, startWorkers: false });
    const registry = new ToolRegistry();
    const writes: Array<{ name: string; args: Record<string, unknown> }> = [];
    const tools = bridgeMcpTools(
      { id: 'knowledge', toolPolicy: { knowledge_write: { risk: 'write', phases: ['memory_commit'], authorized: true } } } as never,
      {} as never,
      [{ name: 'knowledge_write', inputSchema: { type: 'object' } }],
      async (name, args) => { writes.push({ name, args }); return { content: [{ type: 'text', text: 'ok' }] }; }
    );
    for (const tool of tools) registry.register(tool);
    const policy = new ToolPolicy(registry);
    const wiring = setupFilesAndLinks({
      tools: registry, policy, repos: h.app.repos, mediaStore: h.app.services.mediaStore,
      flags: { filesEnabled: false, readUrlEnabled: false, retentionMs: DAY },
      directFetchImpl: fetch, fetchImpl: fetch, tavily: () => null
    });
    expect(wiring.knowledgeAvailable()).toBe(true);

    const handlers = new Map<string, (payload: Record<string, unknown>) => Promise<void>>();
    registerFileJobs({ register: (type: string, fn: never) => handlers.set(type, fn) } as never, { tools: registry, policy, mediaStore: h.app.services.mediaStore, errors: h.app.repos.errors });
    const media = await h.app.services.mediaStore.save({ kind: 'file', origin: 'generated', data: Buffer.from('# 方案\n'), declaredMime: 'text/markdown', filename: '方案.md' });
    await handlers.get('files.knowledge_save')!({ name: '方案.md', mediaId: media.id });
    expect(writes).toEqual([{ name: 'knowledge_write', args: { path: 'sooya/files/方案.md', content: '# 方案\n', overwrite: true } }]);
  });
});
