import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TEST_MP4, type Harness, type HarnessOptions } from './helpers/harness.js';
import { VIDEO_FAILED_TEXT } from '../src/core/video/follow-up.js';
import type { ChatMessage } from '../src/core/types.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const boot = (script: string, opts: HarnessOptions = {}) =>
  createHarness({ video: 'ok', chat: { script: [[script]] }, ...opts });

async function say(text: string, clientMsgId = `m-${Math.random().toString(36).slice(2, 8)}`) {
  const response = await h!.app.server.inject({
    method: 'POST',
    url: '/api/messages/sync',
    payload: { clientMsgId, content: [{ type: 'text', text }] }
  });
  expect(response.statusCode).toBe(200);
  const reply = (response.json() as { reply: ChatMessage }).reply;
  return h!.app.repos.messages.get(reply.id)!;
}

function followUps(): ChatMessage[] {
  return h!.app.repos.messages.recent(10).filter((message) => message.role === 'assistant' && message.meta?.videoFollowUp === true);
}

describe('[[video]] in a reply', () => {
  it('publishes the text now, queues the clip, and delivers it later as its own message', async () => {
    h = await boot('好，等我几分钟拍一段给你[[video:海边日落，海浪缓缓涌上沙滩]]');
    const reply = await say('给我拍段海边的视频');

    // The marker is private protocol; the user sees only the promise.
    const text = reply.content.find((part) => part.type === 'text');
    expect(text?.text).toBe('好，等我几分钟拍一段给你');
    expect(reply.content.some((part) => part.type === 'file')).toBe(false);
    const queued = reply.meta?.video as { taskId: string; status: string; selfie: boolean };
    expect(queued.status).toBe('queued');
    expect(queued.selfie).toBe(false);

    const task = h.app.services.video.get(queued.taskId)!;
    expect(task.mode).toBe('text');
    expect(task.origin).toEqual({ kind: 'reply', messageId: reply.id, deliver: true, intent: '海边日落，海浪缓缓涌上沙滩' });
    // The director expanded the intent; the vendor has not been called yet.
    expect(task.prompt).not.toBe('海边日落，海浪缓缓涌上沙滩');
    expect(h.state.videoRequests).toHaveLength(0);
    expect(followUps()).toHaveLength(0);

    await h.app.services.worker.drain();
    expect(h.state.videoRequests[0]).toMatchObject({ method: 'POST', body: { model: 'fake-video' } });
    await h.app.services.video.step(task.id);
    await h.app.services.video.step(task.id);
    expect(h.app.services.video.get(task.id)!.status).toBe('succeeded');

    const [follow] = followUps();
    expect(follow).toBeTruthy();
    expect(follow!.meta).toMatchObject({ videoTaskId: task.id, videoForMessageId: reply.id, outcome: 'succeeded' });
    const clip = follow!.content.find((part) => part.type === 'file')!;
    expect(clip.status).toBe('sent');
    const media = h.app.repos.media.get(clip.mediaId!)!;
    expect(media.mime).toBe('video/mp4');
    expect(media.bytes).toBe(TEST_MP4.byteLength);
    // QQ is disabled in the harness, so nothing is handed to the outbox.
    expect(h.app.repos.jobs.list(50).filter((job) => job.type === 'qq.deliver')).toHaveLength(0);
  });

  it('seeds a video-self clip with her reference image as the first frame', async () => {
    h = await boot('等一下哈[[video-self:我在窗边对你挥手，正面半身]]');
    const reply = await say('录一段你自己的视频');
    const queued = reply.meta?.video as { taskId: string; selfie: boolean };
    expect(queued.selfie).toBe(true);
    const task = h.app.services.video.get(queued.taskId)!;
    expect(task.mode).toBe('image');
    expect(task.sourceMedia).toMatchObject({ kind: 'image', mime: 'image/png' });
    await h.app.services.worker.drain();
    expect(h.state.videoRequests[0]!.form).toMatchObject({ model: 'fake-video', input_reference: expect.stringContaining('file:reference.png') });
  });

  it('honours the user asking for a clip even when the model forgot the marker', async () => {
    h = await boot('好呀，等我一下');
    const reply = await say('拍个视频给我看看窗外的雨');
    const queued = reply.meta?.video as { taskId: string; status: string } | undefined;
    expect(queued?.status).toBe('queued');
    expect(h.app.services.video.get(queued!.taskId)!.origin?.intent).toBe('给我看看窗外的雨');
  });

  it('tells the user when the clip fails instead of going silent', async () => {
    h = await boot('等我几分钟[[video:一只猫追激光点]]', { video: 'reject' });
    await say('拍段猫的视频');
    await h.app.services.worker.drain();
    const [follow] = followUps();
    expect(follow?.meta).toMatchObject({ outcome: 'failed' });
    expect(follow?.content[0]).toMatchObject({ type: 'text', text: VIDEO_FAILED_TEXT });
  });

  it('respects the rolling daily cap and the policy switch', async () => {
    h = await boot('等我几分钟[[video:海边]]');
    h.app.config.setPersona({ videoPolicy: { enabled: true, frequency: 'never', maxPerDay: 0 } });
    const capped = await say('拍段海边视频', 'cap-1');
    expect((capped.meta?.video as { status: string; reason: string })).toMatchObject({ status: 'skipped', reason: 'daily_cap' });
    expect(h.app.services.video.list().total).toBe(0);

    h.app.config.setPersona({ videoPolicy: { enabled: false, frequency: 'never', maxPerDay: 3 } });
    const disabled = await say('拍段海边视频', 'cap-2');
    expect(disabled.meta?.video).toBeUndefined();
    expect(h.app.services.video.list().total).toBe(0);
  });

  it('teaches the markers only when a video model is configured', async () => {
    h = await boot('好');
    await say('你好');
    // The dynamic instruction block (core/video/instructions.ts), not the persona's own prose.
    const taught = '生成并发送一段几秒钟的短视频';
    expect(JSON.stringify(h.state.chatCalls[0]!.body)).toContain(taught);
    expect(JSON.stringify(h.state.chatCalls[0]!.body)).toContain('[[video-self:画面意图]] 生成一段你自己出镜');
    await h.cleanup();

    h = await createHarness({ video: 'off', chat: { script: [['好']] } });
    await say('你好');
    expect(JSON.stringify(h.state.chatCalls[0]!.body)).not.toContain(taught);
    expect(JSON.stringify(h.state.chatCalls[0]!.body)).toContain('视频生成不可用');
  });
});
