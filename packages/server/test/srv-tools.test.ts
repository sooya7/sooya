import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpManager } from '../src/mcp/manager.js';
import { ToolRegistry } from '../src/agent/registry.js';
import { ToolPolicy } from '../src/agent/tool-policy.js';
import { OpsCommandLog, decorateSrvTools, isSelfHarm, type OpsCommandEntry } from '../src/core/ops/srv-tools.js';
import type { McpClientLike, McpServerConfig } from '../src/mcp/types.js';

const REMOTE = ['read_file', 'read_file_raw', 'edit_file', 'save_file', 'write_file', 'docker_logs', 'journal_logs', 'service_restart', 'service_stop', 'run_command', 'docker_restart'];

function srvConfig(): McpServerConfig {
  const read = { risk: 'read' as const, phases: ['reply' as const], authorized: true };
  const write = { risk: 'write' as const, phases: ['reply' as const], authorized: true, allowInReply: true };
  const ops = { risk: 'maintenance' as const, phases: ['reply' as const], authorized: true, allowInReply: true, timeoutMs: 120_000 };
  return {
    id: 'srv', enabled: true, transport: 'streamable-http', url: 'http://127.0.0.1:18201/mcp', auth: { type: 'none' }, required: false,
    connectTimeoutMs: 1000, toolTimeoutMs: 120_000,
    toolPolicy: {
      read_file_raw: read, docker_logs: read, journal_logs: read,
      edit_file: write, save_file: write,
      service_restart: ops, run_command: ops, docker_restart: ops
    }
  };
}

function setup() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const entries: OpsCommandEntry[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-tools-'));
  const logFile = path.join(dir, 'ops-commands.log');
  const client: McpClientLike = {
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => ({ tools: REMOTE.map((name) => ({ name, description: `remote ${name}`, inputSchema: { type: 'object' } })) }),
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args: args ?? {} });
      if (name === 'run_command') {
        const command = String(args?.command ?? '');
        const result = command.includes('false') ? { ok: false, exit_code: 1, stdout: '', stderr: '' } : { ok: true, exit_code: 0, stdout: 'up 3 days', stderr: '' };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  };
  const registry = new ToolRegistry();
  const log = new OpsCommandLog(logFile);
  const manager = new McpManager({
    servers: [srvConfig()],
    registry,
    clientFactory: async () => ({ client }),
    decorate: (serverId, tools) => serverId === 'srv' ? decorateSrvTools(tools, {
      commandLog: log,
      origin: (context) => (context?.batchId ? { messageId: `msg-of-${context.batchId}`, flowTraceId: 'trace-1' } : {}),
      onCommand: (entry) => entries.push(entry)
    }) : tools
  });
  const policy = new ToolPolicy(registry);
  const call = (modelName: string, args: Record<string, unknown>) => {
    const tool = policy.resolve(modelName)!;
    return tool.handler(args, { phase: 'reply', batchId: 'batch-9' });
  };
  return { manager, registry, policy, calls, entries, logFile, call };
}

describe('srv ops tools', () => {
  it('offers only the tools listed in toolPolicy; the redacting read_file and plain write_file stay hidden', async () => {
    const { manager, policy, registry } = setup();
    await manager.connectAllBestEffort();
    const names = policy.definitions('reply').map((tool) => tool.name).sort();
    expect(names).toEqual(['srv__docker_logs', 'srv__docker_restart', 'srv__edit_file', 'srv__journal_logs', 'srv__read_file_raw', 'srv__run_command', 'srv__save_file', 'srv__service_restart']);
    expect(registry.require('srv.run.command').timeoutMs).toBe(120_000);
    expect(registry.require('srv.edit.file').description).toContain('备份在哪');
  });

  it('refuses to restart or stop herself and the bridges she talks through', async () => {
    const { manager, call, calls } = setup();
    await manager.connectAllBestEffort();
    for (const name of ['sooya', 'sooya.service', 'SRV-MCP-BRIDGE', 'agent-knowledge.service']) {
      await expect(call('srv__service_restart', { name })).rejects.toThrow(/不能从这里重启/);
    }
    await call('srv__service_restart', { name: 'nginx' });
    expect(calls).toEqual([{ name: 'service_restart', args: { name: 'nginx' } }]);
  });

  it('clamps log tails to 200 lines and command timeouts below the call budget', async () => {
    const { manager, call, calls } = setup();
    await manager.connectAllBestEffort();
    await call('srv__docker_logs', { container: 'luker', tail: 5000 });
    await call('srv__journal_logs', { unit: 'nginx', lines: 999 });
    await call('srv__docker_logs', { container: 'luker', tail: 50 });
    await call('srv__run_command', { command: 'uptime', timeout: 300 });
    expect(calls.map((item) => item.args)).toEqual([
      { container: 'luker', tail: 200 },
      { unit: 'nginx', lines: 200 },
      { container: 'luker', tail: 50 },
      { command: 'uptime', timeout: 100 }
    ]);
  });

  it('records every run_command (blocked ones too) with exit code, duration and the triggering message', async () => {
    const { manager, call, entries, logFile } = setup();
    await manager.connectAllBestEffort();
    await call('srv__run_command', { command: 'uptime' });
    await call('srv__run_command', { command: 'false' });
    await expect(call('srv__run_command', { command: 'systemctl restart sooya' })).rejects.toThrow(/不能执行/);
    expect(entries.map((entry) => [entry.command, entry.status, entry.exitCode])).toEqual([
      ['uptime', 'ok', 0],
      ['false', 'failed', 1],
      ['systemctl restart sooya', 'blocked', null]
    ]);
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as OpsCommandEntry);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ command: 'uptime', exitCode: 0, batchId: 'batch-9', messageId: 'msg-of-batch-9' });
    expect(typeof lines[0]!.durationMs).toBe('number');
    expect(JSON.stringify(lines)).not.toContain('up 3 days');
  });

  it('rotates the command log by size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-log-'));
    const file = path.join(dir, 'ops-commands.log');
    const log = new OpsCommandLog(file, 200);
    for (let i = 0; i < 10; i += 1) log.append({ at: 'now', command: `echo ${i}`, exitCode: 0, status: 'ok', durationMs: 1 });
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.statSync(file).size).toBeLessThan(400);
  });
});

describe('isSelfHarm', () => {
  it('catches restarting, stopping or killing her own processes', () => {
    for (const command of [
      'systemctl restart sooya',
      'sudo systemctl stop sooya.service',
      'systemctl kill srv-mcp-bridge',
      'cd /tmp && systemctl restart agent-knowledge',
      'service sooya restart',
      'pkill -f main.js',
      'killall node',
      'kill -9 $(pgrep -f sooya)',
      'kill $(systemctl show -p MainPID --value sooya)'
    ]) expect(isSelfHarm(command), command).toBe(true);
  });

  it('leaves ordinary ops commands alone', () => {
    for (const command of [
      'uptime',
      'systemctl status sooya',
      'journalctl -u sooya -n 50',
      'systemctl restart sooya-ota',
      'systemctl restart nginx',
      'cat /opt/sooya/shared/config/mcp.json',
      'docker restart luker',
      'kill -HUP 1234'
    ]) expect(isSelfHarm(command), command).toBe(false);
  });
});
