// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmButton, CostButton, DateRange, DateTimePicker, Section } from './ui.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  return host;
}

function phone(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn()
  })) as unknown as typeof window.matchMedia;
}

const button = (text: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };
const pick = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe('Section', () => {
  it('is open on wide screens, with its explanation folded', async () => {
    phone(false);
    const el = await render(<Section title="备份" desc="怎么备份">内容</Section>);
    expect(el.querySelector<HTMLElement>('.cs-section-body')!.hidden).toBe(false);
    expect(el.querySelector<HTMLElement>('.cs-section-desc')!.hidden).toBe(true);
    await click(el.querySelector('.cs-info')!);
    expect(el.querySelector<HTMLElement>('.cs-section-desc')!.hidden).toBe(false);
  });

  it('folds to one row on phones and keeps its content mounted', async () => {
    phone(true);
    const el = await render(<Section title="备份"><input defaultValue="草稿" /></Section>);
    const toggle = el.querySelector<HTMLButtonElement>('.cs-section-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector<HTMLElement>('.cs-section-body')!.hidden).toBe(true);
    expect(el.querySelector('input')!.value).toBe('草稿');
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector<HTMLElement>('.cs-section-body')!.hidden).toBe(false);
  });

  it('can start open on phones', async () => {
    phone(true);
    const el = await render(<Section title="身体和情绪" defaultOpen>内容</Section>);
    expect(el.querySelector<HTMLElement>('.cs-section-body')!.hidden).toBe(false);
  });
});

describe('DateTimePicker', () => {
  function Harness({ initial = '', onValue }: { initial?: string; onValue: (v: string) => void }) {
    const [value, setValue] = useState(initial);
    return <DateTimePicker label="开始" value={value} offsetMinutes={480} onChange={(v) => { setValue(v); onValue(v); }} />;
  }

  it('picks a day, fills a sensible time, and clears back to none', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T06:07:00Z')); // 14:07 in her zone (UTC+8)
    const seen: string[] = [];
    const el = await render(<Harness onValue={(v) => seen.push(v)} />);
    const [day, time] = el.querySelectorAll('select');
    expect(time!.disabled).toBe(true);
    expect(day!.options[1]!.textContent).toContain('今天');
    await pick(day!, '2026-09-26');
    expect(seen.at(-1)).toBe('2026-09-26T14:15');
    await pick(day!, '2026-09-27');
    expect(seen.at(-1)).toBe('2026-09-27T14:15');
    await pick(time!, '20:30');
    expect(seen.at(-1)).toBe('2026-09-27T20:30');
    await pick(day!, '');
    expect(seen.at(-1)).toBe('');
  });

  it('keeps an existing value that is outside the lists', async () => {
    const el = await render(<Harness initial="2025-01-02T07:07" onValue={() => {}} />);
    const [day, time] = el.querySelectorAll('select');
    expect(day!.value).toBe('2025-01-02');
    expect(time!.value).toBe('07:07');
  });
});

describe('DateRange', () => {
  it('applies presets in one tap and reveals exact dates only on 自定义', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T06:00:00Z'));
    const calls: Array<[string, string]> = [];
    function Harness() {
      const [range, setRange] = useState<[string, string]>(['', '']);
      return <DateRange from={range[0]} to={range[1]} onChange={(f, t) => { setRange([f, t]); calls.push([f, t]); }} />;
    }
    const el = await render(<Harness />);
    expect(button('全部').getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('input[type="date"]')).toBeNull();
    await click(button('最近 7 天'));
    const [from, to] = calls.at(-1)!;
    expect(to).toMatch(/^2026-09-2[56]$/);
    expect(Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)).toBe(6);
    expect(button('最近 7 天').getAttribute('aria-pressed')).toBe('true');
    await click(button('自定义'));
    expect(el.querySelectorAll('input[type="date"]').length).toBe(2);
  });
});

describe('two-step buttons', () => {
  it('asks before a destructive action', async () => {
    const onConfirm = vi.fn();
    await render(<ConfirmButton label="删除" question="确定删除？" onConfirm={onConfirm} />);
    await click(button('删除'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(host!.textContent).toContain('确定删除？');
    await click(button('删除'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('asks before spending quota, and can back out', async () => {
    const onConfirm = vi.fn();
    await render(<CostButton label="试听" question="会消耗一次额度" confirmLabel="确认试听" onConfirm={onConfirm} />);
    await click(button('试听'));
    await click(button('取消'));
    expect(onConfirm).not.toHaveBeenCalled();
    await click(button('试听'));
    await click(button('确认试听'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
