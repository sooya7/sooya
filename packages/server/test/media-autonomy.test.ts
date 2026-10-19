import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_SOURCE = fs.readFileSync(path.join(HERE, '../src/core/context.ts'), 'utf8');
const MEDIA_TOOLS_SOURCE = fs.readFileSync(path.join(HERE, '../src/core/media-tools/tools.ts'), 'utf8');

describe('model-driven multimedia autonomy', () => {
  it('leaves stickers to her own judgement, with a frequency she can act on', () => {
    expect(CONTEXT_SOURCE).toContain('由你根据气氛决定，不要一直等主人明确要求');
    expect(CONTEXT_SOURCE).toContain('high=经常在合适时主动使用');
    expect(CONTEXT_SOURCE).toContain('medium=每隔几轮遇到自然机会就主动使用');
    expect(CONTEXT_SOURCE).toContain('low=只在明显合适时偶尔主动使用');
  });

  it('no longer teaches image / video / voice markers, because those are tools now', () => {
    expect(CONTEXT_SOURCE).not.toContain('[[image');
    expect(CONTEXT_SOURCE).not.toContain('[[voice');
    expect(CONTEXT_SOURCE).not.toContain('[[video');
    expect(CONTEXT_SOURCE).toContain('send_image / send_video / send_voice');
  });

  it('makes a user request mandatory for the user, and hands the tool only that job', () => {
    expect(CONTEXT_SOURCE).toContain('主人明确要求时仍必须照做');
    expect(MEDIA_TOOLS_SOURCE).toContain('主人明确要的时候才用；他自己没提就不要主动加。');
  });
});
