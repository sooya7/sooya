import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const fullGate = fs.readFileSync(new URL('../../../.github/workflows/comprehensive-test.yml', import.meta.url), 'utf8');

describe('CI gate trigger contract', () => {
  it('runs Full CI for normal PR creation and every subsequent ready PR update', () => {
    expect(fullGate).toContain('types: [opened, ready_for_review, reopened, synchronize]');
    expect(fullGate).toContain("if: github.event_name != 'pull_request' || github.event.pull_request.draft == false");
  });
});
