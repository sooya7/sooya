import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const roots = [
  ['packages/server/src/core', [/(?:from|import)\s+[^;]*['"](?:\.\.?\/)+routes\//u]],
  ['packages/server/src/providers', [/(?:from|import)\s+[^;]*['"](?:\.\.?\/)+routes\//u]],
  ['packages/server/src/db/repos', [/(?:from|import)\s+[^;]*['"](?:\.\.?\/)+routes\//u, /['"](?:\.\.?\/)+app\.js['"]/u]],
  ['packages/web/src', [/packages\/server/u, /from\s+['"](?:\.\.?\/)+server\//u]]
];

function filesUnder(relative) {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  const result = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:ts|tsx|js|jsx)$/u.test(entry.name)) result.push(full);
    }
  };
  walk(directory);
  return result;
}

const violations = [];
for (const [relative, patterns] of roots) {
  for (const file of filesUnder(relative)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      if (pattern.test(source)) violations.push(`${path.relative(root, file)} matches ${pattern}`);
    }
  }
}

if (violations.length) {
  console.error('Architecture boundary violations:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Architecture boundaries: OK');
}
