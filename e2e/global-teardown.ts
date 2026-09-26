import fs from 'node:fs';
import { PID_FILE, killQuietly, type E2eRuntime } from './server.js';

export default async function globalTeardown(): Promise<void> {
  if (!fs.existsSync(PID_FILE)) return;
  // The server pid is rewritten when a spec restarts the server, so this always
  // stops the process that is actually running now.
  const { mock, server, dataRoot, serverLogPath } = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')) as Partial<E2eRuntime>;
  for (const pid of [server, mock]) killQuietly(pid, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  for (const pid of [server, mock]) killQuietly(pid, 'SIGKILL');
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
  fs.rmSync(PID_FILE, { force: true });
}
