import type { ToolDescriptor } from '../../agent/registry.js';
import { MAX_DRAFT_BYTES, normalizeDraftName, type FileDraftService } from './drafts.js';

/**
 * file_write / file_edit / file_read for the reply phase.
 *
 * write and edit are `risk: 'write'` with `deferredEffects`: they only stage
 * text for the reply being written, and nothing is stored or sent unless that
 * reply publishes (see FileDraftService.publish).
 */
export function fileTools(drafts: FileDraftService, opts: { knowledgeAvailable: () => boolean }): ToolDescriptor[] {
  const days = Math.round(drafts.retentionMs / (24 * 60 * 60 * 1000));
  const knowledgeNote = '只有 .md 文件、而且确实值得长期保存（以后还会翻出来用的资料、清单、方案）时才设 save_to_knowledge=true，普通的一次性文件不要存。';

  const write: ToolDescriptor<{ name: string; content: string; save_to_knowledge?: boolean }> = {
    name: 'files.write',
    modelName: 'file_write',
    description: [
      `写一个文本文件（md、txt、脚本、代码、json、csv 等），随这条回复作为文件发给对方。`,
      `同名文件会被新内容整个覆盖。只有对方要你写文件、写脚本、整理成文档时才用；普通聊天不要用。`,
      `服务器只保留每个文件的最新一版，${days} 天内没再改就自动删除。`,
      `回复里简单说一句写好了就行，不要把文件内容再贴一遍。`
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文件名，带扩展名，例如 周末计划.md、backup.sh' },
        content: { type: 'string', description: '完整的文件内容' },
        save_to_knowledge: { type: 'boolean', description: knowledgeNote }
      },
      required: ['name', 'content']
    },
    source: 'local',
    risk: 'write',
    deferredEffects: true,
    maxArgumentBytes: MAX_DRAFT_BYTES + 4096,
    phases: ['reply'],
    handler: async (input, context) => {
      const named = normalizeDraftName(input.name, { requireText: true });
      if ('error' in named) throw new Error(named.error);
      const content = String(input.content ?? '');
      if (!content.trim()) throw new Error('文件内容是空的');
      if (Buffer.byteLength(content, 'utf8') > MAX_DRAFT_BYTES) throw new Error(`文件太大了（上限 ${MAX_DRAFT_BYTES / 1024} KB）`);
      const knowledge = input.save_to_knowledge === true && named.name.toLowerCase().endsWith('.md') && opts.knowledgeAvailable();
      drafts.stageWrite(named.name, content, context ?? {}, knowledge);
      return `已写好 ${named.name}（${[...content].length} 字），会随这条回复发给对方${knowledge ? '，并存进知识库' : ''}。`;
    }
  };

  const edit: ToolDescriptor<{ name: string; old_text: string; new_text: string; save_to_knowledge?: boolean }> = {
    name: 'files.edit',
    modelName: 'file_edit',
    description: [
      '修改一个已有的文本文件：把文件里 old_text 那一段原文换成 new_text，其余内容原样保留；new_text 为空就是删掉那一段。',
      'old_text 必须从文件里原样复制、并且在文件里只出现一次；不确定原文时先用 file_read 看。',
      '对方说哪里不满意、要改某一部分时用它，不要整份重写。改完的新版本会随这条回复发给对方。'
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要改的文件名' },
        old_text: { type: 'string', description: '要替换掉的原文，必须和文件里一字不差' },
        new_text: { type: 'string', description: '换成的新内容；为空表示删除' },
        save_to_knowledge: { type: 'boolean', description: knowledgeNote }
      },
      required: ['name', 'old_text', 'new_text']
    },
    source: 'local',
    risk: 'write',
    deferredEffects: true,
    maxArgumentBytes: MAX_DRAFT_BYTES + 4096,
    phases: ['reply'],
    handler: async (input, context) => {
      const named = normalizeDraftName(input.name, { requireText: true });
      if ('error' in named) throw new Error(named.error);
      const current = await drafts.currentText(named.name, context ?? {});
      if (current === null) throw new Error(`找不到 ${named.name}：可能已经过期删除，或者它不是能改的文本文件。可以用 file_read 看看现在有哪些文件。`);
      const oldText = String(input.old_text ?? '');
      if (!oldText) throw new Error('old_text 不能为空');
      const first = current.indexOf(oldText);
      if (first === -1) throw new Error('文件里找不到这段 old_text，请先用 file_read 看原文再复制');
      if (current.indexOf(oldText, first + oldText.length) !== -1) throw new Error('这段 old_text 在文件里出现了不止一次，请多带一些上下文让它唯一');
      const next = current.slice(0, first) + String(input.new_text ?? '') + current.slice(first + oldText.length);
      if (!next.trim()) throw new Error('改完文件就空了；要清空的话请直接告诉对方');
      if (Buffer.byteLength(next, 'utf8') > MAX_DRAFT_BYTES) throw new Error(`改完文件太大了（上限 ${MAX_DRAFT_BYTES / 1024} KB）`);
      const knowledge = input.save_to_knowledge === true && named.name.toLowerCase().endsWith('.md') && opts.knowledgeAvailable();
      drafts.stageWrite(named.name, next, context ?? {}, knowledge);
      return `已修改 ${named.name}，新版本会随这条回复发给对方。`;
    }
  };

  const read: ToolDescriptor<{ name?: string }> = {
    name: 'files.read',
    modelName: 'file_read',
    description: '读取你写过的、或对方发来的文本文件的最新版本。不传 name 时列出现在还保留着的文件。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '文件名；省略则列出所有文件' } }
    },
    source: 'local',
    risk: 'read',
    phases: ['reply'],
    handler: async (input, context) => {
      const live = drafts.listLive();
      const listing = live.length === 0
        ? '现在没有保留着的文件。'
        : live.map((file) => `- ${file.name}（${file.origin === 'written' ? '你写的' : '对方发来的'}${file.editable ? '' : '，不是文本文件，不能改'}）`).join('\n');
      if (!input.name) return listing;
      const named = normalizeDraftName(input.name, { requireText: false });
      if ('error' in named) throw new Error(named.error);
      const text = await drafts.currentText(named.name, context ?? {});
      if (text === null) return `读不到 ${named.name}。现在保留着的文件：\n${listing}`;
      return text;
    }
  };

  return [write, edit, read] as ToolDescriptor[];
}
