/**
 * Host-side guard around the `srv` MCP server (root ops on this machine).
 *
 * The remote tools stay as they are; this wraps them before they are
 * registered: she cannot restart or kill herself (or the bridges she talks
 * through), log tails are clamped so one call cannot flood the context, every
 * run_command is written to an audit log, and the descriptions she sees are
 * Chinese and say what to report back.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDescriptor, ToolExecutionContext } from '../../agent/registry.js';

export const SRV_SERVER_ID = 'srv';
const LOG_LINE_CAP = 200;
const COMMAND_TIMEOUT_CAP_S = 100;
const PROTECTED_UNITS = new Set(['sooya', 'srv-mcp-bridge', 'agent-knowledge']);
const UNIT = '(?<![\\w/.-])(?:sooya|srv-mcp-bridge|agent-knowledge)(?:\\.service)?(?![\\w.-])';
const SELF_HARM: RegExp[] = [
  new RegExp(`\\bsystemctl\\b[^;&|\\n]*\\b(?:restart|try-restart|reload-or-restart|stop|kill|disable|mask)\\b[^;&|\\n]*${UNIT}`, 'i'),
  new RegExp(`\\bservice\\s+${UNIT}\\s+(?:restart|stop)\\b`, 'i'),
  /\b(?:pkill|killall)\b[^;&|\n]*\b(?:node|sooya|main\.js|srv-bridge|server\.py|python3?)\b/i,
  /\bkill\b[^;&|\n]*\$\([^)]*\b(?:pgrep|pidof|systemctl|pid)\b[^)]*\b(?:node|sooya|srv|python|knowledge)/i
];

const REPORT = '做完告诉主人：改了哪个文件、改了什么、备份在哪。';
const DESCRIPTIONS: Record<string, string> = {
  read_file_raw: '读服务器上的文本文件原文（不打码，Key 也是原样）。要改配置先用它看原文，再用 edit_file 改。',
  edit_file: `在服务器文件里把 old_text 换成 new_text（old_text 必须在文件里恰好出现一次，从 read_file_raw 读到的原文里复制）。改之前会自动备份。${REPORT}`,
  save_file: `整文件写入服务器上的文件（新建或覆盖），用于新建配置或大改；已有文件会先自动备份。${REPORT}`,
  docker_restart: '重启一个 docker 容器。重启 luker 前先用 docker_logs 看一眼有没有正在生成，有就等它结束。做完告诉主人重启了什么、现在状态如何。',
  service_restart: '重启一个 systemd 服务（sooya 自己、srv-mcp-bridge、agent-knowledge 不能重启）。做完用 service_status 看一眼，告诉主人重启了什么、现在状态如何。',
  run_command: '以 root 在服务器上执行一条 shell 命令（每条都会留记录）。看文件内容用 read_file_raw，别用 cat 读出来再写回；改文件用 edit_file / save_file。不能重启或结束 sooya 自己。做完告诉主人做了什么、结果如何。',
  docker_logs: `看 docker 容器最近的日志，tail 最多 ${LOG_LINE_CAP} 行。`,
  journal_logs: `看 systemd 日志（journalctl），lines 最多 ${LOG_LINE_CAP} 行，可用 since 如 "1h ago"。`,
  project_logs: `看项目日志文件末尾，lines 最多 ${LOG_LINE_CAP} 行。`
};

export interface OpsCommandEntry {
  at: string;
  command: string;
  exitCode: number | null;
  status: 'ok' | 'failed' | 'blocked' | 'error';
  durationMs: number;
  batchId?: string;
  messageId?: string;
}

export interface SrvToolsDeps {
  commandLog: OpsCommandLog;
  /** Resolves the reply that triggered a call to its user message (for the log / flow trace). */
  origin?: (context?: ToolExecutionContext) => { messageId?: string; flowTraceId?: string };
  onCommand?: (entry: OpsCommandEntry, flowTraceId?: string) => void;
}

