import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_SOURCE = fs.readFileSync(path.join(HERE, '../src/core/context.ts'), 'utf8');

describe('model-driven multimedia autonomy', () => {
  it('tells the model to make proactive media decisions instead of waiting for explicit requests', () => {
    expect(CONTEXT_SOURCE).toContain('主动决定，不要一直等用户明确要求');
    expect(CONTEXT_SOURCE).toContain('不要机械等待关键词');
  });

  it('defines actionable frequency semantics without forcing every reply to contain media', () => {
    expect(CONTEXT_SOURCE).toContain('high=经常在合适时主动使用');
    expect(CONTEXT_SOURCE).toContain('medium=每隔几轮遇到自然机会就主动使用');
    expect(CONTEXT_SOURCE).toContain('low=只在明显合适时偶尔主动使用');
    expect(CONTEXT_SOURCE).toContain('通常一条回复主动选择一种最合适的媒体即可');
  });

  it('keeps explicit user requests mandatory', () => {
    expect(CONTEXT_SOURCE).toContain('用户明确要求时仍必须照做');
  });
});
