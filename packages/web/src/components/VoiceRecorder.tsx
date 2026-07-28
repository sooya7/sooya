import { useCallback, useEffect, useRef, useState } from 'react';
import { api, mediaUrl } from '../lib/api.js';
import type { MediaRef } from '../lib/types.js';

interface Props {
  onReady: (media: MediaRef) => void;
  onCancel: () => void;
  onNotice: (text: string) => void;
}

type Phase = 'idle' | 'recording' | 'preview' | 'uploading';

function pickMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return undefined;
}

export function VoiceRecorder({ onReady, onCancel, onNotice }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => () => cleanupStream(), [cleanupStream]);
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onNotice('当前浏览器不支持录音');
      onCancel();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const b = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        setBlob(b);
        setPreviewUrl(URL.createObjectURL(b));
        setPhase('preview');
        cleanupStream();
      };
      recorder.start(200);
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setSeconds(0);
      setPhase('recording');
      timerRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startedAtRef.current) / 1000;
        setSeconds(elapsed);
        if (elapsed >= 120) recorder.stop(); // hard cap
      }, 100);
    } catch (err) {
      onNotice(`无法开始录音：${(err as Error).message}`);
      onCancel();
    }
  }, [cleanupStream, onCancel, onNotice]);

  useEffect(() => {
    if (phase === 'idle') void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = () => {
    const r = recorderRef.current;
    if (r && r.state !== 'inactive') r.stop();
  };

  const discard = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setBlob(null);
    setPreviewUrl(null);
    setPhase('idle');
    void start();
  };

  const upload = async () => {
    if (!blob) return;
    setPhase('uploading');
    try {
      const duration = Math.round(seconds * 10) / 10;
      const res = await api.upload([{ file: blob, field: 'voice', name: 'voice.webm', duration }]);
      const media = res.media[0];
      if (!media) {
        onNotice(res.failed[0]?.error ?? '语音上传失败');
        setPhase('preview');
        return;
      }
      // Best-effort transcription; the clip is sent either way.
      try {
        const t = await api.transcribe(media.id);
        onReady({ ...media, transcript: t.transcript, duration: t.duration ?? media.duration });
        return;
      } catch {
        onReady(media);
        return;
      }
    } catch (err) {
      onNotice(`语音上传失败：${(err as Error).message}`);
      setPhase('preview');
    }
  };

  return (
    <div className="recorder" data-testid="recorder">
      {phase === 'recording' && (
        <>
          <span className="rec-dot" />
          <span className="rec-time">{seconds.toFixed(1)}s</span>
          <div className="rec-wave" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} style={{ animationDelay: `${i * 0.12}s` }} />
            ))}
          </div>
          <button type="button" className="rec-btn ghost" onClick={() => { stop(); onCancel(); }}>
            取消
          </button>
          <button type="button" className="rec-btn primary" onClick={stop} data-testid="rec-stop">
            停止
          </button>
        </>
      )}

      {phase === 'preview' && previewUrl && (
        <>
          <audio src={previewUrl} controls className="rec-preview" />
          <span className="rec-time">{seconds.toFixed(1)}s</span>
          <button type="button" className="rec-btn ghost" onClick={discard} data-testid="rec-redo">
            重录
          </button>
          <button type="button" className="rec-btn ghost" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="rec-btn primary" onClick={() => void upload()} data-testid="rec-send">
            发送
          </button>
        </>
      )}

      {phase === 'uploading' && <span className="rec-time">正在发送语音…</span>}
      {phase === 'idle' && <span className="rec-time">正在准备麦克风…</span>}
    </div>
  );
}

export { mediaUrl };
