/**
 * Wires the ops side of her tools into the app: the guard around the `srv`
 * MCP server and the audit trail of http_request / run_command. Kept out of
 * app.ts on purpose.
 */
import path from 'node:path';
import type { Logger } from 'pino';
import type { ToolDescriptor, ToolExecutionContext } from '../../agent/registry.js';
import type { MessageRepo } from '../../db/repos/message.repo.js';
import type { ReplyBatchRepo } from '../../db/repos/reply-batch.repo.js';
import type { FlowTraceService } from '../flow-trace.js';
import type { HttpRequestAudit } from '../links/http-request.js';
import { OpsCommandLog, SRV_SERVER_ID, decorateSrvTools } from './srv-tools.js';

export interface OpsWiringInput {
  logDir: string;
  repos: { replyBatches: ReplyBatchRepo; messages: MessageRepo };
  flowTrace: FlowTraceService;
  logger: Logger;
}

export interface OpsWiring {
  decorateMcpTools: (serverId: string, tools: ToolDescriptor[]) => ToolDescriptor[];
  onHttpRequest: (event: HttpRequestAudit, context?: ToolExecutionContext) => void;
}

export function setupOps(input: OpsWiringInput): OpsWiring {
  const origin = (context?: ToolExecutionContext): { messageId?: string; flowTraceId?: string } => {
    if (!context?.batchId) return {};
    try {
      const messageId = input.repos.replyBatches.messageIds(context.batchId).at(-1);
      if (!messageId) return {};
      const traceId = input.repos.messages.get(messageId)?.meta?.flowTraceId;
      return { messageId, ...(typeof traceId === 'string' && traceId ? { flowTraceId: traceId } : {}) };
    } catch {
      return {};
    }
  };
  const commandLog = new OpsCommandLog(path.join(input.logDir, 'ops-commands.log'));
  return {
    decorateMcpTools: (serverId, tools) => serverId !== SRV_SERVER_ID ? tools : decorateSrvTools(tools, {
      commandLog,
      origin,
      onCommand: (entry, flowTraceId) => {
        input.logger.info({ status: entry.status, exitCode: entry.exitCode, durationMs: entry.durationMs, messageId: entry.messageId }, 'ops.run_command');
        input.flowTrace.stage(flowTraceId, 'tool.run_command', entry.status === 'ok' ? 'ok' : 'failed', {
          status: entry.status,
          exitCode: entry.exitCode,
          durationMs: entry.durationMs
        });
      }
    }),
    onHttpRequest: (event, context) => {
      const detail = {
        method: event.method,
        host: event.host,
        status: event.status,
        durationMs: event.durationMs,
        viaProxy: event.viaProxy,
        ...(event.secret ? { vaultName: event.secret } : {})
      };
      input.logger.info({ ...detail, ...(event.error ? { error: event.error } : {}) }, 'tool.http_request');
      input.flowTrace.stage(origin(context).flowTraceId, 'tool.http_request', event.status === null ? 'failed' : 'ok', detail);
    }
  };
}
