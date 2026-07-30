import { requestPushApi } from './pushApi.js';

export interface RemovablePushSubscription {
  readonly endpoint: string;
  unsubscribe(): Promise<boolean>;
}

export interface DisablePushResult {
  /** 浏览器侧订阅已取消（或本来就不存在） */
  browserRemoved: boolean;
  /** 服务端记录已删除（或本来就不存在） */
  serverRemoved: boolean;
  /** 只有一侧成功时给用户的提示 */
  warning?: string;
}

/**
 * 关闭后台通知。
 *
 * 顺序很重要：先取消浏览器订阅，因为这一步才真正决定用户是否还会收到系统通知；
 * 之后再尽力通知服务端删除记录。服务端那一步失败不能阻塞关闭 —— 否则 token 过期、
 * 离线或服务端 5xx 时开关会永久卡在「已开启」。残留的 endpoint 会在下一次推送收到
 * 404/410 时被 PushService 自动清理。
 */
export async function disablePushSubscription(
  subscription: RemovablePushSubscription,
  request: typeof requestPushApi = requestPushApi
): Promise<DisablePushResult> {
  let browserError: Error | null = null;
  try {
    // 返回 false 只表示本来就没有订阅，对「已关闭」这个结果没有影响。
    await subscription.unsubscribe();
  } catch (error) {
    browserError = error as Error;
  }

  let serverRemoved = false;
  let serverError: Error | null = null;
  try {
    const body = await request<{ unsubscribed?: boolean }>('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: subscription.endpoint })
    });
    serverRemoved = body?.unsubscribed !== false;
  } catch (error) {
    serverError = error as Error;
  }

  if (browserError && serverError) {
    throw new Error(`关闭通知失败：${browserError.message}；${serverError.message}`);
  }

  const warning = browserError
    ? '服务端已停止推送，但浏览器订阅未能取消。'
    : serverError
      ? '已在本机关闭，服务端记录将在下次推送时自动清理。'
      : undefined;

  return { browserRemoved: !browserError, serverRemoved, warning };
}
