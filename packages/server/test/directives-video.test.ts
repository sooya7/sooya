import { describe, expect, it } from 'vitest';
import { parseUserDirectives, StreamingDirectiveFilter, stripModelDirectives } from '../src/core/directives.js';

describe('video model directives', () => {
  it('parses [[video:...]] into videoPrompt and strips it from the visible text', () => {
    const r = stripModelDirectives('好，等我几分钟拍一段给你[[video:海边日落，海浪缓缓涌上沙滩]]');
    expect(r.directives.videoPrompt).toBe('海边日落，海浪缓缓涌上沙滩');
    expect(r.directives.selfVideoPrompt).toBeUndefined();
    expect(r.directives.imagePrompt).toBeUndefined();
    expect(r.text).toBe('好，等我几分钟拍一段给你');
  });

  it('keeps video-self separate from video and from image-self', () => {
    const r = stripModelDirectives('[[video-self:我在窗边对你挥手]]');
    expect(r.directives.selfVideoPrompt).toBe('我在窗边对你挥手');
    expect(r.directives.videoPrompt).toBeUndefined();
    expect(r.directives.selfImagePrompt).toBeUndefined();
    expect(r.text).toBe('');
  });

  it('accepts the Chinese alias and single brackets', () => {
    expect(stripModelDirectives('稍等[视频:猫在追激光点]').directives.videoPrompt).toBe('猫在追激光点');
    expect(stripModelDirectives('稍等[[视频:猫在追激光点]]').text).toBe('稍等');
  });

  it('never streams a half-written video marker to the user', () => {
    const filter = new StreamingDirectiveFilter();
    expect(filter.push('等我一下[[video-self:' + '我'.repeat(120))).toBe('等我一下');
    expect(filter.flush()).toBe('');
  });
});

describe('video user directives', () => {
  it('recognises a request for a clip and extracts the subject', () => {
    const d = parseUserDirectives('拍个视频给我看看海边');
    expect(d.wantVideo).toBe(true);
    expect(d.videoPrompt).toBe('给我看看海边');
    // 「拍个」也命中拍照模式，但这句里没有任何图片词，所以不该同时要一张图。
    expect(d.wantImage).toBeUndefined();
    expect(d.imagePrompt).toBeUndefined();
  });

  it('flags a clip of her as a self video', () => {
    const d = parseUserDirectives('录一段你自己的视频给我');
    expect(d.wantVideo).toBe(true);
    expect(d.selfVideoIntent).toBe(true);
  });

  it('keeps an explicit photo request alongside a video request', () => {
    const d = parseUserDirectives('发张照片，再来一段视频');
    expect(d.wantImage).toBe(true);
    expect(d.wantVideo).toBe(true);
  });

  it('treats capability questions and casual mentions as no request', () => {
    expect(parseUserDirectives('你会做视频吗').wantVideo).toBeUndefined();
    expect(parseUserDirectives('昨天看了个视频，特别好笑').wantVideo).toBeUndefined();
  });
});
