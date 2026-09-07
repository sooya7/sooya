import type { CreatePartInput } from '../../db/repos/message.repo.js';
import type { MediaRow } from '../../db/repos/media.repo.js';
import type { ChatMessage } from '../types.js';
import type { PublicVideoTask, VideoFollowUp } from './service.js';

export interface VideoFollowUpDeps {
  /** ReplyCoordinator.publishProactiveMessage: one transaction, one assistant message, one durable event. */
  publish(input: { parts: CreatePartInput[]; meta: Record<string, unknown>; onPersisted(message: ChatMessage): void }): { message: ChatMessage } | null;
  enqueueDelivery(messageId: string): void;
  deliveryEnabled(): boolean;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

/** Wording she uses when a promised clip never materialises. Generic on purpose: the vendor reason is logged, not spoken. */
export const VIDEO_FAILED_TEXT = '刚才说要给你的那段视频没有做出来，等会儿我再试一次。';

/**
 * Turns a settled video task into chat. A reply that wrote `[[video:...]]`
 * already went out as text minutes ago; when the vendor finishes, the clip is
 * published as its own assistant message (a `file` part with a video MIME,
 * which QQ delivers as a video) and handed to the same durable outbox every
 * other message uses. Admin-created tasks have no chat origin and are ignored.
 */
export function createVideoFollowUp(deps: VideoFollowUpDeps): VideoFollowUp {
  const wantsChat = (task: PublicVideoTask) => task.origin?.kind === 'reply' && task.origin.deliver !== false;
  const publish = (task: PublicVideoTask, parts: CreatePartInput[], extra: Record<string, unknown>) => {
    const published = deps.publish({
      parts,
      meta: {
        videoFollowUp: true,
        videoTaskId: task.id,
        ...(task.origin?.messageId ? { videoForMessageId: task.origin.messageId } : {}),
        ...extra
      },
      onPersisted: () => undefined
    });
    if (!published) {
      deps.onLog?.('warn', 'video follow-up message could not be published', { taskId: task.id });
      return;
    }
    if (deps.deliveryEnabled()) deps.enqueueDelivery(published.message.id);
    deps.onLog?.('info', 'video follow-up published', { taskId: task.id, messageId: published.message.id, delivered: deps.deliveryEnabled() });
  };
  return {
    onSucceeded(task, media: MediaRow) {
      if (!wantsChat(task)) return;
      publish(task, [{
        type: 'file',
        mediaId: media.id,
        status: 'sent',
        meta: { video: true, videoTaskId: task.id, prompt: (task.origin?.intent ?? task.prompt).slice(0, 300) }
      }], { outcome: 'succeeded' });
    },
    onFailed(task, reason) {
      if (!wantsChat(task)) return;
      publish(task, [{ type: 'text', text: VIDEO_FAILED_TEXT, status: 'sent' }], { outcome: 'failed', reason: reason.slice(0, 300) });
    }
  };
}
