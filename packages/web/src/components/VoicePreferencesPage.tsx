import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api.js';
import { useAutoNotice } from '../lib/autoNotice.js';
import { AppLink } from './AppLink.js';
import type { UserVoicePreferences, VoiceMode } from '../lib/voicePreferences.js';

export interface VoiceCapabilities {
  configured: boolean;
  provider: string | null;
  supportsInstructions: boolean;
  supportsSpeed: boolean;
  supportsAbort: boolean;
  emotionEnum: string[];
  voices: string[];
}

const MODE_LABELS: Record<VoiceMode, string> = {
  replace: '语音回答（替换文字）',
  complement: '语音补充',
  summary: '语音摘要',
  read_aloud: '朗读原文'
};

const FREQ_LABELS: Record<string, string> = {
  never: '从不',
  rare: '偶尔',
  sometimes: '有时'
};

/**
 * Voice Preferences (next phase P1): a full settings surface — basics, auto
 * voice frequency, quiet hours, emotion presets and capability-gated preview.
 */
export default function VoicePreferencesPage() {
  const [, setNotice] = useAutoNotice();
  const [prefs, setPrefs] = useState<UserVoicePreferences | null>(null);
  const [caps, setCaps] = useState<VoiceCapabilities | null>(null);
  const [previewText, setPreviewText] = useState('用语音打个招呼吧');
  const [previewEmotion, setPreviewEmotion] = useState('happy');
  const [previewAudio, setPreviewAudio] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [prefsRes, capsRes] = await Promise.all([
          fetch('/api/settings/voice', { headers: authHeaders() }),
          fetch('/api/settings/voice/capabilities', { headers: authHeaders() })
        ]);
        if (!alive) return;
        if (prefsRes.ok) setPrefs((await prefsRes.json()).preferences as UserVoicePreferences);
        if (capsRes.ok) setCaps((await capsRes.json()) as VoiceCapabilities);
      } catch { /* the page stays usable with defaults */ }
    })();
    return () => { alive = false; };
  }, []);

  if (!prefs) return <p>加载中…</p>;

  const save = async (patch: Partial<UserVoicePreferences>) => {
    try {
      const res = await fetch('/api/settings/voice', {
        method: 'PATCH',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (!res.ok) throw new ApiError(await res.text(), res.status);
      const body = (await res.json()) as { preferences: UserVoicePreferences };
      setPrefs(body.preferences);
      setNotice('语音偏好已保存');
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
  };

  const preview = async () => {
    if (previewBusy) return;
    setPreviewBusy(true);
    try {
      const res = await fetch('/api/settings/voice/preview', {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ text: previewText, emotion: previewEmotion })
      });
      if (res.status === 429) {
        setNotice('试听太频繁了，稍后再试');
        return;
      }
      if (!res.ok) throw new ApiError(await res.text(), res.status);
      const body = (await res.json()) as { audioBase64: string; mime: string; durationSec: number | null };
      setPreviewAudio(`data:${body.mime};base64,${body.audioBase64}`);
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
    finally { setPreviewBusy(false); }
  };

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header-row">
          <h1>语音偏好</h1>
          <AppLink className="admin-back" href="/" aria-label="返回聊天">‹ 返回聊天</AppLink>
        </div>
      </header>
      <div className="voice-prefs">
        <label className="pref-row">
          <span>启用语音</span>
          <input type="checkbox" checked={prefs.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
        </label>
        <label className="pref-row">
          <span>自动语音频率</span>
          <select value={prefs.autoVoiceFrequency} onChange={(e) => void save({ autoVoiceFrequency: e.target.value as UserVoicePreferences['autoVoiceFrequency'] })}>
            {Object.entries(FREQ_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="pref-row">
          <span>最长语音时长（秒）</span>
          <input
            type="number" min={5} max={120} value={prefs.maxVoiceSeconds}
            onChange={(e) => void save({ maxVoiceSeconds: Number(e.target.value) })}
          />
        </label>
        <div className="pref-row">
          <span>允许的语音模式</span>
          <div className="mode-checkboxes">
            {(['replace', 'complement', 'summary', 'read_aloud'] as VoiceMode[]).map((mode) => (
              <label key={mode}>
                <input
                  type="checkbox"
                  checked={prefs.preferredModes.includes(mode)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...prefs.preferredModes, mode]
                      : prefs.preferredModes.filter((m) => m !== mode);
                    void save({ preferredModes: next });
                  }}
                />
                {MODE_LABELS[mode]}
              </label>
            ))}
          </div>
        </div>
        <div className="pref-row">
          <span>安静时段（自动语音静默）</span>
          <span className="quiet-hours">
            <input
              type="number" min={0} max={23} value={prefs.quietHours?.from ?? 0}
              onChange={(e) => void save({ quietHours: { from: Number(e.target.value), to: prefs.quietHours?.to ?? 8 } })}
            />
            – 
            <input
              type="number" min={0} max={23} value={prefs.quietHours?.to ?? 8}
              onChange={(e) => void save({ quietHours: { from: prefs.quietHours?.from ?? 0, to: Number(e.target.value) } })}
            />
            点
          </span>
        </div>
        <div className="pref-row">
          <span>Transcript 显示</span>
          <select value={prefs.showTranscript} onChange={(e) => void save({ showTranscript: e.target.value as UserVoicePreferences['showTranscript'] })}>
            <option value="always">始终</option>
            <option value="collapsed">折叠</option>
            <option value="hidden">隐藏</option>
          </select>
        </div>
        <div className="pref-row">
          <span>自动播放</span>
          <input type="checkbox" checked={prefs.autoplay} onChange={(e) => void save({ autoplay: e.target.checked })} />
        </div>

        {caps && (
          <div className="pref-row">
            <span>Provider 能力</span>
            <span className="muted">
              {caps.configured ? `${caps.provider ?? 'tts'}（速度/指令/取消：${caps.supportsSpeed ? '✓' : '✗'} / ${caps.supportsInstructions ? '✓' : '✗'} / ${caps.supportsAbort ? '✓' : '✗'}）` : '未配置'}
            </span>
          </div>
        )}

        <div className="preview-block">
          <h3>试听</h3>
          <textarea value={previewText} onChange={(e) => setPreviewText(e.target.value)} maxLength={200} rows={2} />
          <div className="preview-actions">
            <select value={previewEmotion} onChange={(e) => setPreviewEmotion(e.target.value)}>
              {(caps?.emotionEnum ?? ['happy', 'neutral', 'gentle', 'sad', 'angry', 'sleepy']).map((emotion) => <option key={emotion} value={emotion}>{emotion}</option>)}
            </select>
            <button type="button" onClick={() => void preview()} disabled={previewBusy || !caps?.configured}>
              {previewBusy ? '合成中…' : '试听'}
            </button>
          </div>
          {previewAudio && <audio controls src={previewAudio} className="preview-audio" />}
        </div>
      </div>
    </div>
  );
}

function authHeaders(): Record<string, string> {
  const token = ((): string | null => {
    try { return localStorage.getItem('sooya.token'); } catch { return null; }
  })();
  return token ? { authorization: `Bearer ${token}` } : {};
}
