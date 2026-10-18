/**
 * Wires the file tools (file_write / file_edit / file_read), read_url and the
 * "save to knowledge" job into the app. Kept out of app.ts on purpose.
 */
import type { ToolRegistry } from '../../agent/registry.js';
import type { ToolPolicy } from '../../agent/tool-policy.js';
import type { FileDraftRepo } from '../../db/repos/file-draft.repo.js';
import type { MediaRepo } from '../../db/repos/media.repo.js';
import type { ErrorLogRepo, JobRepo } from '../../db/repos/misc.repo.js';
import type { MediaStore } from '../../media/store.js';
import type { JobWorker } from '../jobs.js';
import { FileDraftService } from './drafts.js';
import { fileTools } from './tools.js';
import { LinkReader, readUrlTool } from '../links/reader.js';

/** The knowledge vault tool a worth-keeping .md is written with (memory_commit phase only). */
export const KNOWLEDGE_WRITE_TOOL = 'knowledge.knowledge_write';
export const KNOWLEDGE_SAVE_JOB = 'files.knowledge_save';

export interface FilesWiringInput {
  tools: ToolRegistry;
  policy: ToolPolicy;
  repos: { fileDrafts: FileDraftRepo; media: MediaRepo; errors: ErrorLogRepo; jobs: JobRepo };
  mediaStore: MediaStore;
  flags: { filesEnabled: boolean; readUrlEnabled: boolean; retentionMs: number };
  directFetchImpl: typeof fetch;
  /** Proxy-aware fetch for third-party APIs (Tavily). */
  fetchImpl: typeof fetch;
  tavily: () => { baseUrl: string; apiKey: string } | null;
}

export interface FilesWiring {
  /** Null when the file tools are off. */
  files: FileDraftService | null;
  knowledgeAvailable: () => boolean;
}

export function setupFilesAndLinks(input: FilesWiringInput): FilesWiring {
  const knowledgeAvailable = (): boolean => {
    const tool = input.tools.get(KNOWLEDGE_WRITE_TOOL);
    return Boolean(tool && input.policy.check(tool, 'memory_commit').allowed);
  };
  let files: FileDraftService | null = null;
  if (input.flags.filesEnabled) {
    files = new FileDraftService({
      repo: input.repos.fileDrafts,
      mediaStore: input.mediaStore,
      mediaRepo: input.repos.media,
      errors: input.repos.errors,
      retentionMs: input.flags.retentionMs
    });
    for (const tool of fileTools(files, { knowledgeAvailable })) input.tools.register(tool);
  }
  if (input.flags.readUrlEnabled) {
    input.tools.register(readUrlTool(new LinkReader({
      fetchImpl: input.directFetchImpl,
      tavilyFetchImpl: input.fetchImpl,
      tavily: input.tavily
    })) as never);
  }
  return { files, knowledgeAvailable };
}

/**
 * Durable job: copy a file she marked worth keeping into the knowledge vault.
 * Runs after the reply published, in the memory_commit phase the vault's
 * write tool is authorized for. A missing tool or policy refusal is a no-op.
 */
export function registerFileJobs(worker: JobWorker, deps: {
  tools: ToolRegistry;
  policy: ToolPolicy;
  mediaStore: MediaStore;
  errors: ErrorLogRepo;
}): void {
  worker.register(KNOWLEDGE_SAVE_JOB, async (payload) => {
    const name = String(payload.name ?? '');
    const mediaId = String(payload.mediaId ?? '');
    if (!name.toLowerCase().endsWith('.md') || !mediaId) return;
    const tool = deps.tools.get(KNOWLEDGE_WRITE_TOOL);
    if (!tool || !deps.policy.check(tool, 'memory_commit').allowed) return;
    const read = await deps.mediaStore.read(mediaId);
    if (!read) return; // already replaced by a newer version; that one carries its own job
    try {
      await tool.handler({ path: `sooya/files/${name}`, content: read.data.toString('utf8'), overwrite: true }, { phase: 'memory_commit' });
    } catch (error) {
      deps.errors.add('files.knowledge', error instanceof Error ? error.message : String(error), { name });
      throw error;
    }
  });
}
