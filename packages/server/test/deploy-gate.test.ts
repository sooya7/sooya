/**
 * `deploy/auto-update.sh` is the only thing that puts code on the server, and it runs
 * unattended every five minutes. It failed silently in production: the check gate
 * counts GitHub check conclusions with `grep -o … | wc -l`, `grep` exits 1 when it
 * matches nothing, and under `set -Eeuo pipefail` that ended the script on the spot —
 * before either of the "not deploying because …" messages could be printed. A merge
 * whose checks had not been created yet therefore produced a failed systemd unit with
 * nothing in the journal explaining why, once per merge.
 *
 * The gate itself needs root, a clone and a live API, so it is not run here. What is
 * checked is the shape that caused the bug: an unguarded `grep` inside a command
 * substitution in a `pipefail` script, plus the syntax of the file as a whole.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(__dirname, '..', '..', '..');
const scripts = ['auto-update.sh', 'upgrade.sh', 'rollback.sh', 'backup.sh', 'install.sh'];

describe('deploy scripts', () => {
  for (const name of scripts) {
    const path = join(repoRoot, 'deploy', name);
    const source = readFileSync(path, 'utf8');

    it(`${name} parses`, () => {
      expect(() => execFileSync('bash', ['-n', path], { stdio: 'pipe' })).not.toThrow();
    });

  }

  it('counts an empty check list as zero instead of dying on it', () => {
    // The real bug, exercised with the real line: `count()` is lifted verbatim out of
    // the script and run under the same shell options, against the response GitHub
    // actually returns for a commit whose checks do not exist yet. Before the fix this
    // exited 1 with no output, which is how a broken deploy looked in the journal.
    const source = readFileSync(join(repoRoot, 'deploy', 'auto-update.sh'), 'utf8');
    const definition = /^[ \t]*count\(\)[^\n]*$/m.exec(source);
    expect(definition, 'count() is expected to be a one-line definition').not.toBeNull();

    const run = (runsJson: string) => {
      const script = [
        'set -Eeuo pipefail',
        `RUNS=${JSON.stringify(runsJson)}`,
        definition?.[0] ?? '',
        // The assignment form matters: `set -e` propagates a failed command
        // substitution here, but not inside an argument to `echo`. Getting this wrong
        // made an earlier version of this test pass against the broken script.
        'TOTAL="$(count \'"conclusion":\')"',
        'echo "TOTAL=$TOTAL"'
      ].join('\n');
      return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
    };

    expect(run('{"total_count":0,"check_runs":[]}')).toBe('TOTAL=0');
    expect(run('{"check_runs":[{"conclusion":"success"},{"conclusion":null}]}')).toBe('TOTAL=2');
  });

  it('auto-update treats "checks not finished yet" as a normal outcome, not a failure', () => {
    const source = readFileSync(join(repoRoot, 'deploy', 'auto-update.sh'), 'utf8');

    // Every squash merge produces a commit whose checks start from nothing, so this
    // path is taken on every deploy. If it exits non-zero the unit is left failed and
    // a real failure no longer stands out.
    expect(source).toMatch(/skip\(\)\s*\{[^}]*exit 0/);
    const gate = /\(\(\s*TOTAL > 0\s*\)\)\s*\|\|\s*(\w+)/.exec(source);
    expect(gate?.[1]).toBe('skip');
    const pending = /\(\(\s*PENDING == 0\s*\)\)\s*\|\|\s*(\w+)/.exec(source);
    expect(pending?.[1]).toBe('skip');
    // A genuinely red commit is different: that one stays loud.
    const red = /\(\(\s*TOTAL == GOOD\s*\)\)\s*\|\|\s*(\w+)/.exec(source);
    expect(red?.[1]).toBe('die');
  });
});
