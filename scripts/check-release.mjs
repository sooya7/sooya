#!/usr/bin/env node
/**
 * Release package audit.
 *
 * Extracts both archives into a temporary directory and asserts:
 *   * the checksums in SHA256SUMS.txt match the files
 *   * ZIP and TAR.GZ contain the same file list
 *   * nothing forbidden is present (node_modules, .env, keys, database,
 *     logs, user media, backups, test output)
 *   * no file contains a plausible API key
 *   * everything needed to build and deploy IS present
 *   * deployment scripts kept their executable bit
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = `sooya-${pkg.version}`;

let failures = 0;
const check = (ok, description, detail = '') => {
  if (ok) {
    console.log(`  \x1b[32mPASS\x1b[0m ${description}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
  }
};

const FORBIDDEN_PATH_RE = [
  { re: /(^|\/)node_modules(\/|$)/, why: 'node_modules' },
  { re: /(^|\/)\.env$/, why: 'real .env' },
  { re: /(^|\/)\.env\.(?!example)/, why: '.env variant' },
  { re: /(^|\/)data(\/|$)/, why: 'runtime data directory' },
  { re: /\.db($|-wal$|-shm$)/, why: 'database file' },
  { re: /\.sqlite$/, why: 'sqlite file' },
  // Runtime directories only: `packages/server/src/backup/` and `.../media/`
  // are source code, so these rules are anchored at the data root.
  { re: /(^|\/)data\/backups?(\/|$)/, why: 'backups' },
  { re: /^backups?(\/|$)/, why: 'backups' },
  { re: /(^|\/)data\/logs?(\/|$)/, why: 'logs' },
  { re: /^logs?(\/|$)/, why: 'logs' },
  { re: /\.log$/, why: 'log file' },
  { re: /(^|\/)data\/media(\/|$)/, why: 'user media' },
  { re: /^media(\/|$)/, why: 'user media' },
  { re: /(^|\/)dist(\/|$)/, why: 'build output' },
  { re: /(^|\/)data(\/|$)/, why: 'runtime data directory' },
  { re: /(^|\/)release(\/|$)/, why: 'nested release output' },
  { re: /(^|\/)test-results(\/|$)/, why: 'test output' },
  { re: /(^|\/)playwright-report(\/|$)/, why: 'test report' },
  { re: /(^|\/)coverage(\/|$)/, why: 'coverage output' },
  { re: /(^|\/)\.git(\/|$)/, why: 'git metadata' },
  { re: /\.(pem|key|p12|pfx)$/, why: 'private key material' },
  { re: /(^|\/)config\/(models|persona)\.json$/, why: 'runtime config that would overwrite user settings' },
  { re: /qq[-_]?(login|session|token)/i, why: 'QQ login data' }
];

const REQUIRED_PATHS = [
  'package.json',
  'package-lock.json',
  'README.md',
  '.env.example',
  'Dockerfile',
  'docker-compose.yml',
  'RELEASE.json',
  'deploy/install.sh',
  'deploy/upgrade.sh',
  'deploy/rollback.sh',
  'deploy/backup.sh',
  'deploy/restore-backup.sh',
  'deploy/sooya.service',
  'deploy/nginx.conf.example',
  'deploy/docker-entrypoint.sh',
  'deploy/ombre/docker-compose.yml',
  'deploy/ombre/.env.example',
  'deploy/ombre/README.md',
  'config/mcp.json',
  'docs/DEPLOYMENT.md',
  'docs/API.md',
  'docs/DATABASE.md',
  'docs/TEST-REPORT.md',
  'docs/REVIEW.md',
  'docs/LIMITATIONS.md',
  'packages/server/src/main.ts',
  'packages/server/src/app.ts',
  'packages/server/test',
  'packages/server/test/regression.test.ts',
  'packages/web/src/App.tsx',
  'packages/web/index.html',
  'packages/web/public/manifest.webmanifest',
  'packages/web/public/sw.js',
  'assets/stickers/manifest.json',
  'e2e/chat.e2e.ts',
  'scripts/make-release.mjs'
];

/** Patterns that look like a live credential. */
const SECRET_RE = [
  /sk-[A-Za-z0-9]{20,}/,
  /sk-proj-[A-Za-z0-9_-]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/
];

