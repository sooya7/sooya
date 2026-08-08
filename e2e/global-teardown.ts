import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async function globalTeardown(): Promise<void> {
  const pidFile = path.join(os.tmpdir(), 'sooya-e2e-pids.json');
  if (!fs.existsSync(pidFile)) return;
  const { mock, server, dataRoot, serverLogPath } = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as {
    mock?: number;
    server?: number;
    dataRoot?: string;
    serverLogPath?: string;
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
  // A green suite must not silently swallow a process-level crash: any
  // unhandled rejection / uncaught exception the server logged makes the
  // run fail, so regressions surface instead of hiding behind a pass.
  if (serverLogPath && fs.existsSync(serverLogPath)) {
    const log = fs.readFileSync(serverLogPath, 'utf8');
    const crash = log.match(/"msg":"unhandled rejection"|"msg":"uncaught exception"/);
    if (crash) {
      throw new Error(`server crashed during e2e run (${crash[0]}); see ${serverLogPath}`);
    }
  }
  if (dataRoot && process.env.E2E_KEEP_DATA !== '1') {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
  fs.rmSync(pidFile, { force: true });
}
