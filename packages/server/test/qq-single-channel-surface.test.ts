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
    const features = read('packages/server/src/routes/features.ts');
    expect(features).toContain("server.post('/api/admin/media', adminGuard");
  });

  it('keeps the browser client free of legacy chat API calls', () => {
    const api = read('packages/web/src/lib/api.ts');
    for (const legacy of ['/api/messages', '/api/stream', '/api/events', '/api/moments', '/api/thoughts']) {
      expect(api).not.toContain(legacy);
    }
  });

  /*
   * The surface guard above covered env.ts and .env.example but not the README,
   * which is why the README kept advertising Web chat, SSE and PWA long after
   * they were deleted — and, worse, kept telling public deployments to set
   * WEB_CHAT_TOKEN, a variable that no longer exists. A stale README that hands
   * out a security instruction which silently does nothing is a defect, so it
   * gets the same structural guard as the code.
   */
  it('keeps the README consistent with the single-channel product', () => {
    const readme = read('README.md');
    // Only allowed as part of the explicit "this was removed" note.
    const mentions = readme.split('\n').filter((line) => line.includes('WEB_CHAT_TOKEN'));
    for (const line of mentions) {
      expect(line, 'WEB_CHAT_TOKEN may only appear in the removal note').toMatch(/已.*删除|removed/u);
    }
    expect(readme, 'README must not instruct operators to set WEB_CHAT_TOKEN').not.toMatch(
      /^\s*WEB_CHAT_TOKEN\s*=/mu
    );
    // The README must name the actual chat channel; a reader cannot otherwise
    // discover that a QQ bot is required to use the product at all.
    expect(readme).toMatch(/QQ_BOT_ENABLED/u);
    expect(readme).toMatch(/QQ_CALLBACK_SECRET/u);
    expect(readme).toMatch(/api\/qq\/callback/u);
  });

  it('leaves no deploy script writing the removed chat token', () => {
    const deploy = read('scripts/test-deploy.sh');
    expect(deploy).not.toMatch(/^\s*sed -i .*WEB_CHAT_TOKEN/mu);
  });
});