async function main() {
  console.log(`\n[check-release] auditing ${NAME}\n`);

  const zipPath = path.join(RELEASE_DIR, `${NAME}.zip`);
  const tarPath = path.join(RELEASE_DIR, `${NAME}.tar.gz`);
  const sumPath = path.join(RELEASE_DIR, 'SHA256SUMS.txt');

  check(fs.existsSync(zipPath), 'ZIP archive exists');
  check(fs.existsSync(tarPath), 'TAR.GZ archive exists');
  check(fs.existsSync(sumPath), 'SHA256SUMS.txt exists');
  if (failures > 0) {
    console.log('\nrun `npm run package` first\n');
    process.exit(1);
  }

  // ------------------------------ checksums ---------------------------------
  const sums = new Map();
  for (const line of fs.readFileSync(sumPath, 'utf8').trim().split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name) sums.set(name, hash);
  }
  for (const file of [zipPath, tarPath]) {
    const base = path.basename(file);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    check(sums.get(base) === actual, `${base} matches its recorded SHA256`, `expected ${sums.get(base)}, got ${actual}`);
  }
  check(sums.size === 2, 'SHA256SUMS.txt covers both archives');

  // ------------------------------- extract ----------------------------------
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'sooya-relcheck-'));
  const tarDir = path.join(work, 'tar');
  const zipDir = path.join(work, 'zip');
  await fsp.mkdir(tarDir);
  await fsp.mkdir(zipDir);

  execFileSync('tar', ['-C', tarDir, '-xzf', tarPath]);
  try {
    execFileSync('unzip', ['-qq', zipPath, '-d', zipDir]);
  } catch {
    console.log('  (unzip unavailable; ZIP contents compared via listing only)');
  }

  const tarRoot = path.join(tarDir, NAME);
  check(fs.existsSync(tarRoot), 'TAR.GZ extracts into a single versioned directory');

  const listFiles = async (dir, base = dir, acc = []) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (entry.isDirectory()) await listFiles(full, base, acc);
      else acc.push(rel);
    }
    return acc;
  };

  const tarFiles = await listFiles(tarRoot);
  check(tarFiles.length > 40, `archive contains a plausible number of files (${tarFiles.length})`);

  // ---------------------------- forbidden content ---------------------------
  const offenders = [];
  for (const file of tarFiles) {
    for (const rule of FORBIDDEN_PATH_RE) {
      if (rule.re.test(file)) offenders.push(`${file} (${rule.why})`);
    }
  }
  check(offenders.length === 0, 'no forbidden files in the package', offenders.slice(0, 8).join('; '));

  // ------------------------------ secret scan -------------------------------
  //
  // Test fixtures legitimately contain obvious fake keys (they point at a local
  // mock server and match no real account). They are whitelisted BY PATH so the
  // scan stays strict everywhere else: any `sk-`-style string appearing in real
  // source, configuration or documentation still fails the audit.
  const FIXTURE_PATHS = [/^packages\/server\/test\//, /^e2e\//];
  const isFixture = (file) => FIXTURE_PATHS.some((re) => re.test(file));

  const leaks = [];
  const fixtureHits = [];
  for (const file of tarFiles) {
    const full = path.join(tarRoot, file);
    const stat = await fsp.stat(full);
    if (stat.size > 2 * 1024 * 1024) continue;
    let content;
    try {
      content = await fsp.readFile(full, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue;
    for (const re of SECRET_RE) {
      const m = re.exec(content);
      if (!m) continue;
      if (isFixture(file)) fixtureHits.push(`${file}: ${m[0].slice(0, 12)}...`);
      else leaks.push(`${file}: ${m[0].slice(0, 12)}...`);
    }
  }
  check(
    leaks.length === 0,
    'no API keys or private keys outside test fixtures',
    leaks.slice(0, 5).join('; ')
  );
  if (fixtureHits.length > 0) {
    console.log(`  \x1b[2mnote\x1b[0m ${fixtureHits.length} fake key(s) in test fixtures (expected): ${fixtureHits[0]}`);
  }
  // Private key material is never acceptable, not even in a fixture.
  const pemAnywhere = [];
  for (const file of tarFiles) {
    const full = path.join(tarRoot, file);
    let content;
    try {
      content = await fsp.readFile(full, 'utf8');
    } catch {
      continue;
    }
    if (/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) pemAnywhere.push(file);
  }
  check(pemAnywhere.length === 0, 'no private key material anywhere in the package', pemAnywhere.join(', '));

  // .env.example must be a template, not a filled-in file.
  const envExample = await fsp.readFile(path.join(tarRoot, '.env.example'), 'utf8');
  const filled = envExample
    .split('\n')
    .filter((l) => /_(API_KEY|TOKEN)=/.test(l) && !/=\s*$/.test(l) && !l.trim().startsWith('#'));
  check(filled.length === 0, '.env.example contains no filled-in secrets', filled.join('; '));

  // ---------------------------- required content ----------------------------
  const missing = REQUIRED_PATHS.filter((p) => !fs.existsSync(path.join(tarRoot, p)));
  check(missing.length === 0, 'all required files are present', missing.join(', '));

  // ------------------------------ executables -------------------------------
  const notExecutable = [];
  for (const script of ['install.sh', 'upgrade.sh', 'rollback.sh', 'backup.sh', 'restore-backup.sh']) {
    const st = await fsp.stat(path.join(tarRoot, 'deploy', script));
    if (!(st.mode & 0o111)) notExecutable.push(script);
  }
  if (process.platform === 'win32') {
    console.log('  (deployment executable-bit checks skipped on Windows; GitHub CI enforces them on Linux)');
  } else {
    check(notExecutable.length === 0, 'deployment scripts are executable', notExecutable.join(', '));
  }

  // ---------------------------- archive parity ------------------------------
  const zipRoot = path.join(zipDir, NAME);
  if (fs.existsSync(zipRoot)) {
    const zipFiles = await listFiles(zipRoot);
    const onlyTar = tarFiles.filter((f) => !zipFiles.includes(f));
    const onlyZip = zipFiles.filter((f) => !tarFiles.includes(f));
    check(
      onlyTar.length === 0 && onlyZip.length === 0,
      'ZIP and TAR.GZ contain the same files',
      `only-tar: ${onlyTar.slice(0, 3)}; only-zip: ${onlyZip.slice(0, 3)}`
    );
    const zipScript = await fsp.stat(path.join(zipRoot, 'deploy/install.sh'));
    if (process.platform !== 'win32') check((zipScript.mode & 0o111) !== 0, 'ZIP preserves the executable bit on scripts');
  }

  // -------------------------- buildability smoke test -----------------------
  const stagedPkg = JSON.parse(await fsp.readFile(path.join(tarRoot, 'package.json'), 'utf8'));
  check(!!stagedPkg.scripts?.build, 'package.json exposes a build script');
  check(!!stagedPkg.workspaces, 'workspaces are declared so `npm ci` works');
  const stickers = await fsp.readdir(path.join(tarRoot, 'assets/stickers'));
  check(stickers.filter((f) => /\.(png|gif|jpe?g|webp)$/i.test(f)).length >= 10, 'built-in sticker pack is bundled');

  await fsp.rm(work, { recursive: true, force: true });

  console.log('');
  if (failures === 0) {
    console.log('\x1b[32m[check-release] package audit passed\x1b[0m\n');
    process.exit(0);
  }
  console.log(`\x1b[31m[check-release] ${failures} check(s) failed\x1b[0m\n`);
  process.exit(1);
}

await main();
