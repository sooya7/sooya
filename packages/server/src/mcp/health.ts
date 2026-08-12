import type { McpConnectionSnapshot } from './types.js';

export function memoryHealth(snapshots: McpConnectionSnapshot[], serverId = 'ombre'): {
  backend: 'ombre'; configured: boolean; connected: boolean; degraded: boolean; toolCount: number; lastError?: string;
} {
  const snapshot = snapshots.find((item) => item.id === serverId);
  return {
    backend: 'ombre',
    configured: snapshot?.enabled === true,
    connected: snapshot?.state === 'ready',
    degraded: snapshot !== undefined && snapshot.state !== 'ready',
    toolCount: snapshot?.toolCount ?? 0,
    ...(snapshot?.lastError ? { lastError: snapshot.lastError } : {})
  };
}
