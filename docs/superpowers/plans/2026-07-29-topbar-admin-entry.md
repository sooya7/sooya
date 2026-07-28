# Topbar Admin Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the oversized Emoji gear with a precisely centred, minimal SVG admin entry in the chat header.

**Architecture:** Keep the existing admin anchor and routing contract unchanged. Replace only its text child with an inline SVG, then reduce the existing CSS control to a 30px circular outlined icon button.

**Tech Stack:** React, TypeScript, CSS, Playwright.

---

### Task 1: Lock the visual contract with an E2E test

**Files:**
- Modify: `e2e/chat.e2e.ts:440-451`
- Modify: `packages/web/src/App.tsx:199-201`
- Modify: `packages/web/src/styles.css:136-165`

- [ ] **Step 1: Write the failing test**

Add this test after the existing top-right placement test:

```ts
test('uses a compact centered SVG for the admin entry', async ({ page }) => {
  await page.goto('/');

  const entry = page.getByTestId('admin-entry');
  const icon = entry.locator('svg');
  await expect(icon).toHaveAttribute('viewBox', '0 0 24 24');
  await expect(entry).toHaveCSS('width', '30px');
  await expect(entry).toHaveCSS('height', '30px');
  await expect(entry).toHaveCSS('border-radius', '50%');
  await expect(entry).toHaveCSS('box-shadow', 'none');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:e2e -- --grep "uses a compact centered SVG" --project=desktop`

Expected: FAIL because the current entry has no SVG and measures 44px.

- [ ] **Step 3: Implement the minimal SVG and CSS**

Replace the Emoji child in `packages/web/src/App.tsx` with:

```tsx
<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" />
  <path d="m19.4 13.6.1-1.6-.1-1.6-2-.5a7.2 7.2 0 0 0-.8-1.8l1.1-1.8-2.3-2.3-1.8 1.1a7.2 7.2 0 0 0-1.8-.8l-.5-2h-3.2l-.5 2a7.2 7.2 0 0 0-1.8.8L4.3 4.1 2 6.4l1.1 1.8a7.2 7.2 0 0 0-.8 1.8l-2 .5L.2 12l.1 1.6 2 .5a7.2 7.2 0 0 0 .8 1.8L2 17.7 4.3 20l1.8-1.1a7.2 7.2 0 0 0 1.8.8l.5 2h3.2l.5-2a7.2 7.2 0 0 0 1.8-.8l1.8 1.1 2.3-2.3-1.1-1.8a7.2 7.2 0 0 0 .8-1.8l2-.5Z" />
</svg>
```

Set `.topbar-admin-entry` to `width: 30px`, `height: 30px`, `border-radius: 50%`, `background: #fff`, `box-shadow: none`, and `display: inline-flex` with centred alignment. Add `.topbar-admin-entry svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }`. Use a flat `#f1f6fb` hover/focus background and keep the existing active scale.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npm run test:e2e -- --grep "admin entry|opens the admin panel" --project=desktop`

Expected: PASS for placement, SVG visual contract, and same-tab navigation tests.

- [ ] **Step 5: Build and verify production geometry**

Run: `npm run build`

Expected: exit code 0 and a new web asset bundle.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/App.tsx packages/web/src/styles.css e2e/chat.e2e.ts docs/superpowers/specs/2026-07-29-topbar-admin-entry-design.md docs/superpowers/plans/2026-07-29-topbar-admin-entry.md
git commit -m "style: refine topbar admin entry"
```
