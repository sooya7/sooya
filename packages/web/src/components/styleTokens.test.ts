import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const CHAT = read('../styles.css');
const OVERLAYS = read('./overlays.css');

/**
 * The chat page, the overlays and the admin console are one product, so colour
 * lives in the `:root` tokens of `styles.css` and nowhere else.
 *
 * This is not housekeeping. The accent moved to violet by editing token values,
 * but two literal `rgba(58, 161, 255, …)` of the previous blue survived — the
 * composer's drag target and an overlay border — so those two surfaces silently
 * stayed the old colour. The gallery was worse: it restated the whole palette as
 * literals that did not even agree with the tokens (`#d33a42` against
 * `--danger: #e5484d`, `#3aa1ff` against the violet accent), which is how it came
 * to look like a different application.
 */
describe('shared colour tokens', () => {
  it('has no trace of the retired blue accent', () => {
    expect(CHAT).not.toMatch(/58,\s*161,\s*255/);
    expect(OVERLAYS).not.toMatch(/58,\s*161,\s*255/);
  });

  it('exposes the accent at low alpha as a token, for tints and focus rings', () => {
    expect(CHAT).toContain('--accent-tint:');
    expect(CHAT).toContain('--accent-line:');
  });

  it('keeps literal colours out of the overlays, tokens only', () => {
    // Two literals are deliberate rather than themed: the viewer backdrop is
    // near-black so a photograph is the only lit thing on screen, and its chrome
    // is white because it sits on that backdrop, not on the page surface.
    const allowed = new Set(['#080808', '#fff', '#ffffff']);
    const literals = [...OVERLAYS.matchAll(/#[0-9a-fA-F]{3,8}\b/g)]
      .map((m) => m[0].toLowerCase())
      .filter((hex) => !allowed.has(hex));
    expect(literals).toEqual([]);
  });

  it('leaves the remove badge somewhere to sit on a text attachment chip', () => {
    // A voice attachment is a chip as narrow as '🎤 8s', and the badge is pinned
    // to the top-right corner, so without reserved padding it covers the label.
    expect(CHAT).toMatch(/\.attachment-generic \{[^}]*padding: 10px 28px 10px 12px;/);
  });

  it('gives the send button the shared gradient and a readable idle glyph', () => {
    expect(CHAT).toMatch(/\.send-btn\.active \{\s*background: var\(--grad\);/);
    // --ink-faint on --line measured about 1.7:1 in the static preview and the
    // glyph simply was not there; --ink-soft is the floor for this chip.
    expect(CHAT).toMatch(/\.send-btn \{[^}]*color: var\(--ink-soft\);/);
  });
});
