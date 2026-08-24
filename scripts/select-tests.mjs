import { execFileSync } from 'node:child_process';

const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'HEAD~1';
let changed = [];
try {
  changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
} catch {
  changed = [];
}

const allServer = 'npm run test -w @sooya/server';
const allWeb = 'npm run test -w @sooya/web';
const serverTests = new Set();
const webChanged = changed.some((file) => file.startsWith('packages/web/'));
const continuityChanged = changed.some((file) => /future|relationship|timeline|life|context|proactive/u.test(file));
const serverChanged = changed.some((file) => file.startsWith('packages/server/'));

for (const file of changed) {
  if (file.includes('proactive')) serverTests.add('test/proactive-composer.test.ts test/qq-proactive.test.ts');
  if (file.includes('reply') || file.includes('message-ingress')) serverTests.add('test/reply-coordinator.test.ts test/message-ingress.test.ts');
  if (file.includes('jobs')) serverTests.add('test/job-priority.test.ts test/job-lanes.test.ts test/critical-path.contract.test.ts');
  if (file.includes('qq')) serverTests.add('test/qq-inbound.test.ts test/qq-delivery.test.ts');
  if (file.includes('flow-trace')) serverTests.add('test/flow-trace.test.ts test/critical-path.contract.test.ts');
}

console.log('Changed files:', changed.length ? changed.join(', ') : '(unknown)');
if (serverChanged) {
  const selected = [...serverTests].join(' ');
  console.log(selected ? `Server tests: ${selected}` : `Server tests: ${allServer}`);
}
if (webChanged) console.log(`Web tests: ${allWeb}`);
if (continuityChanged) console.log('Long horizon tests: npx vitest run test/long-horizon');
