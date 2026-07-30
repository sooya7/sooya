/**
 * The push opt-in UI and the service-worker update prompt are authored in different
 * stylesheets, and they collided in production: the opt-in bar was a fixed, bottom
 * centred bar shown by default (z-index 80) and it covered the update prompt
 * (z-index 40) so completely that hit-testing the centre of "立即更新" returned the
 * bar. The update could not be accepted at all.
 *
 * The fix was to stop floating the opt-in over the conversation: it is now a popover
 * anchored under the bell in the top bar. These assertions read the real declarations
 * so that neither half of that can quietly come back.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (relative: string) => readFileSync(join(__dirname, relative), 'utf8');

/** The declaration block of the first rule whose selector matches exactly. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  const body = match?.[1];
  if (body === undefined) throw new Error(`no rule found for selector: ${selector}`);
  return body;
}

function declaration(body: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, 'm').exec(body);
  const value = match?.[1];
  if (value === undefined) throw new Error(`no "${property}" declaration in: ${body.trim()}`);
  return value.trim();
}

const zIndex = (body: string) => Number.parseInt(declaration(body, 'z-index'), 10);

/**
 * Sum of the literal px addends in a `bottom` value. Both overlays are offset
 * from the same composer-height variable, so the literals are what separates
 * them vertically.
 */
function literalPxOffset(value: string): number {
  const numbers = value.match(/(?<![\w-])(\d+(?:\.\d+)?)px/g) ?? [];
  // A `var(--composer-h, 76px)` fallback is not an offset of its own.
  const withoutFallbacks = value.replace(/var\([^)]*\)/g, '');
  const kept = withoutFallbacks.match(/(\d+(?:\.\d+)?)px/g) ?? [];
  expect(numbers.length).toBeGreaterThan(0);
  return kept.reduce((total, px) => total + Number.parseFloat(px), 0);
}

describe('bottom overlay stacking', () => {
  const appCss = read('styles.css');
  const overlayCss = read('components/overlays.css');

  const updatePrompt = ruleBody(appCss, '.sw-update');
  const optin = ruleBody(overlayCss, '.notification-optin');

  it('keeps the update prompt pinned above the composer', () => {
    expect(declaration(updatePrompt, 'position')).toBe('fixed');
    expect(literalPxOffset(declaration(updatePrompt, 'bottom'))).toBeGreaterThan(0);
  });

  it('puts the update prompt above the notification popover if they ever overlap', () => {
    // Whoever wins a collision must be the prompt: opening the notification setting
    // is optional, accepting an update is not.
    expect(zIndex(updatePrompt)).toBeGreaterThan(zIndex(optin));
  });

  it('keeps the notification popover out of the conversation entirely', () => {
    // Anchored to the top bar, not fixed over the chat. `position: fixed` here is
    // exactly what produced the bug, so it is the thing worth forbidding.
    const position = declaration(optin, 'position');
    expect(position).not.toBe('fixed');
    expect(position).toBe('absolute');
    // A bottom offset would put it back over the composer and the prompt.
    expect(() => declaration(optin, 'bottom')).toThrow();
  });
});
