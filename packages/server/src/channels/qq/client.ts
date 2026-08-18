/*
 * QQ 官方 OpenAPI 纯协议客户端（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §10）。
 * 只做协议：token 获取/刷新、统一 HTTP、超时、限流识别、错误归一、发文本消息。
 * 禁止把 SOOYA DB / Life / Memory / ReplyCoordinator 塞进来。
 *
 * 官方契约（bot.q.qq.com api-call-guide，2026-08 核对）：
 * - 统一请求地址 https://api.bot.qq.com
 * - 鉴权头 Authorization: QQBot {access_token}
 * - 凭证：POST /app/getAppAccessToken，body {appId, clientSecret} → {access_token, expires_in}
 * - 发单聊消息：POST /v2/users/{openid}/messages，{msg_type:0, content, msg_id?, msg_seq?}
 * - 失败响应：{err_code, message, trace_id}
 */
import type { QqBotConfig } from './config.js';

export const QQ_OPENAPI_BASE_URL = 'https://api.bot.qq.com';
export const QQ_TOKEN_URL = '/app/getAppAccessToken';

export type QqApiErrorKind = 'network' | 'timeout' | 'http' | 'api';

export class QqApiError extends Error {
  override name = 'QqApiError';
  constructor(
    readonly kind: QqApiErrorKind,
    readonly httpStatus: number | null,
    readonly errCode: number | null,
    readonly retryable: boolean,
    message: string,
    readonly traceId?: string
  ) {
    super(message);
  }
}

/** 官方公共错误码里「系统级、重试一次能好」的一类（api-call-guide 错误码表）。 */
const RETRYABLE_ERR_CODES = new Set([11242, 11252, 11263]);

export function classifyQqSendError(
  kind: QqApiErrorKind,
  httpStatus: number | null,
  errCode: number | null
): boolean {
  if (kind === 'network' || kind === 'timeout') return true;
  if (httpStatus === 429 || (httpStatus !== null && httpStatus >= 500)) return true;
  if (httpStatus === 401) return true; // token 失效：客户端刷新后重试一次
  if (errCode !== null && RETRYABLE_ERR_CODES.has(errCode)) return true;
  return false;
}

