import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = fs.readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

function marked(name: 'light' | 'dark'): string {
  const start = `/* theme:${name}:start */`;
  const end = `/* theme:${name}:end */`;
  const from = CSS.indexOf(start);
  const to = CSS.indexOf(end);
  if (from < 0 || to <= from) throw new Error(`missing ${name} theme markers`);
  return CSS.slice(from + start.length, to);
}

function hexTokens(source: string): Record<string, string> {
  return Object.fromEntries(
    [...source.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\b/gi)]
      .map((match) => [match[1]!, match[2]!.toLowerCase()])
  );
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

const required = [
  '--bg', '--panel', '--panel-alt', '--surface-raised', '--surface-hover',
  '--ink', '--ink-soft', '--ink-meta', '--line', '--accent', '--accent-deep',
  '--mine-start', '--mine-end', '--mine-ink', '--theirs', '--theirs-border',
  '--danger-ink', '--shimmer-base', '--shimmer-highlight'
];

describe('warm system theme', () => {
  it.each(['light', 'dark'] as const)('%s palette defines every semantic token', (mode) => {
    const source = marked(mode);
    const tokens = hexTokens(source);
    for (const name of required) expect(tokens[name], `${mode} ${name}`).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(['light', 'dark'] as const)('%s normal text and outgoing bubbles meet WCAG AA', (mode) => {
    const tokens = hexTokens(marked(mode));
    for (const [foreground, background] of [
      ['--ink', '--bg'],
      ['--ink-soft', '--bg'],
      ['--ink-meta', '--panel'],
      ['--accent-deep', '--panel'],
      ['--danger-ink', '--panel'],
      ['--ink', '--theirs'],
      ['--mine-ink', '--mine-start'],
      ['--mine-ink', '--mine-end']
    ] as const) {
      expect(contrast(tokens[foreground]!, tokens[background]!), `${mode} ${foreground} on ${background}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(['light', 'dark'] as const)('%s focus accent has a 3:1 non-text contrast', (mode) => {
    const tokens = hexTokens(marked(mode));
    expect(contrast(tokens['--accent']!, tokens['--panel']!)).toBeGreaterThanOrEqual(3);
  });

  it('uses the system scheme, keeps the desktop width and never animates every mounted row', () => {
    expect(marked('light')).toContain('color-scheme: light dark');
    expect(CSS).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    expect(CSS).toMatch(/\.app\s*\{[^}]*max-width:\s*900px;/s);
    expect(CSS).not.toMatch(/\.msg-row\s*\{[^}]*animation\s*:/s);
    expect(CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation-duration:\s*0\.01ms\s*!important/);
  });

  it('routes key chat surfaces through semantic tokens', () => {
    expect(CSS).toMatch(/\.topbar\s*\{[^}]*background:\s*var\(--surface-glass\)/s);
    expect(CSS).toMatch(/\.composer\s*\{[^}]*background:\s*var\(--surface-glass\)/s);
    expect(CSS).toMatch(/\.bubble-text\.theirs\s*\{[^}]*background:\s*var\(--theirs\)/s);
    expect(CSS).toMatch(/\.bubble-text\.mine\s*\{[^}]*background:\s*var\(--mine\)/s);
    expect(CSS).toMatch(/\.sticker-part\s*\{[^}]*background:\s*var\(--sticker-surface\)/s);
    expect(CSS).toMatch(/\.image-part-placeholder\s*\{[^}]*var\(--shimmer-base\)[^}]*var\(--shimmer-highlight\)/s);
  });
});
