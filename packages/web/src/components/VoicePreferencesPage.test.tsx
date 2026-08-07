// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VoicePreferencesPage from './VoicePreferencesPage.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const PREFS = {
  preferences: {
    enabled: true,
    autoVoiceFrequency: 'rare',
    preferredModes: ['replace', 'complement'],
    maxVoiceSeconds: 35,
    autoplay: false,
    showTranscript: 'collapsed',
    quietHours: { from: 22, to: 8 }
  }
};

const CAPS = {
  configured: true,
  provider: 'edge-tts-prod-instance-name-that-is-very-long-and-must-wrap-not-stretch-the-layout',
  supportsInstructions: true,
  supportsSpeed: true,
  supportsAbort: true,
  emotionEnum: ['happy', 'neutral'],
  voices: ['zh-CN-XiaoxiaoNeural']
};

function routeFetch(handler: (url: string, method: string | undefined) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => handler(String(input), init.method)));
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => { created.render(<VoicePreferencesPage />); });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) { const current = root; await act(async () => { current.unmount(); }); root = null; }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('VoicePreferencesPage', () => {
  it('renders preferences with quiet hours and capability summary that wraps', async () => {
    routeFetch((url) => {
      if (url === '/api/settings/voice') return json(PREFS);
      if (url === '/api/settings/voice/capabilities') return json(CAPS);
      return json({ message: 'no' }, 404);
    });
    await render();
    expect(container!.querySelector('[data-testid="voice-preferences-page"]')).not.toBeNull();
    const quiet = container!.querySelector('[data-testid="voice-quiet-hours"]')!;
    expect(quiet.querySelectorAll('input').length).toBe(2);
    expect(quiet.querySelector('input[aria-label="安静时段开始（小时）"]')?.getAttribute('value')).toBe('22');
    // Long provider name renders inside a wrapping muted span, not a fixed-width row.
    const provider = container!.querySelector('.pref-row .muted')!;
    expect(provider.textContent).toContain('edge-tts-prod-instance-name-that-is-very-long-and-must-wrap-not-stretch-the-layout');
    expect(provider.classList.contains('muted')).toBe(true);
  });

  it('shows provider-unconfigured state and disables preview when the provider is missing', async () => {
    routeFetch((url) => {
      if (url === '/api/settings/voice') return json(PREFS);
      if (url === '/api/settings/voice/capabilities') return json({ ...CAPS, configured: false, provider: null });
      return json({ message: 'no' }, 404);
    });
    await render();
    expect(container!.querySelector('.admin-state-provider-unconfigured')).not.toBeNull();
    const previewButton = [...container!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '试听')!;
    expect(previewButton.disabled).toBe(true);
  });

  it('shows a retryable load error when the settings endpoint fails', async () => {
    routeFetch(() => json({ message: 'server error' }, 500));
    await render();
    expect(container!.querySelector('.admin-state-error')?.textContent).toContain('加载语音偏好失败');
  });
});
