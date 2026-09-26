import { proactiveReasonText } from '../lib/lifeView.js';

/** Reasons the capability policy gives for her not reaching out, in plain words. */
const POLICY_REASONS: Record<string, string> = {
  'qq bot is disabled': 'QQ 通道没有开启',
  'qq bot is not configured': 'QQ 机器人凭据不完整',
  'no proactive candidate engine is enabled': '生活话题和约定提醒都没有开启',
  'qq proactive delivery is disabled': 'QQ 主动消息被关掉了（QQ_PROACTIVE_ENABLED）'
};

export function policyReasonText(reason: string): string {
  return POLICY_REASONS[reason] ?? proactiveReasonText(reason) ?? reason;
}