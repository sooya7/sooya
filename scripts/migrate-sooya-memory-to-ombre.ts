import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from '../packages/server/node_modules/better-sqlite3';
import { execFileSync } from 'node:child_process';
import { loadMcpConfig } from '../packages/server/src/mcp/config.js';
import { McpManager } from '../packages/server/src/mcp/manager.js';
import { ToolRegistry } from '../packages/server/src/agent/registry.js';

type LegacyKind = 'profile' | 'preference' | 'relationship' | 'project' | 'event' | 'summary';
type OmbreKind = Exclude<LegacyKind, 'summary'>;

interface LegacyMemory {
  id: string;
  kind: LegacyKind;
  content: string;
  importance: number;
  confidence: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  sources: string[];
}

interface ExportRecord {
  sourceId: string;
  kind: OmbreKind;
  originalKind: LegacyKind;
  content: string;
  importance: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  sourceMessageIds: string[];
  sourceTrace: string;
}

interface Receipt {
  sourceId: string;
  sourceTrace: string;
  state: 'completed' | 'failed';
  result?: string;
  error?: string;
  recordedAt: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbFile = path.resolve(args.db ?? path.join(args.dataDir ?? './data', 'database', 'sooya.db'));
  const outputDir = path.resolve(args.out ?? path.join(args.dataDir ?? './data', 'ombre-migration'));
  const sourceCommit = resolveSourceCommit();
  const runId = new Date().toISOString().replace(/[:.]/gu, '-');
  const jsonlFile = path.join(outputDir, `memories-${runId}.jsonl`);
  const manifestFile = path.join(outputDir, `manifest-${runId}.json`);
  const receiptFile = path.join(outputDir, 'apply-receipts.json');

  if (!fs.existsSync(dbFile)) throw new Error(`legacy database not found: ${dbFile}`);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });

  const memories = readLegacyMemories(dbFile);
  const records = memories.map((memory) => toExportRecord(memory, sourceCommit));
  const jsonl = records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
  fs.writeFileSync(jsonlFile, jsonl, { encoding: 'utf8', mode: 0o600 });

  const manifest = {
    format: 'sooya-ombre-memory-migration/v1',
    mode: args.apply ? 'apply' : 'dry-run',
    sourceDatabase: dbFile,
    sourceCommit,
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    activeOnly: true,
    embeddingsMigrated: false,
    kindMap: { summary: 'event' },
    jsonl: path.basename(jsonlFile),
    jsonlSha256: crypto.createHash('sha256').update(jsonl).digest('hex')
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });

  if (!args.apply) {
    console.log(JSON.stringify({ ...manifest, manifest: manifestFile, preview: records.slice(0, 3) }, null, 2));
    return;
  }

  const receipts = readReceipts(receiptFile);
  const ombre = await connectOmbre(args.mcpConfig);
  try {
    for (const record of records) {
      const previous = receipts[record.sourceId];
      if (previous?.state === 'completed' && previous.sourceTrace === record.sourceTrace) continue;
      try {
        const result = await ombre.callTool('ombre', 'hold', {
          content: record.content,
          tags: `sooya,legacy-${record.kind}`,
          importance: record.importance,
          why_remembered: record.sourceTrace + `; source_messages=${record.sourceMessageIds.join(',') || 'none'}; confidence=${record.confidence}; updated_at=${record.updatedAt}${record.expiresAt ? `; expires_at=${record.expiresAt}` : ''}`
        });
        receipts[record.sourceId] = {
          sourceId: record.sourceId,
          sourceTrace: record.sourceTrace,
          state: 'completed',
          result: stringifyResult(result),
          recordedAt: new Date().toISOString()
        };
      } catch (error) {
        receipts[record.sourceId] = {
          sourceId: record.sourceId,
          sourceTrace: record.sourceTrace,
          state: 'failed',
          error: safeError(error),
          recordedAt: new Date().toISOString()
        };
        writeReceipts(receiptFile, receipts);
        throw error;
      }
      writeReceipts(receiptFile, receipts);
    }
    console.log(JSON.stringify({ ...manifest, manifest: manifestFile, receipts: receiptFile, applied: records.length }, null, 2));
  } finally {
    await ombre.close();
  }
}

function readLegacyMemories(file: string): LegacyMemory[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT id, kind, content, importance, confidence, created_at, updated_at, expires_at
      FROM memories
      WHERE active = 1 AND (kind <> 'project' OR archived_at IS NULL)
      ORDER BY importance DESC, updated_at DESC
    `).all() as Array<Omit<LegacyMemory, 'sources'>>;
    const sourceStmt = db.prepare('SELECT message_id FROM memory_sources WHERE memory_id = ? ORDER BY created_at');
    return rows.map((row) => ({
      ...row,
      sources: (sourceStmt.all(row.id) as Array<{ message_id: string }>).map((source) => source.message_id)
    }));
  } finally {
    db.close();
  }
}

function toExportRecord(memory: LegacyMemory, commit: string): ExportRecord {
  const kind: OmbreKind = memory.kind === 'summary' ? 'event' : memory.kind;
  return {
    sourceId: memory.id,
    kind,
    originalKind: memory.kind,
    content: memory.content,
    importance: Math.max(1, Math.min(10, Math.round(memory.importance * 10))),
    confidence: memory.confidence,
    createdAt: memory.created_at,
    updatedAt: memory.updated_at,
    expiresAt: memory.expires_at,
    sourceMessageIds: memory.sources,
    sourceTrace: `sooya:migration:${commit}:${memory.id}`
  };
}

async function connectOmbre(mcpConfigOverride?: string): Promise<McpManager> {
  const env = process.env;
  const configPath = path.resolve(mcpConfigOverride ?? env.MCP_CONFIG_PATH ?? './config/mcp.json');
  const config = loadMcpConfig(configPath, env);
  const ombre = config.servers.ombre;
  if (!ombre) throw new Error(`Ombre server is not configured in ${configPath}`);
  const manager = new McpManager({ servers: [ombre], registry: new ToolRegistry(), env });
  await manager.connect('ombre');
  return manager;
}

function parseArgs(values: string[]): { apply: boolean; db?: string; out?: string; dataDir?: string; mcpConfig?: string } {
  const parsed: { apply: boolean; db?: string; out?: string; dataDir?: string; mcpConfig?: string } = { apply: false };
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === '--apply') parsed.apply = true;
    else if (value === '--dry-run') parsed.apply = false;
    else if (value === '--db') parsed.db = values[++i];
    else if (value === '--out') parsed.out = values[++i];
    else if (value === '--data-dir') parsed.dataDir = values[++i];
    else if (value === '--mcp-config') parsed.mcpConfig = values[++i];
    else if (value === '--help') {
      console.log('用法: npx tsx scripts/migrate-sooya-memory-to-ombre.ts [--dry-run] [--apply] [--db FILE] [--data-dir DIR] [--out DIR] [--mcp-config FILE]');
      process.exit(0);
    } else throw new Error(`unknown option: ${value}`);
  }
  return parsed;
}

function resolveSourceCommit(): string {
  if (process.env.SOOYA_SOURCE_COMMIT?.trim()) return process.env.SOOYA_SOURCE_COMMIT.trim();
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

function readReceipts(file: string): Record<string, Receipt> {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Receipt>; } catch { return {}; }
}

function writeReceipts(file: string, receipts: Record<string, Receipt>): void {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(receipts, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function stringifyResult(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 1000) : JSON.stringify(value).slice(0, 1000);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+[^\s]+/giu, 'Bearer [REDACTED_SECRET]').slice(0, 500);
}

main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
