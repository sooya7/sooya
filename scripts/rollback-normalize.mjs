#!/usr/bin/env node
/**
 * P0-5: rollback normalization — explicitly normalizes the post-v15 open
 * states a pre-v15 release cannot handle, then reports every change. Refuses
 * to run while voice generations or proactive deliveries are still in flight,
 * and refuses to touch a database that is not fully migrated.
 *
 * Usage: node scripts/rollback-normalize.mjs [--data-dir <dir>] [--yes]
 *   --data-dir  path to the SOOYA data directory (default: ./data)
 *   --yes       apply without the interactive confirmation
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
if (!fs.existsSync(dbFile)) {
  console.error(`[normalize] database not found: ${dbFile}`);
  process.exit(2);
}

const db = new Database(dbFile);
const now = new Date().toISOString();

// --- gate 1: the database must be fully migrated to the current version.
const version = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get().v;
if (version < 15) {
  console.log(`[normalize] schema version ${version}: nothing to normalize.`);
  db.close();
  process.exit(0);
}

// --- gate 2: no in-flight voice generations or proactive deliveries.
const voicePending = db.prepare(
  "SELECT COUNT(*) AS n FROM voice_generations WHERE status IN ('planned','scripted','synthesizing')"
).get().n;
if (voicePending > 0) {
  console.error(`[normalize] REFUSING: ${voicePending} voice generation(s) still in flight.`);
  console.error('[normalize] wait for them to finish, or fail them explicitly, before downgrading.');
  db.close();
  process.exit(1);
}
const proactivePending = db.prepare(
  "SELECT COUNT(*) AS n FROM proactive_attempts WHERE status = 'blocked' AND blocked_reason IS NULL"
).get().n;
if (proactivePending > 0) {
  console.error(`[normalize] REFUSING: ${proactivePending} proactive delivery(ies) still in flight.`);
  console.error('[normalize] let them settle before downgrading.');
  db.close();
  process.exit(1);
}

// --- dry run: what would change.
const plans = [];
plans.push({
  label: 'generating (hidden) -> queued',
  count: db.prepare("SELECT COUNT(*) AS n FROM reply_batches WHERE status = 'generating' AND visible_at IS NULL").get().n
});
plans.push({
  label: 'publishing (visible) -> completed/partial',
  count: db.prepare("SELECT COUNT(*) AS n FROM reply_batches WHERE status = 'publishing' AND visible_at IS NOT NULL").get().n
});
plans.push({
  label: 'publishing (hidden) -> queued',
  count: db.prepare("SELECT COUNT(*) AS n FROM reply_batches WHERE status = 'publishing' AND visible_at IS NULL").get().n
});
plans.push({
  label: 'superseded -> cancelled',
  count: db.prepare("SELECT COUNT(*) AS n FROM reply_batches WHERE status = 'superseded'").get().n
});
const planned = plans.filter((p) => p.count > 0);

if (planned.length === 0) {
  console.log('[normalize] no post-v15 open states found; the database is already downgrade-safe.');
  db.close();
  process.exit(0);
}

console.log('[normalize] would apply:');
for (const p of planned) console.log(`  - ${p.count} ${p.label}`);
const confirmed = process.argv.includes('--yes') || (await confirm());
if (!confirmed) {
  console.log('[normalize] aborted; nothing was changed.');
  db.close();
  process.exit(0);
}

const tx = db.transaction(() => {
  const changes = [];
  const generating = db.prepare(
    "UPDATE reply_batches SET status = 'queued', last_error = 'rollback normalization', lease_owner = NULL, lease_expires_at = NULL WHERE status = 'generating' AND visible_at IS NULL"
  ).run().changes;
  if (generating > 0) changes.push(`${generating} generating -> queued`);
  const publishing = db.prepare(
    `UPDATE reply_batches
     SET status = 'completed', completed_at = ?, last_error = 'rollback normalization (published content kept)',
         meta_json = json_set(meta_json, '$.partial', 1), lease_owner = NULL, lease_expires_at = NULL
     WHERE status = 'publishing' AND visible_at IS NOT NULL`
  ).run(now).changes;
  if (publishing > 0) changes.push(`${publishing} publishing (visible) -> completed/partial`);
  const publishingHidden = db.prepare(
    "UPDATE reply_batches SET status = 'queued', last_error = 'rollback normalization', lease_owner = NULL, lease_expires_at = NULL WHERE status = 'publishing' AND visible_at IS NULL"
  ).run().changes;
  if (publishingHidden > 0) changes.push(`${publishingHidden} publishing (hidden) -> queued`);
  const superseded = db.prepare(
    "UPDATE reply_batches SET status = 'cancelled', last_error = 'rollback normalization', lease_owner = NULL, lease_expires_at = NULL WHERE status = 'superseded'"
  ).run().changes;
  if (superseded > 0) changes.push(`${superseded} superseded -> cancelled`);
  return changes;
});
const applied = tx();
for (const change of applied) console.log(`  applied: ${change}`);
console.log('[normalize] done. Verify with `node scripts/rollback-preflight.mjs` before downgrading.');

db.close();

async function confirm() {
  process.stdout.write('[normalize] apply now? [y/N] ');
  const answer = await new Promise((resolve) => {
    process.stdin.once('data', (chunk) => resolve(String(chunk)));
  });
  return answer.trim().toLowerCase() === 'y';
}
