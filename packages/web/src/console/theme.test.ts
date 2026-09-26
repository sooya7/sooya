import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(here, 'console.css'), 'utf8');

/** Tokens declared directly in a block that starts at `selector`. */
function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/(--c-[a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}
const light = tokens(CSS.slice(CSS.indexOf('.cs {'), CSS.indexOf('@media (prefers-color-scheme: dark)')));
const darkStart = CSS.indexOf('@media (prefers-color-scheme: dark) {\n  .cs {');
const dark = { ...light, ...tokens(CSS.slice(darkStart, CSS.indexOf('\n}\n', darkStart))) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('console palette', () => {
  it.each([['light', light], ['dark', dark]] as const)('keeps %s text readable', (_name, t) => {
    // body text and secondary text on the page and on inputs: WCAG AA for normal text
    for (const bg of ['--c-paper', '--c-sheet']) {
      expect(contrast(t['--c-ink']!, t[bg]!)).toBeGreaterThanOrEqual(7);
      expect(contrast(t['--c-ink-2']!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
    }
    // the action colour carries button labels and links
    expect(contrast(t['--c-on-jade']!, t['--c-jade']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--c-jade']!, t['--c-paper']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('really switches in dark mode', () => {
    expect(luminance(dark['--c-paper']!)).toBeLessThan(luminance(light['--c-paper']!));
    expect(luminance(dark['--c-ink']!)).toBeGreaterThan(luminance(light['--c-ink']!));
  });

  it('keeps colour in console.css: page styles use its variables, never literals', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.css') ? [path.join(dir, e.name)] : []));
    for (const file of walk(path.join(here, 'pages'))) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, path.basename(file)).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    }
  });

  it('never fakes a bold for the single-weight face', () => {
    expect(CSS).toMatch(/font-synthesis-weight:\s*none/);
  });
});
