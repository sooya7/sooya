import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const serverSrc = path.join(repo, 'packages/server/src');

function read(rel: string): string {
  return fs.readFileSync(path.join(repo, rel), 'utf8');
}

describe('QQ single-channel production surface', () => {
  it('does not ship legacy Web chat/user route modules', () => {
    for (const name of ['chat.ts', 'stream.ts', 'voice.ts', 'moments.ts', 'thoughts.ts']) {
      expect(fs.existsSync(path.join(serverSrc, 'routes', name)), name).toBe(false);
    }
  });

  it('registers QQ/Admin routes only and never reintroduces WEB_CHAT_TOKEN', () => {
    const app = read('packages/server/src/app.ts');
    const env = read('packages/server/src/config/env.ts');
    const example = read('.env.example');

    expect(app).not.toMatch(/register(?:Chat|Stream|Voice|Moment|Thought)Routes/u);
    expect(app).not.toContain('x-sooya-token');
    expect(env).not.toContain('WEB_CHAT_TOKEN');
    expect(example).not.toContain('WEB_CHAT_TOKEN');
  });

  it('makes HTTP media access admin-only and removes the Web upload endpoint', () => {
    const media = read('packages/server/src/routes/media.ts');
    expect(media).toContain("import { requireAdminToken } from './auth.js';");
    expect(media).toContain('const auth = requireAdminToken(app);');
    expect(media).not.toContain("server.post('/api/media'");
    expect(media).toContain("server.get('/api/media/:id'");
  });

  it('keeps the browser client free of legacy chat API calls', () => {
    const api = read('packages/web/src/lib/api.ts');
    for (const legacy of ['/api/messages', '/api/stream', '/api/events', '/api/moments', '/api/thoughts']) {
      expect(api).not.toContain(legacy);
    }
  });
});
