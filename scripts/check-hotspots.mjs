import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const budgets = [
  ['packages/server/src/bootstrap/create-runtime.ts', 15_000],
  ['packages/server/src/bootstrap/create-repositories.ts', 15_000],
  ['packages/server/src/routes/features.ts', 15_000],
  ['packages/server/src/routes/admin/index.ts', 15_000],
  ['packages/server/src/core/jobs/registry.ts', 15_000],
  ['packages/web/src/components/admin/AdminShell.tsx', 20_000],
  ['packages/web/src/components/admin/AdminNavigation.tsx', 20_000]
];
const legacyHotspots = [
  'packages/server/src/app.ts',
  'packages/server/src/routes/admin.ts',
  'packages/server/src/db/migrations.ts',
  'packages/server/src/core/context.ts',
  'packages/web/src/components/AdminPanel.tsx'
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
for (const relative of legacyHotspots) {
  const file = path.join(root, relative);
  if (fs.existsSync(file)) console.log(`legacy hotspot retained for compatibility: ${relative} (${fs.statSync(file).size} bytes)`);
}
if (failures.length) {
  console.error('Hotspot budget violations:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Hotspot budgets: OK');
}
