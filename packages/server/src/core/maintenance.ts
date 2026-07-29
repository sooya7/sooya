export interface MaintenanceState {
  operation: string;
  startedAt: string;
  blocksWrites: boolean;
}

/**
 * Process-wide exclusive lock for backup, restore and destructive storage work.
 * Backup creation is mutually exclusive with cleanup/restore but does not block
 * normal chat writes because SQLite's online backup API is safe under writes.
 */
export class MaintenanceCoordinator {
  private current: MaintenanceState | null = null;

  state(): MaintenanceState | null {
    return this.current ? { ...this.current } : null;
  }

  isWriteBlocked(): boolean {
    return this.current?.blocksWrites === true;
  }

  begin(operation: string, options: { blocksWrites?: boolean } = {}): () => void {
    if (this.current) {
      const error = new Error(`maintenance operation already running: ${this.current.operation}`) as Error & { code?: string };
      error.code = 'MAINTENANCE_BUSY';
      throw error;
    }
    const state: MaintenanceState = {
      operation,
      startedAt: new Date().toISOString(),
      blocksWrites: options.blocksWrites === true
    };
    this.current = state;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.current === state) this.current = null;
    };
  }

  async run<T>(operation: string, work: () => Promise<T>, options: { blocksWrites?: boolean } = {}): Promise<T> {
    const release = this.begin(operation, options);
    try {
      return await work();
    } finally {
      release();
    }
  }
}
