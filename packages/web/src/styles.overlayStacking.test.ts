/**
 * The two bottom-centred fixed overlays — the push opt-in bar and the
 * service-worker update prompt — are authored in different stylesheets, so
 * nothing stops one from being moved on top of the other. That already happened
 * once in production: the opt-in bar (z-index 80) covered the update prompt
 * (z-index 40) and hit-testing at the centre of "立即更新" returned the opt-in
 * bar, so the update could not be accepted at all.
 *
 * These assertions read the real declarations and compare numbers, so a future
 * z-index bump or offset change on either side fails here instead of silently
 * burying a prompt again.
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

  it('keeps both overlays pinned to the bottom centre', () => {
    for (const body of [updatePrompt, optin]) {
      expect(declaration(body, 'position')).toBe('fixed');
      expect(declaration(body, 'bottom')).toBeTruthy();
    }
  });

  it('puts the update prompt above the opt-in bar when they overlap', () => {
    // Whoever wins a collision must be the prompt: dismissing the opt-in bar is
    // optional, accepting an update is not.
    expect(zIndex(updatePrompt)).toBeGreaterThan(zIndex(optin));
  });

  it('moves the update prompt clear of the opt-in bar while it is shown', () => {
    const raised = ruleBody(appCss, 'body:has(.notification-optin) .sw-update');
    const base = literalPxOffset(declaration(updatePrompt, 'bottom'));
    const lifted = literalPxOffset(declaration(raised, 'bottom'));
    // The opt-in bar measures ~57px tall in production; anything less than its
    // height still leaves the prompt partly underneath it.
    expect(lifted - base).toBeGreaterThanOrEqual(57);
  });
});