export function decorateSrvTools(tools: ToolDescriptor[], deps: SrvToolsDeps): ToolDescriptor[] {
  return tools.map((tool) => {
    const remote = tool.remoteName ?? '';
    const description = DESCRIPTIONS[remote] ?? tool.description;
    const inner = tool.handler;
    let handler = inner;
    if (remote === 'service_restart' || remote === 'service_stop' || remote === 'service_start') {
      handler = async (input, context) => {
        const name = String((input as { name?: unknown })?.name ?? '').trim().toLowerCase().replace(/\.service$/u, '');
        if (PROTECTED_UNITS.has(name)) throw new Error(`${name} 不能从这里重启或停止（会把正在回复的自己或通道切断）`);
        return inner(input, context);
      };
    } else if (remote === 'docker_logs') {
      handler = (input, context) => inner(clampNumber(input, 'tail', 100, LOG_LINE_CAP), context);
    } else if (remote === 'journal_logs' || remote === 'project_logs') {
      handler = (input, context) => inner(clampNumber(input, 'lines', 100, LOG_LINE_CAP), context);
    } else if (remote === 'run_command') {
      handler = runCommandHandler(inner, deps);
    }
    return { ...tool, description, handler };
  });
}

function runCommandHandler(inner: ToolDescriptor['handler'], deps: SrvToolsDeps): ToolDescriptor['handler'] {
  return async (input, context) => {
    const command = String((input as { command?: unknown })?.command ?? '');
    const started = Date.now();
    const origin = deps.origin?.(context) ?? {};
    const record = (status: OpsCommandEntry['status'], exitCode: number | null): void => {
      const entry: OpsCommandEntry = {
        at: new Date(started).toISOString(),
        command,
        exitCode,
        status,
        durationMs: Date.now() - started,
        ...(context?.batchId ? { batchId: context.batchId } : {}),
        ...(origin.messageId ? { messageId: origin.messageId } : {})
      };
      deps.commandLog.append(entry);
      deps.onCommand?.(entry, origin.flowTraceId);
    };
    if (isSelfHarm(command)) {
      record('blocked', null);
      throw new Error('这条命令会重启或结束 sooya 自己（或她用的通道），不能执行');
    }
    try {
      const result = await inner(clampNumber(input, 'timeout', 60, COMMAND_TIMEOUT_CAP_S), context);
      const { exitCode, ok, blocked } = commandOutcome(result);
      record(blocked ? 'blocked' : ok ? 'ok' : 'failed', exitCode);
      return result;
    } catch (error) {
      record('error', null);
      throw error;
    }
  };
}

export function isSelfHarm(command: string): boolean {
  return SELF_HARM.some((pattern) => pattern.test(command));
}

function clampNumber(input: unknown, key: string, fallback: number, max: number): Record<string, unknown> {
  const args = { ...(input && typeof input === 'object' ? input as Record<string, unknown> : {}) };
  const raw = Number(args[key] ?? fallback);
  args[key] = Math.max(1, Math.min(max, Number.isFinite(raw) ? Math.trunc(raw) : fallback));
  return args;
}

/** run_command returns {ok, exit_code, stdout, stderr}; dig it out of whichever MCP shape carried it. */
function commandOutcome(result: unknown): { exitCode: number | null; ok: boolean; blocked: boolean } {
  const record = findRecord(result, 0);
  if (!record) return { exitCode: null, ok: false, blocked: false };
  const exitCode = typeof record.exit_code === 'number' ? record.exit_code : null;
  const blocked = typeof record.error === 'string' && /^blocked/i.test(record.error);
  return { exitCode, ok: record.ok === true, blocked };
}

function findRecord(value: unknown, depth: number): Record<string, unknown> | null {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try { return findRecord(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ('exit_code' in record || ('ok' in record && 'error' in record)) return record;
  for (const key of ['value', 'structuredContent', 'result', 'text']) {
    const found = findRecord(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/** Append-only JSONL audit of every command she ran, rotated by size (current + one old file). */
export class OpsCommandLog {
  constructor(private readonly file: string, private readonly maxBytes = 2.5 * 1024 * 1024) {}

  append(entry: OpsCommandEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      if (size > this.maxBytes) fs.renameSync(this.file, `${this.file}.1`);
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // The audit must never take the command (or the reply) down with it.
    }
  }
}
