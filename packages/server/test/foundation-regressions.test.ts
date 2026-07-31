import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config/store.js';
import { createHarness, sendText, type Harness } from './helpers/harness.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
let harness: Harness | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
  for (const dir of tempDirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function executableLines(script: string): string {
  return script
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('#');
    })
    .join('\n');
}

describe('management panel configuration ownership', () => {
  it('keeps panel-saved model settings active immediately and after restart', () => {
    const configDir = tempDir('sooya-panel-config-');
    const env = {
      SOOYA_CHAT_PROVIDER: 'openai-chat',
      SOOYA_CHAT_BASE_URL: 'https://old-env.example/v1',
      SOOYA_CHAT_MODEL: 'old-env-model',
      SOOYA_CHAT_API_KEY: 'sk-env-secret-not-for-disk'
    } as NodeJS.ProcessEnv;

    const first = new ConfigStore({ configDir, env });
    expect(first.getModels().chat.model).toBe('old-env-model');

    first.setModels({
      chat: {
        provider: 'openai-compatible',
        baseUrl: 'https://panel.example/v1',
        model: 'panel-model',
        temperature: 0.35
      }
    });

    expect(first.getModels().chat.provider).toBe('openai-compatible');
    expect(first.getModels().chat.baseUrl).toBe('https://panel.example/v1');
    expect(first.getModels().chat.model).toBe('panel-model');
    expect(first.getModels().chat.temperature).toBe(0.35);
    expect(first.getModels().chat.apiKey).toBe('sk-env-secret-not-for-disk');
    expect(first.getModels().chat.configSource).toBe('panel');

    const onDiskText = fs.readFileSync(path.join(configDir, 'models.json'), 'utf8');
    const onDisk = JSON.parse(onDiskText) as { chat: Record<string, unknown> };
    expect(onDisk.chat.configSource).toBe('panel');
    expect(onDisk.chat.model).toBe('panel-model');
    expect(onDiskText).not.toContain('sk-env-secret-not-for-disk');

    const restarted = new ConfigStore({ configDir, env });
    expect(restarted.getModels().chat.provider).toBe('openai-compatible');
    expect(restarted.getModels().chat.baseUrl).toBe('https://panel.example/v1');
    expect(restarted.getModels().chat.model).toBe('panel-model');
    expect(restarted.getModels().chat.apiKey).toBe('sk-env-secret-not-for-disk');
  });
});

describe('chat clearing and event delivery', () => {
  it('orders connected clients to fully reload after chat history is cleared', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' }, chat: { script: [['回复']] } });
    await sendText(harness.app, '先留一条消息', 'clear-before');
    expect(harness.app.repos.messages.count()).toBeGreaterThan(0);

    const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = harness.app.services.bus.subscribe((event) => seen.push({ type: event.type, payload: event.payload }));
    const response = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/chat/clear',
      headers: { 'x-admin-token': 'admin-test-token' }
    });
    unsubscribe();

    expect(response.statusCode).toBe(200);
    expect(harness.app.repos.messages.count()).toBe(0);
    const notice = seen.find((event) => event.type === 'system.notice');
    expect(notice).toBeTruthy();
    expect(notice?.payload.action).toBe('reload');
    expect(notice?.payload.reason).toBe('chat-cleared');
    expect(notice?.payload.lastMessageSeq).toBe(0);
  });

  it('does not lose an event published between durable replay and live delivery', async () => {
    harness = await createHarness();
    const bus = harness.app.services.bus;
    const originalReplay = bus.replay.bind(bus);
    const cursor = bus.lastSeq();
    let injected = false;

    bus.replay = ((seq: number, limit?: number) => {
      const rows = originalReplay(seq, limit);
      if (!injected) {
        injected = true;
        bus.publish('system.notice', { notice: 'event-created-inside-replay-window' });
      }
      return rows;
    }) as typeof bus.replay;

    const address = await harness.app.server.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    let body = '';

    try {
      const response = await fetch(`${address}/api/stream?lastEventId=${cursor}`, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.body).toBeTruthy();
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      while (!body.includes('event-created-inside-replay-window')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
      bus.replay = originalReplay;
    }

    expect(injected).toBe(true);
    expect(body).toContain('event-created-inside-replay-window');
  });
});

