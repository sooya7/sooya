/*
 * QQ 配置读取（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §5.1 / §20）。
 * Secret 只存在于服务器环境变量：不进 git、不进数据库导出、不打印日志；
 * Admin 只能看到「已配置 / 未配置」，日志只能输出 App ID 安全摘要。
 */
export interface QqBotConfig {
  enabled: boolean;
  appId: string;
  /** OAuth 换 Access Token 用（出站 API，PR3），绝不输出。 */
  appSecret: string;
  /** 开放平台 Bot Secret：webhook Ed25519 签名校验用，绝不输出。 */
  callbackSecret: string;
  env: 'sandbox' | 'production';
  /** 允许绑定的 QQ 用户 openid 白名单；空 = 不接受任何新用户。 */
  allowedUsers: string[];
  proactiveEnabled: boolean;
}

export interface QqEnvSource {
  QQ_BOT_ENABLED?: string;
  QQ_APP_ID?: string;
  QQ_APP_SECRET?: string;
  QQ_CALLBACK_SECRET?: string;
  QQ_ENV?: string;
  QQ_ALLOWED_USERS?: string;
  QQ_PROACTIVE_ENABLED?: string;
}

export function qqBotConfigFromEnv(env: QqEnvSource): QqBotConfig {
  const allowedUsers = String(env.QQ_ALLOWED_USERS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    enabled: env.QQ_BOT_ENABLED === 'true' || env.QQ_BOT_ENABLED === '1',
    appId: String(env.QQ_APP_ID ?? '').trim(),
    appSecret: String(env.QQ_APP_SECRET ?? ''),
    callbackSecret: String(env.QQ_CALLBACK_SECRET ?? ''),
    env: env.QQ_ENV === 'sandbox' ? 'sandbox' : 'production',
    allowedUsers,
    proactiveEnabled: env.QQ_PROACTIVE_ENABLED !== 'false'
  };
}

/** 日志/Admin 安全摘要：不暴露完整 App ID。 */
export function qqAppIdSummary(appId: string): string {
  const value = appId.trim();
  if (!value) return '(unset)';
  return value.length <= 8 ? `${value.slice(0, 2)}…` : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export interface QqCredentialStatus {
  enabled: boolean;
  env: 'sandbox' | 'production';
  appIdSummary: string;
  credentialConfigured: boolean;
  allowedUserCount: number;
  proactiveEnabled: boolean;
}

/** Admin 可展示的状态；只含摘要，不含任何 Secret。 */
export function qqCredentialStatus(config: QqBotConfig): QqCredentialStatus {
  return {
    enabled: config.enabled,
    env: config.env,
    appIdSummary: qqAppIdSummary(config.appId),
    credentialConfigured: config.appId.length > 0 && config.appSecret.length > 0 && config.callbackSecret.length > 0,
    allowedUserCount: config.allowedUsers.length,
    proactiveEnabled: config.proactiveEnabled
  };
}