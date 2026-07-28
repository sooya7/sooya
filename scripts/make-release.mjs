#!/usr/bin/env node
/**
 * Builds the SOOYA source release: a ZIP, a TAR.GZ and a SHA256SUMS file.
 *
 * The package contains only what is needed to build and deploy from source.
 * It must never contain node_modules, a real .env, API keys, the database,
 * logs, user media, backups or test output — `check-release.mjs` enforces that.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = `sooya-${pkg.version}`;
const STAGE = path.join(RELEASE_DIR, NAME);

/** Paths included in the release, relative to the repository root. */
const INCLUDE = [
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  '.env.example',
  '.gitignore',
  '.dockerignore',
  'Dockerfile',
  'docker-compose.yml',
  'playwright.config.ts',
  'assets',
  'config',
  'deploy',
  'docs',
  'e2e',
  'scripts',
  'packages/server/package.json',
  'packages/server/tsconfig.json',
  'packages/server/vitest.config.ts',
  'packages/server/src',
  'packages/server/test',
  'packages/web/package.json',
  'packages/web/tsconfig.json',
  'packages/web/vite.config.ts',
  'packages/web/index.html',
  'packages/web/src',
  'packages/web/public'
];

/** Never copied, at any depth. */
const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  'data',
  'release',
  'test-results',
  'playwright-report',
  '.cache',
  '__pycache__'
]);

const EXCLUDE_FILE_RE = [
  /^\.env$/,
  /^\.env\..*/,
  /\.log$/,
  /\.db$/,
  /\.db-wal$/,
  /\.db-shm$/,
  /\.sqlite$/,
  /\.tsbuildinfo$/,
  /^\.DS_Store$/,
  /^npm-debug/,
  /\.pem$/,
  /\.key$/
];

function shouldSkip(name, isDir) {
  if (isDir) return EXCLUDE_DIRS.has(name);
  if (name === '.env.example') return false;
  return EXCLUDE_FILE_RE.some((re) => re.test(name));
}

async function copyTree(src, dest) {
  const stat = await fsp.stat(src);
  if (stat.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
      if (shouldSkip(entry.name, entry.isDirectory())) continue;
      await copyTree(path.join(src, entry.name), path.join(dest, entry.name));
    }
    return;
  }
  if (shouldSkip(path.basename(src), false)) return;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
  // Preserve the executable bit for deployment scripts.
  await fsp.chmod(dest, stat.mode & 0o777);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  console.log(`[release] staging ${NAME}`);
  await fsp.rm(RELEASE_DIR, { recursive: true, force: true });
  await fsp.mkdir(STAGE, { recursive: true });

  for (const rel of INCLUDE) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) {
      console.warn(`[release] skipping missing ${rel}`);
      continue;
    }
    await copyTree(src, path.join(STAGE, rel));
  }

  // config/ ships only as a template; runtime files are the user's.
  const configDir = path.join(STAGE, 'config');
  await fsp.mkdir(configDir, { recursive: true });
  for (const leftover of ['models.json', 'persona.json']) {
    await fsp.rm(path.join(configDir, leftover), { force: true });
  }
  await fsp.writeFile(
    path.join(configDir, 'README.md'),
    [
      '# config/',
      '',
      'SOOYA writes `persona.json` and `models.json` here on first start.',
      'Both files are runtime state and are intentionally NOT shipped in the release,',
      'so an upgrade can never overwrite your persona or your model configuration.',
      '',
      'See `docs/DEPLOYMENT.md` and `.env.example` for how to configure providers.',
      ''
    ].join('\n')
  );

  // Deployment scripts must be runnable straight out of the archive. Editors
  // and text-rewriting tools routinely drop the executable bit, which would
  // otherwise ship a release whose install.sh cannot be executed.
  const EXECUTABLES = [
    'deploy/install.sh',
    'deploy/upgrade.sh',
    'deploy/rollback.sh',
    'deploy/backup.sh',
    'deploy/restore-backup.sh',
    'deploy/docker-entrypoint.sh',
    'scripts/test-deploy.sh'
  ];
  for (const rel of EXECUTABLES) {
    const target = path.join(STAGE, rel);
    if (!fs.existsSync(target)) {
      console.warn(`[release] expected executable missing: ${rel}`);
      continue;
    }
    await fsp.chmod(target, 0o755);
  }

  // A build stamp helps support: it records what was packaged and when.
  await fsp.writeFile(
    path.join(STAGE, 'RELEASE.json'),
    `${JSON.stringify(
      {
        name: 'sooya',
        version: pkg.version,
        builtAt: new Date().toISOString(),
        node: process.version,
        contents: 'source only (build with: npm ci && npm run build)'
      },
      null,
      2
    )}\n`
  );

  // ------------------------------- archives ---------------------------------
  const tarball = path.join(RELEASE_DIR, `${NAME}.tar.gz`);
  const zipfile = path.join(RELEASE_DIR, `${NAME}.zip`);

  console.log('[release] creating tar.gz');
  execFileSync('tar', ['-C', RELEASE_DIR, '-czf', tarball, NAME], { stdio: 'inherit' });

  console.log('[release] creating zip');
  try {
    execFileSync('zip', ['-rq', zipfile, NAME], { cwd: RELEASE_DIR, stdio: 'inherit' });
  } catch {
    // `zip` is not always installed; fall back to a pure-Node writer.
    console.log('[release] zip binary unavailable, using the built-in writer');
    const { createZip } = await import('./zip.mjs');
    await createZip(STAGE, zipfile, NAME);
  }

  // ------------------------------- checksums --------------------------------
  const lines = [];
  for (const file of [zipfile, tarball]) {
    lines.push(`${sha256File(file)}  ${path.basename(file)}`);
  }
  const sumFile = path.join(RELEASE_DIR, 'SHA256SUMS.txt');
  await fsp.writeFile(sumFile, `${lines.join('\n')}\n`);

  await fsp.rm(STAGE, { recursive: true, force: true });

  console.log('\n[release] done:');
  for (const f of [zipfile, tarball, sumFile]) {
    console.log(`  ${path.basename(f)}  ${(fs.statSync(f).size / 1024).toFixed(1)} KB`);
  }
  console.log(`\n${await fsp.readFile(sumFile, 'utf8')}`);
}

await main();
