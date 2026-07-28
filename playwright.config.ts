// Convenience entry point so `npx playwright test` works from the repo root.
// The real configuration lives next to the specs and anchors all of its
// paths to its own location, so both invocations resolve identically.
export { default } from './e2e/playwright.config.js';
