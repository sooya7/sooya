#!/usr/bin/env node
/**
 * P0-5: rollback preflight — READ-ONLY inspection of a SOOYA database before
 * downgrading to a pre-v15 release. Reports every open state the old code
 * cannot fully handle. Nothing is modified.
 *
 * Usage: node scripts/rollback-preflight.mjs [--data-dir <dir>]
 *   --data-dir  path to the SOOYA data directory (default: ./data)
 */
import { createRequire } from 'node:module';
// better-sqlite3 lives in the server workspace (native module, not hoisted).
const require = createRequire(path.join(import.meta.dirname, '../packages/server/package.json'));
const Database = require('better-sqlite3');
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';

function dataDirFromArgs() {
  const idx = process.argv.indexOf('--data-dir');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.DATA_DIR ?? path.resolve('data');
}

const dataDir = dataDirFromArgs();
const dbFile = path.join(dataDir, 'database', 'sooya.db');
// v35 adds the Ombre commit receipt table. It introduces no new in-flight state
// that must be normalized for a pre-v15 rollback, so it is safe for this checker
// to inspect.
const MAX_SCHEMA_VERSION = 35;
if (!fs.existsSync(dbFile)) {
  console.error(`[preflight] database not found: ${dbFile}`);
  console.error(`[preflight] pass --data-dir <dir> or set DATA_DIR`);
  process.exit(2);
}

const db = new Database(dbFile, { readonly: true });
const problems = [];
let version = 0;

try {
  version = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() ?? { v: 0 }).v;
  console.log(`[preflight] schema migration version: ${version}`);
  if (version <= 14) {
    console.log(`[preflight] OK: version ${version} needs no v15+ downgrade normalization.`);
    process.exit(0);
  }
  if (version > MAX_SCHEMA_VERSION) {
    problems.push(`schema version ${version} is NEWER than this tool understands (max ${MAX_SCHEMA_VERSION})`);
  }

  // 1. Reply batches in post-v15 states.
  const openBatches = db.prepare(
    `SELECT id, status, revision, visible_at FROM reply_batches
     WHERE status IN ('generating','publishing','superseded')
       OR (status = 'collecting' AND due_at IS NOT NULL)`
  ).all();
  if (openBatches.length > 0) {
    problems.push(`open reply batches in post-v15 states: ${openBatches.length}`);
    for (const row of openBatches) {
      console.log(`  - ${row.id} status=${row.status} revision=${row.revision} visible_at=${row.visible_at ?? 'NULL'}`);
    }
  }

  // 2. In-flight voice generations (v16+ table).
  const voicePending = db.prepare(
    `SELECT COUNT(*) AS n FROM voice_generations WHERE status IN ('planned','scripted','synthesizing')`
  ).get();
  if (voicePending.n > 0) {
    problems.push(`pending voice generations: ${voicePending.n}`);
  }

  // 3. Proactive/Moments attempts that were still being prepared.
  const proactivePending = db.prepare(
    `SELECT COUNT(*) AS n FROM proactive_attempts WHERE status = 'blocked' AND blocked_reason IS NULL`
  ).get();
  if (proactivePending.n > 0) {
    problems.push(`proactive attempts in flight (blocked without reason): ${proactivePending.n}`);
  }

  // 4. Migration bookkeeping consistency.
  const appliedCount = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
  if (appliedCount.n !== version) {
    problems.push(`schema_migrations has ${appliedCount.n} rows but max version is ${version}`);
  }
} finally {
  db.close();
}

if (problems.length === 0) {
  console.log('[preflight] OK: no open states that a pre-v15 release cannot handle.');
  console.log('[preflight] run `node scripts/rollback-normalize.mjs --data-dir <dir>` to normalize first, or restore a backup.');
  process.exit(0);
}
console.error(`[preflight] ${problems.length} issue(s) found — downgrade is NOT safe as-is:`);
for (const p of problems) console.error(`  - ${p}`);
console.error('[preflight] resolve the issues, or restore a pre-upgrade backup (preferred).');
process.exit(1);