export interface QqApiClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** 可注入 fetch 供测试；生产默认走全局 fetch（外部官方域名，不需走代理）。 */
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class QqApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;
  private token: CachedToken | null = null;

  constructor(private readonly config: QqBotConfig, options: QqApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? QQ_OPENAPI_BASE_URL).replace(/\/$/u, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch: typeof fetch }).fetch);
    this.clock = options.clock ?? (() => new Date());
  }

  /** 获取（缓存）access_token；过期前 300s 提前刷新。 */
  async getAccessToken(): Promise<string> {
    const now = this.clock().getTime();
    if (this.token && this.token.expiresAt > now) return this.token.value;
    const token = await this.fetchToken();
    this.token = token;
    return token.value;
  }

  private async fetchToken(): Promise<CachedToken> {
    const response = await this.post(this.baseUrl + QQ_TOKEN_URL, { appId: this.config.appId, clientSecret: this.config.appSecret }, {});
    const accessToken = response.json.access_token;
    const expiresIn = Number(response.json.expires_in ?? 0);
    if (typeof accessToken !== 'string' || accessToken.length === 0 || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new QqApiError(response.kind, response.httpStatus, asErrCode(response.json.err_code), false, 'qq token fetch failed', asTraceId(response.json));
    }
    // 客户端只持有内存凭证；永不落库/打日志。
    return { value: accessToken, expiresAt: this.clock().getTime() + (expiresIn - 300) * 1000 };
  }

  /**
   * 发单聊文字消息（C2C）。
   * - msgId：被动回复用，来自 C2C_MESSAGE_CREATE 事件的 d.id（60 分钟内有效）
   * - msgSeq：协同 msg_id 防重复回复；相同 msg_id+msg_seq 重复发送会失败
   */
  async sendC2cTextMessage(input: {
    openid: string;
    content: string;
    msgId?: string | null;
    msgSeq?: number;
  }): Promise<{ messageId: string }> {
    const response = await this.post(
      `${this.baseUrl}/v2/users/${encodeURIComponent(input.openid)}/messages`,
      {
        msg_type: 0,
        content: input.content,
        ...(input.msgId ? { msg_id: input.msgId, msg_seq: input.msgSeq ?? 1 } : {})
      },
      { authorization: `QQBot ${await this.getAccessToken()}` }
    );
    if (response.httpStatus === 200 && (response.json.err_code === undefined || response.json.err_code === 0)) {
      const messageId = typeof response.json.id === 'string' ? response.json.id : '';
      return { messageId };
    }
    const errCode = asErrCode(response.json.err_code);
    const retryable = classifyQqSendError(response.kind, response.httpStatus, errCode);
    throw new QqApiError(
      response.kind,
      response.httpStatus,
      errCode,
      retryable,
      typeof response.json.message === 'string' ? response.json.message : 'qq send failed',
      asTraceId(response.json)
    );
  }

  /** 主动刷新（token 撤销/401 后调用）。 */
  clearTokenCache(): void {
    this.token = null;
  }

  /**
   * 上传富媒体文件（rich-media.html）：file_data 传 base64 二进制。
   * 返回 file_uuid/file_info，用于 msg_type=7 富媒体消息发送。
   */
  async uploadMedia(input: {
    openid: string;
    fileType: 1 | 2 | 3 | 4;
    bytes: Buffer;
    filename?: string;
  }): Promise<{ fileUuid: string; fileInfo: string; ttl: number }> {
    const response = await this.post(
      `${this.baseUrl}/v2/users/${encodeURIComponent(input.openid)}/files`,
      {
        file_type: input.fileType,
        // 上传和发送是两步：这里不能让 QQ 在上传阶段自动发消息，否则后续 msg_type=7 会重复发送。
        srv_send_msg: false,
        file_data: input.bytes.toString('base64'),
        ...(input.filename ? { filename: input.filename } : {})
      },
      { authorization: `QQBot ${await this.getAccessToken()}` }
    );
    const fileUuid = typeof response.json.file_uuid === 'string' ? response.json.file_uuid : '';
    const fileInfo = typeof response.json.file_info === 'string' ? response.json.file_info : '';
    if (!fileUuid || !fileInfo) {
      throw new QqApiError(
        response.kind,
        response.httpStatus,
        asErrCode(response.json.err_code),
        classifyQqSendError(response.kind, response.httpStatus, asErrCode(response.json.err_code)),
        'qq media upload failed',
        asTraceId(response.json)
      );
    }
    return { fileUuid, fileInfo, ttl: Number(response.json.ttl ?? 0) };
  }

  /** 发富媒体消息（msg_type=7）。 */
  async sendC2cMediaMessage(input: {
    openid: string;
    fileUuid: string;
    fileInfo: string;
    msgId?: string | null;
    msgSeq?: number;
  }): Promise<{ messageId: string }> {
    const response = await this.post(
      `${this.baseUrl}/v2/users/${encodeURIComponent(input.openid)}/messages`,
      {
        msg_type: 7,
        media: { file_uuid: input.fileUuid, file_info: input.fileInfo },
        ...(input.msgId ? { msg_id: input.msgId, msg_seq: input.msgSeq ?? 1 } : {})
      },
      { authorization: `QQBot ${await this.getAccessToken()}` }
    );
    if (response.httpStatus === 200 && (response.json.err_code === undefined || response.json.err_code === 0)) {
      return { messageId: typeof response.json.id === 'string' ? response.json.id : '' };
    }
    const errCode = asErrCode(response.json.err_code);
    throw new QqApiError(
      response.kind,
      response.httpStatus,
      errCode,
      classifyQqSendError(response.kind, response.httpStatus, errCode),
      typeof response.json.message === 'string' ? response.json.message : 'qq media send failed',
      asTraceId(response.json)
    );
  }

  private async post(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    attempt = 0
  ): Promise<{ kind: QqApiErrorKind; httpStatus: number | null; json: Record<string, unknown> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new QqApiError(aborted ? 'timeout' : 'network', null, null, true, aborted ? 'qq api timeout' : 'qq api network error');
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    // token 失效（401）时刷新一次并重试；仍失败则以最终状态为准。
    if (response.status === 401 && attempt === 0) {
      this.clearTokenCache();
      const freshToken = await this.getAccessToken();
      return this.post(url, body, { ...headers, authorization: `QQBot ${freshToken}` }, attempt + 1);
    }
    return { kind: 'http', httpStatus: response.status, json };
  }
}

function asErrCode(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function asTraceId(json: Record<string, unknown>): string | undefined {
  return typeof json.trace_id === 'string' ? json.trace_id : undefined;
}