describe('deployment safety regressions', () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
  const backup = fs.readFileSync(path.join(REPO_ROOT, 'deploy/backup.sh'), 'utf8');
  const upgrade = fs.readFileSync(path.join(REPO_ROOT, 'deploy/upgrade.sh'), 'utf8');
  const restore = fs.readFileSync(path.join(REPO_ROOT, 'deploy/restore-backup.sh'), 'utf8');

  it('normalizes workspace production dependencies and verifies better-sqlite3 in the image', () => {
    expect(dockerfile).toMatch(/AS prod-deps/);
    expect(dockerfile).toMatch(/--workspaces --include-workspace-root/);
    expect(dockerfile).toMatch(/COPY --from=prod-deps \/prod\/node_modules/);
    expect(dockerfile).toMatch(/packages\/server\/node_modules/);
    expect(dockerfile).toMatch(/better-sqlite3 production dependency verified/);
    expect(dockerfile).toMatch(/better-sqlite3 available in final image/);
  });

  it('never executes a raw live SQLite database copy as a backup fallback', () => {
    const code = executableLines(backup);
    expect(code).toMatch(/\.backup/);
    expect(code).toMatch(/VACUUM INTO/);
    expect(code).toMatch(/db\.backup/);
    expect(code).toMatch(/refusing an unsafe live-file copy/);
    expect(code).not.toMatch(/for suffix in "" "-wal" "-shm"/);
    expect(code).not.toMatch(/cp -p "\$\{DB\}\$\{suffix\}"/);
  });

  it('uses the verified backup helper before an upgrade and avoids workspace prune', () => {
    const code = executableLines(upgrade);
    expect(code).toMatch(/deploy\/backup\.sh/);
    expect(code).toMatch(/pre-upgrade backup failed; upgrade was not started/);
    expect(code).not.toMatch(/for suffix in "" "-wal" "-shm"/);
    expect(code).not.toMatch(/npm prune --omit=dev/);
    expect(code).toMatch(/npm ci --omit=dev --build-from-source=better-sqlite3/);
  });

  /*
   * The 2026-07-31 outage: a release with a broken native module became `current`,
   * and the app mistook "cannot load the module" for "the database is corrupt".
   * The gate must run as the service user and must actually open a database, and
   * it must sit BEFORE the symlink switch, otherwise it protects nothing.
   */
  it('proves the release can open a sqlite database before making it current', () => {
    const code = executableLines(upgrade);
    expect(code).toMatch(/sudo -u "\$SERVICE_USER"[^\n]*"\$NODE_BIN"/);
    expect(code).toMatch(/CREATE TABLE probe/);
    expect(code).toMatch(/integrity_check/);
    expect(code).toMatch(/not switching, the current release keeps serving/);
    const gate = code.indexOf('CREATE TABLE probe');
    const flip = code.indexOf('mv -Tf "$BASE_DIR/current.new" "$BASE_DIR/current"');
    expect(gate).toBeGreaterThan(-1);
    expect(flip).toBeGreaterThan(gate);
  });

  it('verifies a restore before stopping the service and rolls back unhealthy restores', () => {
    expect(restore).toMatch(/checking backup database integrity before stopping SOOYA/);
    expect(restore).toMatch(/integrity_check/);
    expect(restore).toMatch(/rollback_previous_state/);
    expect(restore).toMatch(/automatic rollback succeeded/);
    expect(restore).toMatch(/\$SHARED_DIR\/config.*\$SAFETY\/config/);
  });

  it('keeps every deployment script syntactically valid', () => {
    for (const name of ['backup.sh', 'upgrade.sh', 'restore-backup.sh', 'docker-entrypoint.sh']) {
      expect(() => execFileSync('bash', ['-n', path.join(REPO_ROOT, 'deploy', name)])).not.toThrow();
    }
  });
});
