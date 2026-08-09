// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeSettings } from '../../lib/features.js';
import { LifeContactBoundaryForm } from './LifeContactBoundaryForm.js';

const api = vi.hoisted(() => ({ updateLifeSettings: vi.fn() }));
vi.mock('../../lib/features.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/features.js')>();
  return {
    ...original,
    featureApi: {
      ...original.featureApi,
      updateLifeSettings: api.updateLifeSettings
    }
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setNumberValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const initial: LifeSettings = {
  reachOut: true,
  quietGapMinutes: 180,
  maxReachOutsPerDay: 3,
  silentFrom: 0,
  silentTo: 9,
  tzOffsetMinutes: 480,
  proactiveMode: 'auto'
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderForm() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const render = async (value: LifeSettings) => {
    await act(async () => {
      root!.render(<LifeContactBoundaryForm initial={value} onNotice={vi.fn()} />);
    });
  };
  await render(initial);
  await act(async () => {
    container!.querySelector<HTMLButtonElement>('.life-disclosure-toggle')!.click();
  });
  return { rerender: async (patch: Partial<LifeSettings>) => render({ ...initial, ...patch }) };
}

beforeEach(() => {
  api.updateLifeSettings.mockImplementation(async (patch: Partial<LifeSettings>) => ({
    settings: { ...initial, ...patch }
  }));
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

describe('LifeContactBoundaryForm', () => {
  it('submits only contact-boundary fields', async () => {
    await renderForm();
    const gap = container!.querySelector<HTMLInputElement>('input[name="quietGapMinutes"]')!;
    await act(async () => { setNumberValue(gap, '240'); });
    await act(async () => {
      container!.querySelector<HTMLFormElement>('form')!.requestSubmit();
      await Promise.resolve();
    });
    expect(api.updateLifeSettings).toHaveBeenCalledWith({
      reachOut: true,
      quietGapMinutes: 240,
      maxReachOutsPerDay: 3,
      silentFrom: 0,
      silentTo: 9,
      proactiveMode: 'auto'
    });
  });

  it('does not overwrite an unsaved draft when refreshed settings arrive', async () => {
    const { rerender } = await renderForm();
    const gap = container!.querySelector<HTMLInputElement>('input[name="quietGapMinutes"]')!;
    await act(async () => { setNumberValue(gap, '240'); });
    await rerender({ quietGapMinutes: 90 });
    expect(container!.querySelector<HTMLInputElement>('input[name="quietGapMinutes"]')!.value).toBe('240');
  });
});
