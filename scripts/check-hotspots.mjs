import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const budgets = [
  ['packages/server/src/bootstrap/create-runtime.ts', 15_000],
  ['packages/server/src/bootstrap/create-repositories.ts', 15_000],
  ['packages/server/src/routes/features.ts', 15_000],
  ['packages/server/src/routes/admin/index.ts', 15_000],
  ['packages/server/src/core/jobs/registry.ts', 15_000],
  // the admin console's shared pieces: every page leans on them, so they must stay small
  ['packages/web/src/console/ConsoleApp.tsx', 15_000],
  ['packages/web/src/console/ui.tsx', 30_000],
  ['packages/web/src/console/console.css', 45_000]
];
/** No single console page may grow past this; split it (see pages/life, pages/models) instead. */
const CONSOLE_PAGE_LIMIT = 40_000;
const legacyHotspots = [
  'packages/server/src/app.ts',
  'packages/server/src/routes/admin.ts',
  'packages/server/src/db/migrations.ts',
  'packages/server/src/core/context.ts'
];
/*
 * Ratchet baselines, in bytes. Re-measured 2026-09-05: app.ts, routes/admin.ts
 * and db/migrations.ts had all crept past their previous guards, so
 * `check:hotspots` was failing on main — and because fast-gate only ran on
 * pull requests, the red landed on whichever contributor opened the next PR
 * rather than on the change that caused it. fast-gate now also runs on main.
 *
 * Lower these when a file genuinely shrinks; that is the whole point of a
 * ratchet. Do not raise one without saying why in the commit message.
 */
const legacyBaselines = [
  ['packages/server/src/app.ts', 53919],
  ['packages/server/src/routes/admin.ts', 55300],
  ['packages/server/src/db/migrations.ts', 74324],
  ['packages/server/src/core/context.ts', 32388]
];

const failures = [];
for (const [relative, limit] of budgets) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    failures.push(`${relative}: missing`);
    continue;
  }
  const bytes = fs.statSync(file).size;
  if (bytes > limit) failures.push(`${relative}: ${bytes} bytes > ${limit}`);
}
const pagesDir = path.join(root, 'packages/web/src/console/pages');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
if (fs.existsSync(pagesDir)) {
  for (const file of walk(pagesDir).filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name))) {
    const bytes = fs.statSync(file).size;
    if (bytes > CONSOLE_PAGE_LIMIT) failures.push(`:  bytes >  (console page limit)`);
  }
} else {
  failures.push('packages/web/src/console/pages: missing');
}
for (const relative of legacyHotspots) {
  const file = path.join(root, relative);
  if (fs.existsSync(file)) console.log(`legacy hotspot retained for compatibility: ${relative} (${fs.statSync(file).size} bytes)`);
}
const drift = [];
for (const [relative, baseline] of legacyBaselines) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) continue;
  const bytes = fs.statSync(file).size;
  const limit = Math.ceil(baseline * 1.02);
  if (bytes > limit) {
    failures.push(`${relative}: ${bytes} bytes > baseline guard ${limit} (${baseline} + 2%)`);
    drift.push([relative, bytes]);
  }
  // A file that shrank below its baseline should tighten the ratchet, otherwise
  // the 2% headroom silently accumulates back into the budget.
  if (bytes < baseline) drift.push([relative, bytes]);
}
if (failures.length) {
  console.error('Hotspot budget violations:');
  for (const failure of failures) console.error(`- ${failure}`);
}
if (drift.length) {
  // Make the fix mechanical: print exactly what to paste back into this file,
  // so a stale baseline is a 10-second correction rather than a guess.
  console.error('\nUpdate scripts/check-hotspots.mjs legacyBaselines to:');
  for (const [relative, bytes] of drift) console.error(`  ['${relative}', ${bytes}],`);
  console.error(
    failures.length
      ? '\nRaising a baseline is a deliberate act: say why in the commit message, or split the file.'
      : '\nThese files shrank — tighten the ratchet so the gain is locked in.'
  );
}
if (failures.length) {
  process.exitCode = 1;
} else {
  console.log('Hotspot budgets: OK');
}
