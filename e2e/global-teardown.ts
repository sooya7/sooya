import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async function globalTeardown(): Promise<void> {
  const pidFile = path.join(os.tmpdir(), 'sooya-e2e-pids.json');
  if (!fs.existsSync(pidFile)) return;
  const { mock, server, dataRoot } = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as {
    mock?: number;
    server?: number;
    dataRoot?: string;
  };
  for (const pid of [server, mock]) {
    if (!pid) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 800));
  for (const pid of [server, mock]) {
    if (!pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* fine */
    }
  }
  if (dataRoot && process.env.E2E_KEEP_DATA !== '1') {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
  fs.rmSync(pidFile, { force: true });
}
